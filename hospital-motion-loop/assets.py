"""
Derived animation data built on top of prep.py's registered layers:

  * geodesic "ink arrival" map  - lines grow outward along the drawing itself
  * building footprints          - opaque floor slabs for the exploded stack
  * duct centreline flow field   - airflow particles along the penthouse ductwork
  * roof drains                  - storm-drain ripple centres
  * Level 3 patient rooms        - flood-filled room shapes for the room chase

Everything is in canonical Level-2 sheet points; rasters carry their own K.
"""
import os, re
import numpy as np
import cv2
from skimage.graph import MCP_Geometric
from skimage.morphology import skeletonize

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, '.cache')

# Anchors read off the sheets (canonical pt)
ELEV_CORE = (538.0, 694.0)          # elevator bank (same on every floor)
ELEV_T1E3 = (557.0, 690.0)          # the car we ride from Level 1 to Level 2
AMB_ENTRY = (1724.0, 626.0)         # Level 1 ambulance vestibule - where the drawing starts
SHAFT_XT1 = (477.0, 501.0)
SHAFT_XT3 = (1343.5, 723.0)
# Roof drains: hand-picked on the roof plan, confirmed against the drain symbol
_DRAINS_PX = [(746.7, 398.3), (461.7, 437.5), (1061.7, 398.3), (209.2, 550.0), (291.7, 641.7),
              (655.0, 590.0), (1002.5, 590.0), (338.3, 856.7), (646.7, 793.3), (978.3, 793.3),
              (848.3, 917.5), (905.0, 948.3), (1033.7, 917.5), (1358.3, 398.3), (1676.7, 398.3),
              (1340.0, 590.0), (1666.7, 590.0), (1340.0, 818.3), (1666.7, 818.3), (1131.7, 958.3),
              (1354.2, 958.3), (1877.5, 541.7), (1877.5, 613.3), (1877.5, 698.3)]
DRAINS = [(x / 1.02751 - 19.88, y / 1.02751 - 15.92 + 2.0) for x, y in _DRAINS_PX]


def load_level(n):
    p = os.path.join(CACHE, f'L{n}.npz')
    return np.load(p, allow_pickle=True) if os.path.exists(p) else None


def down(img, K, k2):
    """Resize a K px/pt raster to k2 px/pt."""
    h, w = img.shape
    return cv2.resize(img, (int(round(w * k2 / K)), int(round(h * k2 / K))), interpolation=cv2.INTER_AREA)


def arrival_map(z, seed=ELEV_CORE, k=1.0):
    """Geodesic distance (normalised 0..1) from `seed` travelling along ink."""
    K = float(z['K'])
    ink = np.maximum.reduce([z['main'], z['detail'], z['text'], z['grn'], z['mag'], z['red']]).astype(np.float32) / 255
    ink = down(ink, K, k)
    cost = np.where(ink > 0.12, 1.0, 7.0).astype(np.float64)
    m = MCP_Geometric(cost, fully_connected=True)
    sy, sx = int(seed[1] * k), int(seed[0] * k)
    A, _ = m.find_costs([(sy, sx)])
    A = A.astype(np.float32)
    lim = np.percentile(A[ink > 0.12], 99.7)
    return np.clip(A / lim, 0, 1.5).astype(np.float32)


