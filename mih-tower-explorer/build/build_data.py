#!/usr/bin/env python3
"""
Build the explorer's web data from the MIH Tower vector PDFs.

  python3 build/build_data.py            # everything -> web/data/
  python3 build/build_data.py rooms      # room segmentation only (+ QA images)
  python3 build/build_data.py images     # overview images + detail tiles only

Reuses the registration and layer rasteriser from ../hospital-motion-loop/prep.py
(run that project's prep.py and assets.py first; they fill its .cache/).

Geometry is in canonical sheet points (the Level 2 sheet), y down.
Drawing scale: 1/16" = 1'-0"  ->  4.5 pt per foot (checked against 11" stair
treads at 4.12-4.13 pt and the 31'-0" column bays at 139.5 pt).
"""
import os, re, sys, json, math, collections
import numpy as np
import cv2
import pymupdf as fitz
from skimage.segmentation import watershed

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MOTION = os.path.join(os.path.dirname(ROOT), 'hospital-motion-loop')
sys.path.insert(0, MOTION)
import prep                                     # noqa: E402
import assets                                   # noqa: E402

CACHE = os.path.join(MOTION, '.cache')
OUT = os.path.join(ROOT, 'web', 'data')
QA = os.path.join(ROOT, 'build', 'qa')
PT_PER_FT = 4.5
CAN_W, CAN_H = prep.CAN_W, prep.CAN_H
KR = 2.0                                        # room segmentation raster, px per pt
CAP_PT = 11.0                                   # distance-field cap for the watershed

LEVELS = {
    1: dict(code='01', name='LEVEL 01', sub='EMERGENCY DEPARTMENT · MAIN LOBBY'),
    2: dict(code='02', name='LEVEL 02', sub='LABOR & DELIVERY · NICU · POSTPARTUM'),
    3: dict(code='03', name='LEVEL 03', sub='PATIENT CARE · ICU'),
    4: dict(code='PH', name='PENTHOUSE', sub='MECHANICAL · ELECTRICAL · PLUMBING'),
}
TAG_RE = re.compile(r'^T\d[0-9A-Z.]*$')
GRID_BLUE = 0x46A0FF


def page_of(n):
    path = prep.find_pdf(n)
    return path, fitz.open(path)[0]


def offset_of(n):
    z = np.load(os.path.join(CACHE, f'L{n}.npz'), allow_pickle=True)
    return tuple(float(v) for v in z['off'])


# --------------------------------------------------------------------------- column grid
def column_grid():
    """Main orthogonal column grid, read from the bubbles on the Level 2 sheet:
    numbered columns across the top, lettered rows down the right edge."""
    _, page = page_of(2)
    ox, oy = offset_of(2)
    cols, rows = {}, {}
    for b in page.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            for sp in l['spans']:
                t = sp['text'].strip()
                if sp['color'] != GRID_BLUE or not t:
                    continue
                x0, y0, x1, y1 = sp['bbox']
                cx, cy = (x0 + x1) / 2 + ox, (y0 + y1) / 2 + oy
                if re.fullmatch(r'\d+(\.\d+)?', t) and (abs(cy - 227.1) < 4 or cy < 5):
                    cols[t] = round(cx, 1)
                elif re.fullmatch(r'[A-G](\.\d)?', t) and cx > 1900:
                    rows[t] = round(cy, 1)
    return dict(cols=[dict(pos=v, label=k) for k, v in sorted(cols.items(), key=lambda kv: kv[1])],
                rows=[dict(pos=v, label=k) for k, v in sorted(rows.items(), key=lambda kv: kv[1])])


def grid_ref(grid, x, y):
    """'C–D / 7–8' style location on the main grid; None outside it."""
    def between(lines, v, natural):
        pos = [g['pos'] for g in lines]
        lab = [g['label'] for g in lines]
        if v < pos[0] - 25 or v > pos[-1] + 25:
            return None
        for i, p in enumerate(pos):
            if abs(v - p) < 2.5:
                return lab[i]
        if v < pos[0] or v > pos[-1]:
            return (lab[0] if v < pos[0] else lab[-1]) + '±'
        i = max(j for j in range(len(pos)) if pos[j] <= v)
        pair = sorted([lab[i], lab[i + 1]], key=natural)
        return f'{pair[0]}–{pair[1]}'
    num = lambda t: float(t)
    let = lambda t: t
    r = between(grid['rows'], y, let)
    c = between(grid['cols'], x, num)
    if r is None or c is None:
        return None
    return f'{r} / {c}'


