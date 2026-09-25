"""
Pre-process the vector floor-plan PDFs into registered raster layers.

Every level is split by stroke colour into semantic layers so the animation
can build a floor the way it was drafted: column grid, then walls, then
furniture/detail, then room tags.  All levels are registered to the Level 2
sheet using the blue column-grid lines found in the vector data.

Output: .cache/L{n}.npz holding uint8 layers at K px per PDF point.
"""
import os, re, sys, glob, collections
import numpy as np
import cv2
import pymupdf as fitz

HERE = os.path.dirname(os.path.abspath(__file__))
PLANS = os.environ.get('PLANS_DIR', os.path.join(HERE, 'plans'))
CACHE = os.path.join(HERE, '.cache')
K = 3.0                        # raster pixels per PDF point
CAN_W, CAN_H = 1946.0, 1240.0  # canonical canvas (Level 2 sheet points)
LAYERS = ('main', 'detail', 'light', 'grid', 'mag', 'grn', 'red', 'tone', 'text')


def find_pdf(level):
    hits = sorted(glob.glob(os.path.join(PLANS, f'*_{level}.pdf')) +
                  glob.glob(os.path.join(PLANS, f'L{level}.pdf')))
    return hits[0] if hits else None


def grid_lines(page):
    """Length-weighted positions of the blue column-grid lines (vertical, horizontal)."""
    xs, ys = collections.Counter(), collections.Counter()
    for d in page.get_drawings():
        c = d.get('color')
        if not c or not (c[2] > 0.9 and c[0] < 0.5 and 0.5 < c[1] < 0.75):
            continue
        for it in d['items']:
            if it[0] != 'l':
                continue
            a, b = it[1], it[2]
            if abs(a.x - b.x) < 0.02:
                xs[round(a.x, 1)] += abs(a.y - b.y)
            if abs(a.y - b.y) < 0.02:
                ys[round(a.y, 1)] += abs(a.x - b.x)
    X = np.array(sorted(k for k, v in xs.items() if v > 150))
    Y = np.array(sorted(k for k, v in ys.items() if v > 150))
    return X, Y


def register(X, Y, X0, Y0):
    """Translation that maps this sheet's grid onto the reference grid."""
    def best(A, B):
        cands = [a - b for a in A for b in B]
        score = lambda o: sum(np.min(np.abs(B + o - a)) < 0.6 for a in A)
        o = max(cands, key=lambda o: (score(o), -abs(o)))
        m = [a - (B + o)[np.argmin(np.abs(B + o - a))] for a in A if np.min(np.abs(B + o - a)) < 0.6]
        return o + float(np.mean(m))
    return best(X0, X), best(Y0, Y)   # canonical = page + (dx, dy)


def stroke_layer(color, width):
    if color is None or width >= 3.0:          # heavy dashed match line: drop
        return None
    r, g, b = color
    mx, mn = max(color), min(color)
    if mx - mn < 0.05:
        if mx <= 0.15: return 'main'
        if mx <= 0.70: return 'detail'
        return 'light'
    if b > 0.9 and r < 0.8 and g < 0.8: return 'grid'
    if r > 0.8 and b > 0.8 and g < 0.3: return 'mag'
    if g > 0.5 and r < 0.3 and b < 0.3: return 'grn'
    if r > 0.8 and g < 0.4 and b < 0.4: return 'red'
    if r > 0.8 and g > 0.5 and b > 0.5: return 'red'   # pink
    return 'detail'


def fill_layer(fill):
    if fill is None: return None
    r, g, b = fill
    if min(fill) > 0.97: return 'white'
    if max(fill) - min(fill) < 0.05:
        return 'mainfill' if max(fill) < 0.15 else 'tone'
    if b > 0.9 and r < 0.2 and g < 0.2: return 'grid'
    if r > 0.8 and b > 0.8 and g < 0.3: return 'mag'
    if g > 0.4 and r < 0.3 and b < 0.3: return 'grn'
    return 'red'