def footprint(z, k=1.0, close_pt=14, keep_min=6000):
    K = float(z['K'])
    m = down(z['main'], K, k) > 60
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * close_pt + 1, 2 * close_pt + 1))
    c = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, ker)
    # fill interior holes
    h, w = c.shape
    ff = c.copy()
    mask = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(ff, mask, (0, 0), 1)
    filled = c | (1 - ff)
    filled = cv2.morphologyEx(filled, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(filled, 8)
    out = np.zeros_like(filled)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= keep_min:
            out[lab == i] = 1
    return out.astype(np.float32)


def duct_flow(z, k=1.5, sources=(SHAFT_XT1, SHAFT_XT3)):
    """Skeleton of the penthouse ductwork + geodesic distance from the shafts."""
    K = float(z['K'])
    d = np.maximum(z['mag'], z['grn']).astype(np.float32) / 255
    d = down(d, K, k) > 0.08
    # merge each duct's two outline strokes into a solid band (no hole filling:
    # the rooftop duct loop encloses open roof that must stay open)
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (int(16 * k) | 1, int(16 * k) | 1))
    solid = cv2.morphologyEx(d.astype(np.uint8), cv2.MORPH_CLOSE, ker)
    # fill the inside of each duct (small holes) but not the open roof the loop encloses
    cnts, hier = cv2.findContours(solid, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hier is not None:
        for c, h in zip(cnts, hier[0]):
            if h[3] >= 0 and cv2.contourArea(c) < 6000 * k * k:
                cv2.drawContours(solid, [c], -1, 1, -1)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(solid, 8)
    keep = np.zeros_like(solid)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] > 120:
            keep[lab == i] = 1
    skel = skeletonize(keep.astype(bool))
    cost = np.where(skel, 1.0, 40.0)
    starts = []
    for sx, sy in sources:
        ys, xs = np.nonzero(skel)
        j = np.argmin((xs - sx * k) ** 2 + (ys - sy * k) ** 2)
        starts.append((ys[j], xs[j]))
    # also start every disconnected skeleton piece at its point nearest a shaft
    n2, lab2 = cv2.connectedComponents(skel.astype(np.uint8), connectivity=8)
    for i in range(1, n2):
        ys, xs = np.nonzero(lab2 == i)
        if len(ys) < 12: continue
        dd = np.min([(xs - sx * k) ** 2 + (ys - sy * k) ** 2 for sx, sy in sources], axis=0)
        j = np.argmin(dd)
        starts.append((ys[j], xs[j]))
    m = MCP_Geometric(cost, fully_connected=True)
    D, _ = m.find_costs(starts)
    D = np.where(skel, D, -1).astype(np.float32)
    return keep.astype(np.float32), skel.astype(np.float32), D / k   # distance in pt


# Level 3 patient-room bays (canonical pt): demising walls measured off the sheet
_TOP_WALLS = [598.5, 671.5, 739.7, 810.7, 878.8, 949.9, 1018.0, 1089.1, 1158.2, 1228.2,
              1299.3, 1369.3, 1439.4, 1510.5, 1578.6, 1646.7]            # RM 30 .. RM 16
_BOT_WALLS = [739.7, 809.7, 880.8, 950.9, 1020.9, 1091.0, 1162.0, 1231.1, 1301.2, 1372.3,
              1440.4, 1510.5, 1580.5, 1650.6]                             # RM 1 .. RM 13
ROOM_RECTS = {}
for i in range(15):
    ROOM_RECTS[30 - i] = (_TOP_WALLS[i], 433.0, _TOP_WALLS[i + 1], 537.0)
for i in range(13):
    ROOM_RECTS[1 + i] = (_BOT_WALLS[i], 786.0, _BOT_WALLS[i + 1], 890.0)
ROOM_RECTS[15] = (1644.8, 569.3, 1753.8, 645.3)
ROOM_RECTS[14] = (1644.8, 688.1, 1753.8, 761.1)
ICU_ROOMS = set(range(8, 22))