# --------------------------------------------------------------------------- room labels
EXTERIOR_RX = re.compile(r'BELOW|CANOPY|OPEN TO|^ROOF$|^PLAZA|^DROP.?OFF')


def text_spans(n):
    """Small black annotation spans (room names, tags, notes) in canonical pt,
    with their text direction so rotated wings pair correctly."""
    _, page = page_of(n)
    ox, oy = offset_of(n)
    out = []
    for b in page.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            dx, dy = l.get('dir', (1.0, 0.0))
            for s in l['spans']:
                t = s['text'].strip()
                if not t or s['color'] != 0 or s['size'] > 10:
                    continue
                x0, y0, x1, y1 = s['bbox']
                out.append(dict(t=t, x0=x0 + ox, y0=y0 + oy, x1=x1 + ox, y1=y1 + oy, size=s['size'],
                                cx=(x0 + x1) / 2 + ox, cy=(y0 + y1) / 2 + oy, dx=dx, dy=dy))
    return out


def room_labels(n):
    """Room tags (T####) paired with the name lines stacked above them."""
    spans = text_spans(n)
    notes = [s for s in spans if s['size'] > 7.5]
    spans = [s for s in spans if s['size'] <= 7.5]
    tags = [s for s in spans if TAG_RE.match(s['t'])]
    others = [s for s in spans if not TAG_RE.match(s['t'])]
    used = set()
    labels = []
    for tg in tags:
        eu = np.array([tg['dx'], tg['dy']]); ev = np.array([-tg['dy'], tg['dx']])
        cur, lines = tg, []
        for step in range(5):
            lo, hi = (-14.5, -4.0) if step == 0 else (-10.5, -5.0)
            best, bscore = None, 1e9
            for o in others:
                if id(o) in used:
                    continue
                d = np.array([o['cx'] - cur['cx'], o['cy'] - cur['cy']])
                du, dv = float(d @ eu), float(d @ ev)
                if lo <= dv <= hi and abs(du) < 9 and abs(o['dx'] - tg['dx']) < 0.05:
                    sc = abs(du) + 0.2 * abs(dv)
                    if sc < bscore:
                        best, bscore = o, sc
            if best is None:
                break
            used.add(id(best))
            lines.insert(0, best)
            cur = best
        name = ' '.join(o['t'] for o in lines)
        name = re.sub(r'\s*/\s*$', '', name).replace(' / ', '/').strip()
        xs = [tg['x0'], tg['x1']] + [v for o in lines for v in (o['x0'], o['x1'])]
        ys = [tg['y0'], tg['y1']] + [v for o in lines for v in (o['y0'], o['y1'])]
        labels.append(dict(tag=tg['t'], name=name, box=(min(xs), min(ys), max(xs), max(ys))))
    exterior = [(o['cx'], o['cy']) for o in others + notes if id(o) not in used and EXTERIOR_RX.search(o['t'])]
    return labels, exterior