def rasterize(page, off, k=K, clip=None):
    """Draw the vector strokes of `page` into per-layer uint8 canvases.

    off  : canonical = page + off
    clip : optional canonical-space (x0, y0, x1, y1) window (for close-ups)
    """
    x0, y0, x1, y1 = clip if clip else (0.0, 0.0, CAN_W, CAN_H)
    W, H = int(round((x1 - x0) * k)), int(round((y1 - y0) * k))
    canv = {n: np.zeros((H, W), np.uint8) for n in LAYERS}
    SH = 4                                      # cv2 fixed-point sub-pixel bits
    S = float(1 << SH)
    ox, oy = off[0] - x0, off[1] - y0
    pending = collections.defaultdict(list)     # (layer, thick, val) -> [polylines]

    def pts(seq):
        a = np.array([[(p.x + ox) * k, (p.y + oy) * k] for p in seq], np.float64)
        return np.round(a * S).astype(np.int32)

    def flush():
        for (name, th, val), polys in pending.items():
            cv2.polylines(canv[name], polys, False, int(val), th, cv2.LINE_AA, SH)
        pending.clear()

    def poly_of(items):
        out = []
        for it in items:
            if it[0] == 'l':
                out.append(pts([it[1], it[2]]))
            elif it[0] == 're':
                r = it[1]
                out.append(pts([r.tl, r.tr, r.br, r.bl, r.tl]))
            elif it[0] == 'qu':
                q = it[1]
                out.append(pts([q.ul, q.ur, q.lr, q.ll, q.ul]))
            elif it[0] == 'c':
                p0, p1, p2, p3 = it[1:5]
                t = np.linspace(0, 1, 12)[:, None]
                P = [np.array([p.x, p.y]) for p in (p0, p1, p2, p3)]
                c = ((1-t)**3)*P[0] + 3*((1-t)**2)*t*P[1] + 3*(1-t)*t*t*P[2] + (t**3)*P[3]
                c = np.round(((c + [ox, oy]) * k) * S).astype(np.int32)
                out.append(c)
        return out

    def fill_region(items):
        # closed outline of a fill path as one polygon
        ring = []
        for it in items:
            if it[0] == 'l':
                if not ring: ring.append(it[1])
                ring.append(it[2])
            elif it[0] == 're':
                r = it[1]; ring += [r.tl, r.tr, r.br, r.bl]
            elif it[0] == 'qu':
                q = it[1]; ring += [q.ul, q.ur, q.lr, q.ll]
            elif it[0] == 'c':
                ring += [it[1], it[4]]
        return [pts(ring)] if len(ring) >= 3 else []

    for d in page.get_drawings():
        typ = d.get('type', 's')
        if 'f' in typ:
            fl = fill_layer(d.get('fill'))
            region = fill_region(d['items'])
            if region and fl:
                flush()
                if fl in ('white', 'tone'):
                    for n in LAYERS:
                        if n != 'text':
                            cv2.fillPoly(canv[n], region, 0, cv2.LINE_AA, SH)
                    if fl == 'tone':
                        v = int(255 * (1.0 - max(d['fill'])))
                        cv2.fillPoly(canv['tone'], region, max(v, 40), cv2.LINE_AA, SH)
                elif fl == 'mainfill':
                    cv2.fillPoly(canv['main'], region, 255, cv2.LINE_AA, SH)
                else:
                    cv2.fillPoly(canv[fl], region, 150, cv2.LINE_AA, SH)
        if 's' in typ:
            name = stroke_layer(d.get('color'), d.get('width') or 0.0)
            if name is None:
                continue
            r = d['rect']
            if name == 'main' and (d.get('width') or 0) >= 1.4 and r.width < 1.0 \
                    and 965 < r.x0 + off[0] < 985:
                continue                        # roof sheet's dashed match line
            wpx = (d.get('width') or 0.2) * k
            if wpx < 1.5:
                th, val = 1, int(255 * float(np.clip(wpx, 0.45, 1.0)))
                val = (val // 32) * 32 + 31
            else:
                th, val = int(round(wpx)), 255
            pending[(name, th, val)].extend(poly_of(d['items']))
    flush()
    return canv


def text_layer(path, off, k=K, clip=None):
    """Render only the text of the sheet (graphics redacted away)."""
    doc = fitz.open(path)
    page = doc[0]
    # 1) drop the match-line / sheet-reference labels (pure blue text)
    spans = [s for b in page.get_text('dict')['blocks'] for l in b.get('lines', [])
             for s in l['spans']]
    n = 0
    sheet_ref = re.compile(r'^(SLAB PLAN|DIMENSION PLANS?|NOTATION PLANS?|A\d{3}\.[AB]|/)$')
    for s in spans:
        x0, y0 = s['bbox'][0] + off[0], s['bbox'][1] + off[1]
        in_ref_zone = 920 < x0 < 1030 and 150 < y0 < 320
        if s['color'] == 0x0000FF or sheet_ref.match(s['text'].strip()) or \
                (in_ref_zone and s['text'].strip() == '1'):
            page.add_redact_annot(fitz.Rect(s['bbox']))
            n += 1
    if n:
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE,
                              graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                              text=fitz.PDF_REDACT_TEXT_REMOVE)
    # 2) remove every graphic, keep the text
    page.add_redact_annot(page.rect)
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_REMOVE,
                          graphics=fitz.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED,
                          text=fitz.PDF_REDACT_TEXT_NONE)
    x0, y0, x1, y1 = clip if clip else (0.0, 0.0, CAN_W, CAN_H)
    r = fitz.Rect(x0 - off[0], y0 - off[1], x1 - off[0], y1 - off[1])
    pix = page.get_pixmap(matrix=fitz.Matrix(k, k), clip=r, alpha=False)
    a = np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w, pix.n)[..., :3].astype(np.int16)
    W, H = int(round((x1 - x0) * k)), int(round((y1 - y0) * k))
    a = cv2.resize(a.astype(np.uint8), (W, H), interpolation=cv2.INTER_AREA).astype(np.int16) \
        if (a.shape[1], a.shape[0]) != (W, H) else a
    ink = 255 - a.min(axis=2)
    blue = (a[..., 2] - a[..., 0]) > 40            # grid bubble labels
    txt = np.where(blue, 0, ink).astype(np.uint8)
    grd = np.where(blue, ink, 0).astype(np.uint8)
    return txt, grd