def room_regions(z, k=1.5, dil_pt=1.6):
    """Room shapes: each bay rectangle flood-filled from beside its label, so
    the enclosed toilet and wall poche drop out of the highlight."""
    K = float(z['K'])
    walls = (down(z['main'], K, k) > 70).astype(np.uint8)
    r = max(1, int(round(dil_pt * k)))
    wd = cv2.dilate(walls, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
    labels = {}
    for s in z['spans']:
        m = re.match(r'^RM (\d+)$', str(s[0]))
        if m:
            labels[int(m.group(1))] = ((s[1] + s[3]) / 2, (s[2] + s[4]) / 2)
    rooms = {}
    for num, (x0, y0, x1, y1) in ROOM_RECTS.items():
        X0, Y0, X1, Y1 = int(x0 * k), int(y0 * k), int(x1 * k), int(y1 * k)
        free = (1 - wd[Y0:Y1, X0:X1]).astype(np.uint8)
        region = free.copy()
        cx, cy = labels.get(num, ((x0 + x1) / 2, (y0 + y1) / 2))
        for dx, dy in ((-20, 0), (20, 0), (-24, 12), (24, 12), (0, -16)):
            px, py = int((cx + dx) * k) - X0, int((cy + dy) * k) - Y0
            if 0 <= px < free.shape[1] and 0 <= py < free.shape[0] and free[py, px]:
                img = free.copy()
                mask = np.zeros((img.shape[0] + 2, img.shape[1] + 2), np.uint8)
                area, _, _, _ = cv2.floodFill(img, mask, (px, py), 2)
                if area > 0.4 * free.size:
                    region = (img == 2).astype(np.uint8)
                    break
        region = cv2.dilate(region, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
        rooms[num] = dict(ok=True, bbox=(x0, y0, x1, y1), mask=region, off=(X0, Y0), k=k,
                          center=(cx, cy), icu=num in ICU_ROOMS)
    return rooms


def drain_field(z5, fp, k=1.0):
    """Distance (pt) from every roof point to its nearest drain, inside the roof."""
    h, w = fp.shape
    seeds = np.ones((h, w), np.uint8)
    for x, y in DRAINS:
        cv2.circle(seeds, (int(x * k), int(y * k)), 1, 0, -1)
    D = cv2.distanceTransform(seeds, cv2.DIST_L2, 5) / k
    return np.where(fp > 0, D, -1).astype(np.float32)


ELEV_BOX = (497.0, 624.0, 617.0, 744.0)   # close-up window around the elevator bank
CLIP_K = 20.0


def closeup(level, box=ELEV_BOX, k=CLIP_K):
    """Vector re-render of a small window at very high resolution for the elevator ride."""
    import prep
    import pymupdf as fitz
    path = prep.find_pdf(level)
    z = load_level(level)
    off = tuple(z['off'])
    page = fitz.open(path)[0]
    canv = prep.rasterize(page, off, k=k, clip=box)
    txt, grd = prep.text_layer(path, off, k=k, clip=box)
    full = np.maximum.reduce([canv['main'], (txt * 0.9).astype(np.uint8),
                              (canv['detail'] * 0.55).astype(np.uint8),
                              (np.maximum(canv['grid'], grd) * 0.32).astype(np.uint8),
                              (np.maximum.reduce([canv['mag'], canv['grn'], canv['red']]) * 0.95).astype(np.uint8)])
    return full


def build():
    out = {}
    for n in (1, 2):
        if load_level(n) is not None:
            print(f'elevator close-up L{n} ...', flush=True)
            out[f'close{n}'] = closeup(n)
    z1 = load_level(1)
    if z1 is not None:
        print('arrival map L1 ...', flush=True)
        out['arr1'] = arrival_map(z1, seed=AMB_ENTRY)
    for n in (1, 2, 3, 4, 5):
        z = load_level(n)
        if z is None: continue
        print(f'footprint L{n} ...', flush=True)
        out[f'fp{n}'] = footprint(z)
    z4 = load_level(4)
    print('duct flow ...', flush=True)
    out['duct_solid'], out['duct_skel'], out['duct_dist'] = duct_flow(z4)
    print('drain field ...', flush=True)
    out['drain_dist'] = drain_field(load_level(5), out['fp5'])
    np.savez_compressed(os.path.join(CACHE, 'derived.npz'), **out)
    z3 = load_level(3)
    print('rooms L3 ...', flush=True)
    rooms = room_regions(z3)
    np.save(os.path.join(CACHE, 'rooms3.npy'), rooms, allow_pickle=True)
    print('rooms:', len(rooms))


if __name__ == '__main__':
    build()