# --------------------------------------------------------------------------- wall barrier
def barrier_mask(n, k=KR):
    """Walls: black strokes >= 0.28 pt (cut walls, door leaves, frames) and the
    grey wall poche, in painter's order (white wipeouts erase)."""
    _, page = page_of(n)
    ox, oy = offset_of(n)
    Wp, Hp = int(round(CAN_W * k)), int(round(CAN_H * k))
    m = np.zeros((Hp, Wp), np.uint8)
    S = 16.0

    def P(p):
        return (int(round((p.x + ox) * k * S)), int(round((p.y + oy) * k * S)))

    def ring(items):
        pts = []
        for it in items:
            if it[0] == 'l':
                if not pts: pts.append(P(it[1]))
                pts.append(P(it[2]))
            elif it[0] == 're':
                r = it[1]; pts += [P(r.tl), P(r.tr), P(r.br), P(r.bl)]
            elif it[0] == 'qu':
                q = it[1]; pts += [P(q.ul), P(q.ur), P(q.lr), P(q.ll)]
            elif it[0] == 'c':
                pts += [P(it[1]), P(it[4])]
        return np.array(pts, np.int32) if len(pts) >= 3 else None

    for d in page.get_drawings():
        typ = d.get('type', 's')
        f = d.get('fill')
        if 'f' in typ and f is not None:
            r = ring(d['items'])
            if r is not None:
                if min(f) > 0.97:
                    cv2.fillPoly(m, [r], 0, cv2.LINE_8, 4)
                elif max(f) - min(f) < 0.05 and 0.3 < max(f) < 0.9:
                    rp = r.astype(np.float64) / (k * S)
                    area = abs(cv2.contourArea(rp.astype(np.float32)))
                    per = cv2.arcLength(rp.astype(np.float32), True)
                    if per > 0 and 2 * area / per < 4.0:          # wall poche is thin; big tones are not walls
                        cv2.fillPoly(m, [r], 255, cv2.LINE_8, 4)
        c = d.get('color')
        w = d.get('width') or 0.0
        if 's' not in typ or c is None or max(c) > 0.15 or not (0.28 <= w < 3.0):
            continue
        th = max(1, int(round(w * k)))
        for it in d['items']:
            if it[0] == 'l':
                cv2.line(m, P(it[1]), P(it[2]), 255, th, cv2.LINE_8, 4)
            elif it[0] == 're':
                r = it[1]
                cv2.polylines(m, [np.array([P(r.tl), P(r.tr), P(r.br), P(r.bl)], np.int32)], True, 255, th, cv2.LINE_8, 4)
            elif it[0] == 'qu':
                q = it[1]
                cv2.polylines(m, [np.array([P(q.ul), P(q.ur), P(q.lr), P(q.ll)], np.int32)], True, 255, th, cv2.LINE_8, 4)
            elif it[0] == 'c':
                t = np.linspace(0, 1, 10)[:, None]
                A = [np.array([q.x + ox, q.y + oy]) for q in it[1:5]]
                cc = ((1 - t) ** 3) * A[0] + 3 * ((1 - t) ** 2) * t * A[1] + 3 * (1 - t) * t * t * A[2] + t ** 3 * A[3]
                cv2.polylines(m, [np.round(cc * k * S).astype(np.int32)], False, 255, th, cv2.LINE_8, 4)
    return m


def footprint_k(n, k=KR):
    d = np.load(os.path.join(CACHE, 'derived.npz'))
    fp = d[f'fp{n}'] if n != 4 else np.maximum(d['fp3'], d['fp4'])
    fp = cv2.resize(fp.astype(np.float32), (int(round(CAN_W * k)), int(round(CAN_H * k))), interpolation=cv2.INTER_LINEAR)
    return (fp > 0.5).astype(np.uint8)


# --------------------------------------------------------------------------- segmentation
def segment_rooms(n, k=KR):
    """Marker watershed on the distance-to-wall field: rooms flood from their
    labels and split at door openings (the narrow necks).  The exterior floods
    from outside the building and from ROOF/CANOPY BELOW notes, so rooms stop at
    storefronts instead of leaking out."""
    labels, exterior = room_labels(n)
    bar = barrier_mask(n, k)
    bar = cv2.dilate(bar, np.ones((3, 3), np.uint8))           # seal hairline gaps
    fp = footprint_k(n, k)
    free = bar == 0
    tags = sorted({l['tag'] for l in labels})
    tid = {t: i + 1 for i, t in enumerate(tags)}
    EXT = len(tags) + 1
    markers = np.zeros(free.shape, np.int32)
    far = cv2.dilate(fp, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (int(40 * k) | 1, int(40 * k) | 1)))
    markers[(far == 0) & free] = EXT
    for (x, y) in exterior:
        cv2.circle(markers, (int(x * k), int(y * k)), int(3 * k), EXT, -1)
    dt = cv2.distanceTransform(free.astype(np.uint8), cv2.DIST_L2, 5)
    seeds = collections.defaultdict(list)
    for l in labels:
        x0, y0, x1, y1 = l['box']
        px, py = int((x0 + x1) / 2 * k), int((y0 + y1) / 2 * k)
        r = int(12 * k)                     # seed in open floor near the label, not in a sliver
        X0, Y0 = max(0, px - r), max(0, py - r)
        win = dt[Y0:py + r + 1, X0:px + r + 1]
        yy, xx = np.mgrid[Y0:Y0 + win.shape[0], X0:X0 + win.shape[1]]
        # stay on the label's side of any wall: only the free component nearest the label
        ncomp, comp = cv2.connectedComponents((win > 0).astype(np.uint8), connectivity=4)
        fy, fx = np.nonzero(win > 0)
        if len(fy) == 0:
            continue
        j0 = np.argmin((fx + X0 - px) ** 2 + (fy + Y0 - py) ** 2)
        home = comp[fy[j0], fx[j0]]
        score = np.minimum(win, CAP_PT * k) - 0.35 * np.hypot(xx - px, yy - py)
        score[(win <= 0) | (comp != home)] = -1e9
        j = np.argmax(score)
        if score.flat[j] < -1e8:
            continue
        sy, sx = np.unravel_index(j, win.shape)
        sx, sy = X0 + sx, Y0 + sy
        cv2.circle(markers, (int(sx), int(sy)), 2, tid[l['tag']], -1)
        seeds[l['tag']].append((sx / k, sy / k))
    markers[~free] = 0
    # Door openings (half-width 6-9 pt) stay ridges; anything more open than CAP_PT
    # is a plateau, so several labels in one open area split it fairly.
    ws = watershed(-np.minimum(dt, CAP_PT * k), markers, mask=free)
    ws[ws == EXT] = 0
    return labels, tags, tid, ws, bar, fp, seeds