def text_spans(path, off):
    """Room tags etc. as canonical-space boxes, for callouts."""
    page = fitz.open(path)[0]
    out = []
    for b in page.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            for s in l['spans']:
                x0, y0, x1, y1 = s['bbox']
                out.append((s['text'].strip(), x0 + off[0], y0 + off[1], x1 + off[0], y1 + off[1]))
    return out


def main():
    os.makedirs(CACHE, exist_ok=True)
    want = [int(a) for a in sys.argv[1:]] or [1, 2, 3, 4, 5]
    levels = [n for n in want if find_pdf(n)]
    ref = fitz.open(find_pdf(2))[0]
    X0, Y0 = grid_lines(ref)
    for n in levels:
        path = find_pdf(n)
        page = fitz.open(path)[0]
        X, Y = grid_lines(page)
        off = register(X, Y, X0, Y0)
        print(f'L{n}: {os.path.basename(path)}  offset (canonical = page + off) = ({off[0]:.2f}, {off[1]:.2f})', flush=True)
        canv = rasterize(page, off)
        txt, grd = text_layer(path, off)
        canv['text'] = txt
        canv['grid'] = np.maximum(canv['grid'], grd)
        spans = text_spans(path, off)
        np.savez_compressed(os.path.join(CACHE, f'L{n}.npz'), off=np.array(off), K=K,
                            spans=np.array(spans, dtype=object), **canv)
        for k2, v in canv.items():
            print(f'   {k2:7s} ink={v.mean()/255:.4f}', flush=True)


if __name__ == '__main__':
    main()