def polygons_of(mask, k=KR, eps=1.0, min_area_px=30):
    cnts, hier = cv2.findContours(mask.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    polys = []
    if hier is None:
        return polys
    hier = hier[0]
    for i, c in enumerate(cnts):
        if hier[i][3] != -1 or cv2.contourArea(c) < min_area_px:
            continue
        outer = cv2.approxPolyDP(c, eps, True)[:, 0, :]
        holes = []
        j = hier[i][2]
        while j != -1:
            if cv2.contourArea(cnts[j]) >= min_area_px:
                holes.append(cv2.approxPolyDP(cnts[j], eps, True)[:, 0, :])
            j = hier[j][0]
        to_pt = lambda a: np.round((a.astype(np.float64) + 0.5) / k, 2)
        polys.append(dict(outer=to_pt(outer), holes=[to_pt(h) for h in holes]))
    return polys


def triangulate(poly):
    import mapbox_earcut as earcut
    rings = [poly['outer']] + poly['holes']
    verts = np.concatenate(rings).astype(np.float32)
    ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    idx = earcut.triangulate_float32(verts, ends)
    return verts, idx


ABBR = [
    (r'LDRP\(ISO\)', 'LDRP (ISOLATION)'), (r'\(ISO\)', '(ISOLATION)'), (r'\(ISO,', '(ISOLATION,'),
    (r'\bTLT\b', 'TOILET'), (r'\bPAT\b', 'PATIENT'), (r'\bRM\b', 'ROOM'), (r'\bCORR\.?(?=\s|$)', 'CORRIDOR'),
    (r'\bEQPT\b', 'EQUIPMENT'), (r'\bEQUIP\.?(?=\s|$)', 'EQUIPMENT'), (r'\bELEC\.?(?=\s|$)', 'ELECTRICAL'),
    (r'\bSTOR\.?(?=\s|$)', 'STORAGE'), (r'\bOBSERV\.?(?=\s|$)', 'OBSERVATION'), (r'\bCONF\.?(?=\s|$)', 'CONFERENCE'),
    (r'\bMGR\b', 'MANAGER'), (r'\bELEV\b', 'ELEVATOR'), (r'\bVEST\.?(?=\s|$)', 'VESTIBULE'),
    (r'\bC-SECT\b', 'C-SECTION'), (r'\bNOUR\.?(?=\s|$)', 'NOURISHMENT'), (r'\bNOURISH\b', 'NOURISHMENT'),
    (r'\bRESP\.?(?=\s|$)', 'RESPIRATORY'), (r'\bPHYS\.?(?=\s|$)', 'PHYSICIAN'), (r'\bDOCU\.?(?=\s|$)', 'DOCUMENTATION'),
    (r'\bSTF\b', 'STAFF'), (r'\bREG\b', 'REGISTRATION'), (r'\bAMB\.?(?=\s|$)', 'AMBULANCE'),
    (r'\bANEST\b', 'ANESTHESIA'), (r'\bMANAGMENT\b', 'MANAGEMENT'), (r'\bBEHAVIORIAL\b', 'BEHAVIORAL'),
    (r'\bICU PATIENT ROOM\b', 'ICU PATIENT ROOM'),
]


def display_name(name, tag):
    if not name:
        return tag
    s = name
    for rx, rep in ABBR:
        s = re.sub(rx, rep, s)
    s = re.sub(r'\s+', ' ', s).strip()
    s = re.sub(r'\bCHECK-IN/ REGISTRATION', 'CHECK-IN / REGISTRATION', s)
    return s


def space_type(name):
    """Space category used for the reference design criteria in the app."""
    s = ' ' + name.upper() + ' '
    rules = [
        ('aii', r'\(ISO|\bISO\b|ISOLATION|\bAII\b'),
        ('nicu', r'\bNICU\b|NEWBORN INTENSIVE'),
        ('icu', r'\bICU\b|INTENSIVE CARE|CRITICAL CARE'),
        ('csection', r'C-?SECT|CAESAREAN|CESAREAN'),
        ('ldr', r'\bLDRP?\b|LABOR'),
        ('trauma', r'TRAUMA'),
        ('triage', r'TRIAGE'),
        ('edwait', r'\bED WAIT'),
        ('decon', r'DECON'),
        ('xray', r'X-?RAY|\bCT\b|\bCT ROOM|IMAGING|RADIOLOGY'),
        ('recovery', r'RECOVERY|\bPACU\b'),
        ('exam', r'EXAM|FAST TRACK|TREATMENT|\bRESUS|\bOBSERV'),
        ('patient', r'POSTPARTUM|ANTEPARTUM|\bPAT\b|PATIENT RM|BARIATRIC\b(?! TLT)'),
        ('toilet', r'\bTLT\b|TOILET|RESTROOM|\bWOMEN\b|\bMEN\b|SHOWER|\bWC\b'),
        ('soiled', r'SOILED'),
        ('meds', r'\bMEDS?\b(?!.*GAS)|MEDICATION'),
        ('clean', r'CLEAN'),
        ('evs', r'\bEVS\b|JANITOR|\bJAN\b|HOUSEKEEP'),
        ('nourish', r'NOURISH'),
        ('mep', r'ELEC|\bMECH|EQPT|HEATERS|\bRO\b|\bIDF\b|\bMDF\b|\bTEL|DATA|SHAFT|\bGAS\b|PENTHOUSE'),
        ('vertical', r'STAIR|ELEVATOR|\bELEV\b'),
        ('corridor', r'CORR|HALLWAY|\bHALL\b|VESTIBULE|LOBBY|ANTEROOM|ALCOVE'),
    ]
    for key, rx in rules:
        if re.search(rx, s):
            return key
    return 'general'


def rooms_for_level(n, grid, qa=True):
    labels, tags, tid, ws, bar, fp, seeds = segment_rooms(n)
    by_tag = collections.defaultdict(list)
    for l in labels:
        by_tag[l['tag']].append(l)
    rooms = []
    k = KR
    disk = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))
    for t in tags:
        m = ws == tid[t]
        if m.sum() < 40:
            continue
        # trim slivers (wall cavities, chases) that leaked in: open, keep the part with
        # the label, then grow back so real corners are not rounded
        x0b, y0b, wb, hb = cv2.boundingRect(m.astype(np.uint8))
        X0, Y0 = max(0, x0b - 8), max(0, y0b - 8)
        sub = m[Y0:y0b + hb + 8, X0:x0b + wb + 8].astype(np.uint8)
        core = cv2.morphologyEx(sub, cv2.MORPH_OPEN, disk)
        nc, cl = cv2.connectedComponents(core, connectivity=8)
        if nc > 1:
            keep = np.zeros_like(core)
            for sx, sy in seeds[t]:
                c = cl[min(cl.shape[0] - 1, max(0, int(sy * k) - Y0)), min(cl.shape[1] - 1, max(0, int(sx * k) - X0))]
                if c > 0:
                    keep |= (cl == c).astype(np.uint8)
            if keep.sum() == 0:
                sizes = np.bincount(cl.ravel()); sizes[0] = 0
                keep = (cl == sizes.argmax()).astype(np.uint8)
            sub = sub & cv2.dilate(keep, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13)))
        # fill small holes left by equipment outlines inside the room
        cnts, hier = cv2.findContours(sub.copy(), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
        if hier is not None:
            for c, h in zip(cnts, hier[0]):
                if h[3] != -1 and cv2.contourArea(c) < 30 * PT_PER_FT ** 2 * k * k:
                    cv2.drawContours(sub, [c], -1, 1, -1)
        m = np.zeros_like(m)
        m[Y0:Y0 + sub.shape[0], X0:X0 + sub.shape[1]] = sub > 0
        ws[(ws == tid[t]) & ~m] = 0
        ws[m & (ws == 0)] = tid[t]
        area_px = int(m.sum())
        if area_px < 40:
            continue
        polys = polygons_of(m)
        if not polys:
            continue
        name = max((l['name'] for l in by_tag[t]), key=len) or t
        tri_v, tri_i = [], []
        base = 0
        for p in polys:
            v, idx = triangulate(p)
            tri_v.append(v); tri_i.append(idx + base); base += len(v)
        V = np.concatenate(tri_v); I = np.concatenate(tri_i)
        area_ft2 = area_px / (KR * KR) / (PT_PER_FT ** 2)
        big = max(polys, key=lambda p: cv2.contourArea(p['outer'].astype(np.float32)))
        (rcx, rcy), (rw, rh), _ = cv2.minAreaRect(big['outer'].astype(np.float32))
        L, Wd = max(rw, rh) / PT_PER_FT, min(rw, rh) / PT_PER_FT
        ys, xs = np.nonzero(m)
        bbox = (xs.min() / KR, ys.min() / KR, (xs.max() + 1) / KR, (ys.max() + 1) / KR)
        # label anchor = first seed, in pt
        sx, sy = seeds[t][0] if seeds[t] else ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)
        ring = m & ~cv2.erode(m.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
        others = cv2.dilate(((ws > 0) & ~m).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
        shared = float((ring & others).sum()) / max(1, int(ring.sum()))   # boundary drawn by the split, not a wall
        rooms.append(dict(
            tag=t, name=display_name(name, t), drawn=name, level=n, type=space_type(name),
            open=shared > 0.22,
            area=round(area_ft2),
            dims=[round(L, 1), round(Wd, 1)] if area_px / (KR * KR) > 0.82 * rw * rh else None,
            anchor=[round(sx, 1), round(sy, 1)],
            bbox=[round(v, 1) for v in bbox],
            grid=grid_ref(grid, sx, sy),
            polys=[dict(outer=p['outer'].tolist(), holes=[h.tolist() for h in p['holes']]) for p in polys],
            tri=dict(v=np.round(V, 2).flatten().tolist(), i=I.astype(int).tolist()),
            _mask_id=tid[t],
        ))
    if qa:
        os.makedirs(QA, exist_ok=True)
        rng = np.random.default_rng(n)
        lut = (rng.random((len(tags) + 2, 3)) * 180 + 60).astype(np.uint8)
        lut[0] = 0
        vis = lut[ws]
        vis[bar > 0] = (255, 255, 255)
        vis[(fp == 0) & (bar == 0)] = (20, 20, 20)
        for r in rooms:
            x, y = r['anchor']
            cv2.putText(vis, r['tag'], (int(x * KR) - 12, int(y * KR)), cv2.FONT_HERSHEY_SIMPLEX, 0.32, (0, 0, 0), 1, cv2.LINE_AA)
        cv2.imwrite(os.path.join(QA, f'rooms_L{n}.png'), vis[..., ::-1])
    return rooms, ws, tid


def relations(levels):
    """Stacked above/below (room at the same plan point one level up/down) and
    neighbours (rooms across a wall or opening)."""
    k = KR
    ids = {n: {v: t for t, v in L['tid'].items()} for n, L in levels.items()}
    for n, L in levels.items():
        ws = L['ws']
        for r in L['rooms']:
            x, y = r['anchor']
            for key, m in (('above', n + 1), ('below', n - 1)):
                r[key] = None
                if m not in levels:
                    continue
                w2 = levels[m]['ws']
                px, py = int(x * k), int(y * k)
                win = w2[max(0, py - 3):py + 4, max(0, px - 3):px + 4].ravel()
                win = win[win > 0]
                if len(win):
                    r[key] = ids[m][int(np.bincount(win).argmax())]
            mid = L['tid'][r['tag']]
            x0, y0, x1, y1 = [int(v * k) for v in r['bbox']]
            X0, Y0 = max(0, x0 - 12), max(0, y0 - 12)
            sub = ws[Y0:y1 + 12, X0:x1 + 12]
            me = (sub == mid).astype(np.uint8)
            ring = cv2.dilate(me, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13))) & (1 - me)
            nb = sub[ring > 0]
            nb = nb[(nb > 0) & (nb != mid)]
            cnt = collections.Counter(nb.tolist())
            r['near'] = [ids[n][i] for i, c in cnt.most_common(10) if c >= 10]


def write_rooms(grid):
    levels = {}
    for n in (1, 2, 3, 4):
        rooms, ws, tid = rooms_for_level(n, grid)
        levels[n] = dict(rooms=rooms, ws=ws, tid=tid)
        print(f'L{n}: {len(rooms)} rooms, {sum(r["open"] for r in rooms)} open-plan', flush=True)
    relations(levels)
    out = []
    for n, L in levels.items():
        for r in L['rooms']:
            r.pop('_mask_id', None)
            rings = [np.array(p['outer']) for p in r['polys']] + [np.array(h) for p in r['polys'] for h in p['holes']]
            r['rings'] = [np.round(np.asarray(g), 1).flatten().tolist() for g in
                          [q for p in r['polys'] for q in [np.array(p['outer'])] + [np.array(h) for h in p['holes']]]]
            r['holes'] = [len(p['holes']) for p in r['polys']]
            r.pop('polys')
            out.append(r)
    os.makedirs(OUT, exist_ok=True)
    doc = dict(scale=dict(ptPerFt=PT_PER_FT, label='1/16" = 1\'-0"'), canvas=[CAN_W, CAN_H], grid=grid,
               levels=[dict(n=n, **LEVELS[n]) for n in (1, 2, 3, 4)], rooms=out)
    with open(os.path.join(OUT, 'rooms.json'), 'w') as f:
        json.dump(doc, f, separators=(',', ':'))
    print('rooms.json', os.path.getsize(os.path.join(OUT, 'rooms.json')) // 1024, 'KB')


K_OVER = 2.0          # overview texture, px per pt (whole sheet)
K_TILE = 8.0          # detail tiles, px per pt (building bbox)
TILE = 2048


def composite(c):
    """The same grey-weighting as the booth video's Level.full."""
    f = lambda a, w: (c[a].astype(np.float32) * w)
    mep = np.maximum.reduce([c['mag'], c['grn'], c['red']]).astype(np.float32)
    ctx = np.maximum(f('light', 0.42), f('tone', 0.07))
    img = np.maximum.reduce([f('main', 1.0), f('text', 0.9), mep * 0.95, f('detail', 0.45), f('grid', 0.30), ctx])
    return np.clip(img, 0, 255).astype(np.uint8)


def footprint_full(n):
    """Floor plate outline.  The penthouse sits on the Level 3 roof, so its plate is
    the Level 3 outline (the penthouse sheet's own linework runs across the site)."""
    d = np.load(os.path.join(CACHE, 'derived.npz'))
    fp = d['fp3'] if n == 4 else d[f'fp{n}']
    return (fp > 0).astype(np.uint8)


def write_masks():
    """Refresh outlines + masks in imagery.json without re-rasterising the tiles."""
    from PIL import Image
    p = os.path.join(OUT, 'imagery.json')
    doc = json.load(open(p))
    for n in (1, 2, 3, 4):
        fp = footprint_full(n)
        Image.fromarray(fp * 255).save(os.path.join(OUT, f'L{n}_fp.png'), optimize=True)
        doc['levels'][str(n)]['footprint'] = rings_of(fp)
    with open(p, 'w') as f:
        json.dump(doc, f, separators=(',', ':'))


def rings_of(mask, k=1.0, eps=1.5, min_area=400):
    cnts, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in cnts:
        if cv2.contourArea(c) < min_area:
            continue
        a = cv2.approxPolyDP(c, eps, True)[:, 0, :].astype(np.float64)
        out.append(np.round((a + 0.5) / k, 1).flatten().tolist())
    return out


def write_images():
    from PIL import Image
    os.makedirs(os.path.join(OUT, 'tiles'), exist_ok=True)
    fps = {n: footprint_full(n) for n in (1, 2, 3, 4)}
    union = np.maximum.reduce(list(fps.values()))
    ys, xs = np.nonzero(union)
    bx0, by0 = max(0, xs.min() - 16), max(0, ys.min() - 16)
    bx1, by1 = min(CAN_W, xs.max() + 16), min(CAN_H, ys.max() + 16)
    nx, ny = int(math.ceil((bx1 - bx0) * K_TILE / TILE)), int(math.ceil((by1 - by0) * K_TILE / TILE))
    bx1, by1 = bx0 + nx * TILE / K_TILE, by0 + ny * TILE / K_TILE
    print(f'tile bbox {bx0},{by0} -> {bx1},{by1}  ({nx} x {ny} tiles)', flush=True)
    doc = dict(canvas=[CAN_W, CAN_H], overviewK=K_OVER, tileK=K_TILE, tileSize=TILE,
               tileOrigin=[float(bx0), float(by0)], tileGrid=[nx, ny], levels={})
    for n in (1, 2, 3, 4):
        z = np.load(os.path.join(CACHE, f'L{n}.npz'), allow_pickle=True)
        over = composite({k: z[k] for k in prep.LAYERS})
        over = cv2.resize(over, (int(CAN_W * K_OVER), int(CAN_H * K_OVER)), interpolation=cv2.INTER_AREA)
        Image.fromarray(over).save(os.path.join(OUT, f'L{n}.webp'), 'WEBP', quality=86, method=6)
        Image.fromarray(fps[n] * 255).save(os.path.join(OUT, f'L{n}_fp.png'), optimize=True)
        path, page = page_of(n)
        off = offset_of(n)
        clip = (bx0, by0, bx1, by1)
        print(f'L{n}: rasterising detail at {K_TILE} px/pt ...', flush=True)
        c = prep.rasterize(page, off, k=K_TILE, clip=clip)
        txt, grd = prep.text_layer(path, off, k=K_TILE, clip=clip)
        c['text'] = txt
        c['grid'] = np.maximum(c['grid'], grd)
        full = composite(c)
        del c
        tiles = []
        for j in range(ny):
            for i in range(nx):
                t = full[j * TILE:(j + 1) * TILE, i * TILE:(i + 1) * TILE]
                if t.shape != (TILE, TILE):
                    t = np.pad(t, ((0, TILE - t.shape[0]), (0, TILE - t.shape[1])))
                if t.mean() < 0.35:                    # nothing drawn here
                    continue
                name = f'tiles/L{n}_{i}_{j}.webp'
                Image.fromarray(t).save(os.path.join(OUT, name), 'WEBP', quality=84, method=6)
                tiles.append([i, j])
        del full
        doc['levels'][n] = dict(overview=f'L{n}.webp', mask=f'L{n}_fp.png', tiles=tiles,
                                footprint=rings_of(fps[n]))
        print(f'   {len(tiles)} tiles', flush=True)
    # risers, elevator core, penthouse duct centrelines (for the airflow)
    import assets
    d = np.load(os.path.join(CACHE, 'derived.npz'))
    sy, sx = np.nonzero(d['duct_skel'] > 0)
    dist = d['duct_dist'][sy, sx]
    keep = (np.arange(len(sx)) % 2 == 0) & (dist >= 0)
    doc['ducts'] = np.round(np.stack([sx[keep] / 1.5, sy[keep] / 1.5, dist[keep]], 1), 1).flatten().tolist()
    doc['risers'] = [dict(name='XT1', x=assets.SHAFT_XT1[0], y=assets.SHAFT_XT1[1], lo=2, hi=4),
                     dict(name='XT3', x=assets.SHAFT_XT3[0], y=assets.SHAFT_XT3[1], lo=2, hi=4)]
    doc['core'] = [506, 660, 578, 726]
    with open(os.path.join(OUT, 'imagery.json'), 'w') as f:
        json.dump(doc, f, separators=(',', ':'))


def main():
    stage = sys.argv[1] if len(sys.argv) > 1 else 'all'
    grid = column_grid()
    print('grid cols:', [(round(g['pos'], 1), g['label']) for g in grid['cols']])
    print('grid rows:', [(round(g['pos'], 1), g['label']) for g in grid['rows']])
    if stage in ('rooms', 'all'):
        write_rooms(grid)
    if stage in ('images', 'all'):
        write_images()
    if stage == 'masks':
        write_masks()


if __name__ == '__main__':
    main()
