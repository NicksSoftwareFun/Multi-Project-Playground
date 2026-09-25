#!/usr/bin/env python3
"""
MIH Tower - 15 second booth loop.
Black & white linework + LED dot-matrix, built from the vector floor plans.

  python3 render.py --still 2.4 [out.png]    one frame at t seconds
  python3 render.py --clip 3.0 4.5 [out.mp4] a section
  python3 render.py                          the full seamless loop (1080p30 H.264)

Storyboard (seconds)
  0.00 ignite       a single dot sparks an LED grid; Level 1 ripples in as dots
  0.90 level 01     the plan draws itself from the ambulance entry to the elevators
  3.30 ride         dive into elevator T1E3, floor indicator 01 -> 02
  4.10 level 02     scan bar converts dots to linework; room callouts
  6.10 morph        the LED matrix re-renders in place from Level 2 to Level 3
  6.60 level 03     all 30 patient rooms chase around the floor; ICU holds
  8.60 stack        dolly-zoom into an exploded axonometric of all five levels,
                    MEP risers through shafts XT1 / XT3
 11.40 penthouse    airflow along the rooftop ductwork; equipment callouts
 12.50 roof         storm-drain ripples converge on every roof drain
 13.30 outro        the roof's dots fly into the tagline, then collapse to the
                    single dot the loop starts from
"""
import os, sys, math, time, argparse, subprocess
import numpy as np
import cv2
import mg
from mg import (W, H, FPS, seg, lerp, clamp01, e_out_cubic, e_in_cubic, e_io_cubic, e_out_quart, e_in_quart,
                e_io_quint, e_out_expo, e_in_expo, e_io_expo, e_out_back, smoothstep, hash01,
                Overlay, put_text, text_img, text_width, blit_max, dm_text_image, dm_width,
                led_density, led_from_density, dots_from_radii, cell_centers, dot_grid, Cam, MipTex,
                glow, vignette, grain, MONO, MONO_R, MONO_SB, COND, COND_B, COND_M,
                typeon, scramble_text, draw_line_partial)
import assets

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, '.cache')
OUT = os.path.join(HERE, 'out')
DUR = 15.0
NF = int(round(DUR * FPS))
CENTER = (930.0, 650.0)          # canonical sheet point at world origin
Q = 6                            # LED pitch (px)

TICK = [0]          # 60 Hz animation tick, fixed per output frame (keeps type crisp under motion blur)

def tick():
    return TICK[0]


SHUTTER = 0.5 / FPS  # 180-degree shutter


class UILayer:
    """Screen-space type + graphics.  Drawn once per output frame at its centre
    time; motion-blur sub-samples skip it, so labels never ghost."""
    on = True
    img = mul = ov = None

    def begin(self, on):
        self.on = on
        if on:
            self.img = np.zeros((H, W), np.float32)
            self.mul = np.ones((H, W), np.float32)     # darkening applied to the world layer
            self.ov = Overlay()


UI = UILayer()

PROJECT = 'MIH TOWER'
TAGLINE = ('BUILDING THE', 'FUTURE OF CARE')
LEVEL_INFO = {
    1: ('LEVEL 01', 'EMERGENCY DEPARTMENT  ·  MAIN LOBBY'),
    2: ('LEVEL 02', 'LABOR & DELIVERY  ·  NICU  ·  POSTPARTUM'),
    3: ('LEVEL 03', 'PATIENT CARE  ·  ICU'),
    'stack': ('MEP RISERS', 'SHAFTS XT1 + XT3  ·  FIVE LEVELS'),
    4: ('PENTHOUSE', 'MECHANICAL  ·  ELECTRICAL  ·  PLUMBING'),
    5: ('ROOF', 'STORM DRAINAGE'),
}
# section boundaries (drive the HUD progress ticks too)
T_L1, T_RIDE, T_L2, T_MORPH, T_L3, T_STACK, T_PH, T_RF, T_OUT = \
    0.90, 3.30, 4.10, 6.10, 6.60, 8.60, 11.40, 12.50, 13.30

# --------------------------------------------------------------------------- data
class Level:
    def __init__(self, n, z, per_layer=False):
        self.n, self.K = n, float(z['K'])
        K = self.K
        mep = np.maximum.reduce([z['mag'], z['grn'], z['red']]) if n != 5 else z['red']
        ctx = np.maximum((z['light'] * 0.42).astype(np.uint8), (z['tone'] * 0.07).astype(np.uint8))
        full = np.maximum.reduce([z['main'], (z['text'] * 0.9).astype(np.uint8),
                                  (mep * 0.95).astype(np.uint8), (z['detail'] * 0.45).astype(np.uint8),
                                  (z['grid'] * 0.30).astype(np.uint8), ctx])
        self.full = MipTex(full, K)
        self.mep = MipTex(mep, K)
        if per_layer:
            self.main = MipTex(z['main'], K)
            self.detail = MipTex(z['detail'], K)
            self.text = MipTex(z['text'], K)
            self.grid = MipTex(z['grid'], K)
            self.ctx = MipTex(ctx, K)
        self.spans = z['spans']
        self._full_raw = full

LV, D = {}, {}
ROOM_ID = None
STACK = {}


def load():
    global ROOM_ID, D
    for n in (1, 2, 3, 4, 5):
        p = os.path.join(CACHE, f'L{n}.npz')
        if os.path.exists(p):
            LV[n] = Level(n, dict(np.load(p, allow_pickle=True)), per_layer=(n == 1))
    D = dict(np.load(os.path.join(CACHE, 'derived.npz')))
    rooms = np.load(os.path.join(CACHE, 'rooms3.npy'), allow_pickle=True).item()
    k = 1.5
    ROOM_ID = np.zeros((int(1240 * k), int(1946 * k)), np.uint8)
    for num, r in rooms.items():
        x, y = r['off']; m = r['mask']; h, w = m.shape
        ROOM_ID[y:y + h, x:x + w][m > 0] = num
    D['room_id'] = ROOM_ID
    # close-up textures for the elevator ride (vector re-render at 20 px/pt)
    for n in (1, 2):
        if f'close{n}' in D:
            D[f'closetex{n}'] = MipTex(D[f'close{n}'], assets.CLIP_K, levels=6)
    # exploded-stack textures: building only (site context masked away), plus slab + edge
    fp_of = {1: 'fp1', 2: 'fp2', 3: 'fp3', 4: 'fp3', 5: 'fp5'}
    for n, lv in LV.items():
        fp = D[fp_of[n]]
        fpd = cv2.dilate(fp, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13)))
        half = cv2.resize(lv._full_raw, (fp.shape[1] * 3 // 2, fp.shape[0] * 3 // 2), interpolation=cv2.INTER_AREA)
        m = cv2.resize(fpd, (half.shape[1], half.shape[0]), interpolation=cv2.INTER_LINEAR)
        STACK[n] = dict(
            lines=MipTex((half * m).astype(np.uint8), 1.5),
            slab=MipTex((fp * 255).astype(np.uint8), 1.0),
            edge=MipTex((cv2.morphologyEx(fp, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)) * 255).astype(np.uint8), 1.0),
        )
        del lv._full_raw
    init_outro()

# --------------------------------------------------------------------------- camera helpers
def camp(px, py, s, yaw=0.0, pitch=0.0, fov=18.0, z=0.0):
    return dict(px=px, py=py, s=s, yaw=yaw, pitch=pitch, fov=fov, z=z)

def cam_lerp(a, b, u):
    out = {k: lerp(a[k], b[k], u) for k in a}
    out['s'] = math.exp(lerp(math.log(a['s']), math.log(b['s']), u))
    return out

def make_cam(p):
    tw = mg.plan_to_world(p['px'], p['py'], p['z'], CENTER)
    return Cam(target=tw, scale=p['s'], yaw=p['yaw'], pitch=p['pitch'], fov=p['fov'])

def plane_scale(cam, z):
    tx, ty = cam.target[0], cam.target[1]
    p, _ = cam.project([[tx, ty, z], [tx + 10, ty, z], [tx, ty + 10, z]])
    return max(np.linalg.norm(p[1] - p[0]), np.linalg.norm(p[2] - p[0])) / 10

def warp_tex(tex, cam, z=0.0, origin=(0, 0)):
    Hs = cam.plane_H(tex.K, origin, z, CENTER)
    return tex.warp(Hs, plane_scale(cam, z))

def warp_field(F, k, cam, z=0.0, interp=cv2.INTER_LINEAR, border=-1.0, cells=None):
    Hs = cam.plane_H(k, (0, 0), z, CENTER)
    size = (W, H)
    if cells:
        C = np.array([[1 / cells, 0, -0.5], [0, 1 / cells, -0.5], [0, 0, 1]])
        Hs = C @ Hs
        size = (W // cells, H // cells)
    return cv2.warpPerspective(F, Hs, size, flags=interp, borderMode=cv2.BORDER_CONSTANT, borderValue=border)

def with_closeup(base, key, cam, z=0.0):
    """Swap in the 20 px/pt vector close-up inside its window (crisp at extreme zoom)."""
    close = warp_tex(D[key], cam, z, origin=assets.ELEV_BOX[:2])
    x0, y0, x1, y1 = assets.ELEV_BOX
    pts = np.array([scr(cam, x, y, z) for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))])
    m = np.zeros((H, W), np.uint8)
    cv2.fillPoly(m, [np.round(pts * 16).astype(np.int32)], 255, cv2.LINE_AA, 4)
    m = cv2.erode(m, np.ones((5, 5), np.uint8)).astype(np.float32) / 255
    return base * (1 - m) + close * m


def scr(cam, px, py, z=0.0):
    p, _ = cam.project([mg.plan_to_world(px, py, z, CENTER)])
    return p[0]

# --------------------------------------------------------------------------- shared pieces
def bg_grid(t, amt=1.0):
    """Engineering dot grid behind everything (pitch 24)."""
    if amt <= 0:
        return None
    return dot_grid(24, 1.05, 0.11 * amt)

def plan_led(img, gain=1.9, gamma=0.9, rmax=0.5):
    d = led_density(img, Q, gain, gamma)
    return led_from_density(d, Q, rmax), d

def boost(img, g=0.8):
    return np.power(np.clip(img, 0, 1), g)

def knock(img, x0, y0, x1, y1, amt=0.82, feather=10):
    """Soft-edged darkening behind labels so type stays legible over linework."""
    x0, y0, x1, y1 = int(x0) - feather, int(y0) - feather, int(x1) + feather, int(y1) + feather
    X0, Y0, X1, Y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
    if X1 <= X0 or Y1 <= Y0:
        return
    yy = np.arange(Y0, Y1, dtype=np.float32)[:, None]
    xx = np.arange(X0, X1, dtype=np.float32)[None, :]
    mx = np.clip(np.minimum(xx - x0, x1 - xx) / feather, 0, 1)
    my = np.clip(np.minimum(yy - y0, y1 - yy) / feather, 0, 1)
    img[Y0:Y1, X0:X1] *= 1 - amt * (mx * my)


def callout(img, ov, cam, t, t0, name, tag, anchor, side=1, life=1.05, up=1, z=0.0, a=1.0, camf=None):
    """Ping + elbow leader + two-line label.  Placement is decided once, from the
    camera at t0, so a label never flips sides mid-flight."""
    u = t - t0
    if u < 0 or u > life or not UI.on:
        return
    img, ov = UI.img, UI.ov
    p = scr(cam, anchor[0], anchor[1], z)
    if not (-200 < p[0] < W + 200 and -200 < p[1] < H + 200):
        return
    p0 = scr(camf(t0), anchor[0], anchor[1], z) if camf else p
    wn = text_width(name, COND_B, 26, 0.04)
    wl = max(wn, text_width(tag, MONO, 14, 0.14))
    if side > 0 and p0[0] + 96 + wl > W - 80: side = -1
    elif side < 0 and p0[0] - 96 - wl < 80: side = 1
    if up > 0 and p0[1] - 64 - 40 < 215: up = -1
    elif up < 0 and p0[1] + 64 + 40 > H - 100: up = 1
    out = seg(u, life - 0.22, life)
    fade = (1 - out) * a
    # ping rings
    pr = seg(u, 0.0, 0.45)
    ov.circle(p, 5 + 38 * e_out_cubic(pr), 0.9 * (1 - pr) * a, 1)
    pr2 = seg(u, 0.08, 0.55)
    if pr2 > 0:
        ov.circle(p, 5 + 24 * e_out_cubic(pr2), 0.6 * (1 - pr2) * a, 1)
    dot = e_out_back(seg(u, 0.0, 0.18), 3.0)
    ov.disk(p, 3.6 * dot * (1 - out), 1.0 * a)
    ov.circle(p, 7.5 * dot * (1 - out), 0.8 * fade, 1)
    # leader
    dx, dy = 86 * side, -64 * up
    elbow = p + np.array([dx * 0.42, dy])
    end = p + np.array([dx, dy])
    lu = e_out_expo(seg(u, 0.04, 0.34))
    if lu > 0:
        tail = e_in_cubic(out)
        if tail < 1:
            draw_line_partial(ov, [p + (elbow - p) * tail, elbow, end], lu, 0.95 * a, 1)
    # label
    lab = seg(u, 0.16, 0.5)
    if lab > 0 and out < 1:
        fr = tick()
        nm = scramble_text(name, lab * 1.2, fr, seed=sum(map(ord, name)) % 997)
        tg = typeon(tag, seg(u, 0.26, 0.56), cursor=False)
        x = end[0] + (10 if side > 0 else -10 - wl)
        y = end[1] - 30
        kx = e_out_expo(seg(u, 0.12, 0.4))
        if side > 0:
            knock(UI.mul, x - 6, y - 4, x - 6 + (wl + 16) * kx, y + 52, 0.84 * fade)
        else:
            knock(UI.mul, x + wl + 10 - (wl + 16) * kx, y - 4, x + wl + 10, y + 52, 0.84 * fade)
        xn = x if side > 0 else x + wl - wn
        put_text(img, nm, xn, y, COND_B, 26, 0.04, fade)
        wt = text_width(tag, MONO, 14, 0.14)
        xt = x + 1 if side > 0 else x + wl - wt
        put_text(img, tg, xt, y + 32, MONO, 14, 0.14, 0.85 * fade)
        ul = e_out_expo(seg(u, 0.2, 0.5))
        x0 = x if side > 0 else x + wl
        ov.line((x0, end[1]), (x0 + side * wl * ul, end[1]), 0.9 * fade, 1)


# --------------------------------------------------------------------------- HUD
def hud_alpha(t):
    return e_out_cubic(seg(t, 0.35, 0.85)) * (1 - e_in_cubic(seg(t, 14.30, 14.62)))

def title_key(t):
    if t < 3.62: return 1, 0.92
    if t < 6.30: return 2, 3.97
    if t < 8.62: return 3, 6.30
    if t < 11.28: return 'stack', 8.72
    if t < 12.50: return 4, 11.45
    if t < 13.32: return 5, 12.55
    return None, 0

LEVEL_ORDER = ['RF', 'PH', '03', '02', '01']
LEVEL_ROW = {5: 0, 4: 1, 3: 2, 2: 3, 1: 4}

_SCRIM = None
def scrim():
    global _SCRIM
    if _SCRIM is None:
        m = np.zeros((H, W), np.float32)
        for (x0, y0, x1, y1, v) in ((0, 0, 740, 212, 0.8), (0, H - 96, 560, H, 0.75),
                                    (W - 430, H - 96, W, H, 0.75), (W - 190, 0, W, 175, 0.7)):
            m[y0:y1, x0:x1] = np.maximum(m[y0:y1, x0:x1], v)
        _SCRIM = cv2.GaussianBlur(m, (0, 0), 28)
    return _SCRIM


def hud(img, ov, t, cam=None):
    a = hud_alpha(t)
    if a <= 0.001 or not UI.on:
        return
    img, ov = UI.img, UI.ov
    UI.mul *= 1 - a * scrim()
    fr = tick()
    fno = int(round(t * FPS))
    m, L = 40, 22
    for (x, y, sx, sy) in [(m, m, 1, 1), (W - m, m, -1, 1), (m, H - m, 1, -1), (W - m, H - m, -1, -1)]:
        ov.line((x, y), (x + sx * L, y), 0.55 * a, 1)
        ov.line((x, y), (x, y + sy * L), 0.55 * a, 1)
    # --- project label + title block
    put_text(img, PROJECT, 72, 50, COND_B, 17, 0.32, 0.9 * a)
    wproj = text_width(PROJECT, COND_B, 17, 0.32)
    put_text(img, 'FLOOR PLAN SERIES', 72 + wproj + 18, 53, MONO, 12, 0.18, 0.45 * a)
    key, t0 = title_key(t)
    if key is not None and t >= t0:
        u = t - t0
        big, sub = LEVEL_INFO[key]
        im = dm_text_image(big, 7, t_rel=u, dur_per_char=0.022, scramble=0.09, seed=len(big), frame=fr,
                           off_level=0.10)
        blit_max(img, im, 72, 80, a)
        subu = seg(u, 0.18, 0.62)
        if subu > 0:
            put_text(img, scramble_text(sub, subu * 1.15, fr, 7), 73, 80 + im.shape[0] + 14, COND_M, 19, 0.14, 0.92 * a)
            ru = e_out_expo(seg(u, 0.2, 0.7))
            wsub = text_width(sub, COND_M, 19, 0.14)
            ov.line((73, 80 + im.shape[0] + 46), (73 + wsub * ru, 80 + im.shape[0] + 46), 0.35 * a, 1)
    # --- level indicator (top right)
    xr, y0 = W - 72, 56
    cur = key if key in LEVEL_ROW else None
    for i, labl in enumerate(LEVEL_ORDER):
        n = [5, 4, 3, 2, 1][i]
        y = y0 + i * 18
        on = (cur == n) or (key == 'stack')
        v = (0.95 if on else 0.28) * a
        w = 64 if cur == n else 44
        ov.line((xr - w, y), (xr, y), v, 2 if cur == n else 1)
        put_text(img, labl, xr - 78, y - 9, MONO_SB, 12, 0.1, v, 'rt')
    if cur is not None:
        ov.disk((xr + 10, y0 + LEVEL_ROW[cur] * 18), 3.0, a)
    # --- bottom left: timecode + camera
    ss = int(t); ff = fno % FPS
    put_text(img, f'TC 00:00:{ss:02d}:{ff:02d}', 72, H - 66, MONO, 13, 0.1, 0.62 * a)
    if cam is not None:
        tx, ty = cam.target[0], cam.target[1]
        put_text(img, f'X {tx:+08.1f}   Y {ty:+08.1f}   PX/PT {plane_scale(cam, cam.target[2]):05.2f}',
                 72, H - 46, MONO, 12, 0.08, 0.42 * a)
    # --- bottom right: loop progress
    x1, x0 = W - 72, W - 72 - 300
    yb = H - 52
    ov.line((x0, yb), (x1, yb), 0.22 * a, 1)
    ov.line((x0, yb), (x0 + (x1 - x0) * (t / DUR), yb), 0.85 * a, 2)
    for tk in (T_L1, T_RIDE, T_L2, T_MORPH, T_L3, T_STACK, T_PH, T_RF, T_OUT):
        xx = x0 + (x1 - x0) * tk / DUR
        ov.line((xx, yb - 4), (xx, yb + 4), 0.45 * a, 1)
    put_text(img, 'LOOP  15.00 S', x1, yb - 26, MONO, 12, 0.14, 0.45 * a, 'rt')

# --------------------------------------------------------------------------- scenes
CAM_L1_PRE = camp(935, 662, 0.93, yaw=-5.5)
CAM_L1_A = camp(935, 660, 0.985, yaw=-3.0)
CAM_L1_B = camp(assets.ELEV_T1E3[0], assets.ELEV_T1E3[1] - 6, 1.55, yaw=1.5)
ELEV = (557.0, 686.0)


def cam_l1(t):
    if t < T_L1:
        return cam_lerp(CAM_L1_PRE, CAM_L1_A, e_out_cubic(seg(t, 0.28, T_L1)))
    u = e_io_cubic(seg(t, T_L1, T_RIDE))
    return cam_lerp(CAM_L1_A, CAM_L1_B, u)


def s_ignite(t, img, ov):
    c = np.array([W / 2, H / 2])
    # shock ring + echo
    ring = lambda tt: 1400 * e_out_quart(seg(tt, 0.02, 0.88))
    R, Rp = ring(t), ring(t - SHUTTER)
    ra = 0.9 * (1 - seg(t, 0.12, 0.88))
    span = R - Rp
    if span > 2.0 and ra > 0:                  # speed smear trailing the ring
        m = int(min(48, span / 1.5))
        for i in range(m):
            f = (i + 0.5) / m
            ov.circle(c, Rp + span * f, ra * 0.5 * f * f, 1)
    ov.circle(c, R, ra, 2)
    ov.circle(c, R * 0.72, ra * 0.4, 1)
    # dot grid pops in as the ring passes
    cx, cy = cell_centers(24)
    d = np.hypot(cx - W / 2, cy - H / 2)
    loc = np.clip((R - d) / 110.0, 0, 1)
    pop = np.where(loc > 0, 1 + 1.4 * np.exp(-((R - d) / 36.0) ** 2), 0)
    g = mg.dots_from_radii(1.05 * np.sqrt(loc) * pop, 24) * 0.11
    np.maximum(img, g, out=img)
    # crosshair with ruler ticks
    cu = e_out_expo(seg(t, 0.04, 0.42))
    cv = 0.32 * (1 - seg(t, 0.5, 0.9))
    if cu > 0 and cv > 0:
        ov.line((W / 2 - W / 2 * cu, H / 2), (W / 2 + W / 2 * cu, H / 2), cv, 1)
        ov.line((W / 2, H / 2 - H / 2 * cu), (W / 2, H / 2 + H / 2 * cu), cv, 1)
        for k in range(1, 40):
            x = k * 24
            if x < W / 2 * cu:
                h = 7 if k % 4 == 0 else 3
                for sgn in (-1, 1):
                    ov.line((W / 2 + sgn * x, H / 2 - h), (W / 2 + sgn * x, H / 2 + h), cv * 1.2, 1)
    # center dot: swell then drop into the plan
    r = 5.0 + 6.0 * e_out_back(seg(t, 0.0, 0.10), 2.5)
    r *= 1 - e_in_cubic(seg(t, 0.12, 0.46))
    if r > 0.2:
        ov.disk(c, r, 1.0)
    # Level 1 arrives as an LED ripple
    if t > 0.26:
        cam = make_cam(cam_l1(t))
        src = boost(warp_tex(LV[1].full, cam), 0.85)
        dens = led_density(src, Q, 1.9, 0.9)
        ccx, ccy = cell_centers(Q)
        dd = np.hypot(ccx - W / 2, ccy - H / 2)
        Rw = 1250 * e_out_cubic(seg(t, 0.26, 0.92))
        loc = np.clip((Rw - dd) / 140.0, 0, 1)
        front = np.exp(-((Rw - dd) / 45.0) ** 2) * (Rw > 1)
        mul = loc ** 0.6
        level = 1 + 1.6 * front
        dens2 = np.clip(dens * mul + 0.35 * front * (dens > 0.02), 0, 1)
        np.maximum(img, led_from_density(dens2, Q, 0.5, 0.05, level), out=img)
        return cam
    return None


def s_level1(t, img, ov):
    cam = make_cam(cam_l1(t))
    lv = LV[1]
    # LED base fades back as the linework takes over
    src_full = boost(warp_tex(lv.full, cam), 0.85)
    led_amt = lerp(1.0, 0.16, e_io_cubic(seg(t, 0.95, 2.1)))
    led, _ = plan_led(src_full)
    np.maximum(img, led * led_amt, out=img)
    # geodesic draw-on from the ambulance entry
    A = warp_field(D['arr1'], 1.0, cam, border=9.0)
    F = 1.30 * e_io_cubic(seg(t, T_L1, 2.72))
    main = warp_tex(lv.main, cam)
    vis_m = np.clip((F - A) / 0.018, 0, 1)
    tip = np.exp(-((F - A - 0.012) / 0.016) ** 2) * (F < 1.25)
    det = warp_tex(lv.detail, cam)
    vis_d = np.clip((F - 0.10 - A) / 0.05, 0, 1)
    txt = warp_tex(lv.text, cam)
    vis_t = np.clip((F - 0.17 - A) / 0.02, 0, 1)
    grd = warp_tex(lv.grid, cam)
    gw = H * 1.15 * e_out_cubic(seg(t, 0.92, 1.5))
    yy = np.arange(H, dtype=np.float32)[:, None]
    vis_g = np.clip((gw - yy) / 80.0, 0, 1)
    ctx = warp_tex(lv.ctx, cam)
    mep = warp_tex(lv.mep, cam)
    lines = np.maximum.reduce([
        boost(main, 0.8) * vis_m * (1 + 2.2 * tip),
        boost(det, 0.85) * 0.55 * vis_d,
        txt * 0.9 * vis_t,
        grd * 0.32 * vis_g,
        ctx * vis_d * 0.9,
        mep * 0.95 * vis_d])
    np.maximum(img, lines, out=img)
    # callouts
    cf = lambda tt: make_cam(cam_l1(tt))
    callout(img, ov, cam, t, 0.93, 'AMB. VESTIBULE', 'T1250C  ·  ORIGIN', anchor=(1724, 622), side=-1, camf=cf)
    callout(img, ov, cam, t, 1.72, 'TRAUMA 1', 'T1261', anchor=(1551, 642), side=1, up=-1, camf=cf)
    callout(img, ov, cam, t, 2.10, 'CT ROOM', 'T1404', anchor=(1181, 423), side=1, camf=cf)
    callout(img, ov, cam, t, 2.48, 'FAST TRACK', 'T1230', anchor=(1116, 685), side=-1, up=-1, camf=cf)
    callout(img, ov, cam, t, 2.86, 'ELEVATOR', 'T1E3  ·  UP TO LEVEL 02', anchor=ELEV, side=1, life=0.62, camf=cf)
    return cam


def ride_zoom(t):
    """Scale curve for the elevator dive (in) and emergence (out)."""
    if t < 3.66:
        u = e_in_expo(seg(t, T_RIDE, 3.64))
        return math.exp(lerp(math.log(1.55), math.log(95.0), u))
    u = e_out_expo(seg(t, 3.80, T_L2 + 0.05))
    return math.exp(lerp(math.log(70.0), math.log(1.06), u))


def cam_ride(t):
    u = seg(t, T_RIDE, 3.64)
    return camp(ELEV[0], ELEV[1], ride_zoom(t), yaw=lerp(1.5, 14.0, e_in_cubic(u)))


def s_ride_in(t, img, ov):
    s = ride_zoom(t)
    cam = make_cam(cam_ride(t))
    base = warp_tex(LV[1].full, cam)
    if s > 3:
        base = with_closeup(base, 'closetex1', cam)
    img_l = boost(base, 0.8)
    fade = 1 - smoothstep(30, 90, s)
    np.maximum(img, img_l * fade, out=img)
    return cam


def s_shaft(t, img, ov):
    """Elevator travel: speed streaks + floor indicator 01 -> 02."""
    u = seg(t, 3.52, 3.92)
    a = smoothstep(0.0, 0.25, u) * (1 - smoothstep(0.75, 1.0, u))
    if a <= 0:
        return
    fr = tick()
    speed = 3000 * math.sin(math.pi * u) + 500
    p = 24
    wbox, hbox = dm_width('02', p), 7 * p
    cx, cy = W / 2 - wbox / 2, H / 2 - hbox / 2 - 20
    bx0, by0, bx1, by1 = cx - 56, cy - 150, cx + wbox + 56, cy + hbox + 132
    sv = Overlay()
    for i in range(W // 16 + 1):
        x = 8 + i * 16
        for j in range(4):
            ph = hash01(i, j, 11)
            L = 60 + 260 * hash01(i, j, 12)
            period = H + L + 200
            y = (H + L) - ((ph * period + speed * (t - 3.52)) % period)
            v = (0.14 + 0.5 * hash01(i, j, 13)) * a
            sv.line((x, y), (x, y + L), v, 1)
    streaks = sv.f()
    streaks[int(by0) - 6:int(by1) + 6, int(bx0) - 6:int(bx1) + 6] = 0
    np.maximum(img, streaks, out=img)
    knock(img, bx0, by0, bx1, by1, 0.9 * a)
    # floor indicator: 01 rolls up and out, 02 rolls in
    roll = e_io_quint(seg(t, 3.60, 3.80))
    panel = np.zeros((hbox, wbox), np.float32)
    for digit, off in (('01', -roll * (hbox + 30)), ('02', (1 - roll) * (hbox + 30))):
        im = dm_text_image(digit, p, t_rel=10, off_level=0.14)
        oy = int(round(off))
        y0, y1 = max(0, oy), min(hbox, oy + hbox)
        if y1 > y0:
            np.maximum(panel[y0:y1], im[y0 - oy:y1 - oy], out=panel[y0:y1])
    blit_max(img, panel, cx, cy, a)
    arrow = dm_text_image('^', 11, t_rel=10, off_level=0.0)
    blink = 1.0 if (fr // 6) % 2 == 0 else 0.35
    blit_max(img, arrow, W / 2 - arrow.shape[1] / 2, cy - 112, a * blink)
    ov.rect(bx0, by0, bx1, cy + hbox + 44, 0.55 * a, 1)
    put_text(img, 'ELEVATOR T1E3', W / 2, cy + hbox + 66, COND_B, 28, 0.3, 0.95 * a, 'mt')
    put_text(img, 'LEVEL 01  →  LEVEL 02', W / 2, cy + hbox + 104, MONO_SB, 15, 0.2, 0.7 * a, 'mt')


def cam_l2(t):
    a = camp(ELEV[0], ELEV[1], ride_zoom(t), yaw=-10.0)
    b = camp(960, 645, 1.06, yaw=0.0)
    if t < T_L2 + 0.05:
        u = e_out_expo(seg(t, 3.80, T_L2 + 0.05))
        p = cam_lerp(a, b, u)
        p['s'] = ride_zoom(t)
        return p
    c = camp(990, 640, 1.12, yaw=1.2)
    return cam_lerp(b, c, e_io_cubic(seg(t, T_L2 + 0.05, T_MORPH + 0.5)))


def s_level2(t, img, ov, show_lines=True):
    cam = make_cam(cam_l2(t))
    lv = LV[2]
    base = warp_tex(lv.full, cam)
    if 'closetex2' in D and cam.F / cam.dist > 3:
        base = with_closeup(base, 'closetex2', cam)
    src = boost(base, 0.82)
    led, dens = plan_led(src)
    # scan bar: dots above the bar become linework
    ys = (H + 120) * e_io_cubic(seg(t, 4.12, 4.86)) - 60
    yy = np.arange(H, dtype=np.float32)[:, None]
    above = np.clip((ys - yy) / 30.0, 0, 1)
    led_amt = 1 - 0.82 * above
    np.maximum(img, led * led_amt, out=img)
    if show_lines:
        np.maximum(img, src * above, out=img)
    if 4.10 < t < 4.92:
        # the scan line itself + trailing sheen
        trail = np.exp(-np.clip(ys - yy, 0, None) / 55.0) * (yy < ys) * 0.22
        img += trail * src * 2.0
        if UI.on:
            yprev = (H + 120) * e_io_cubic(seg(t - 1.0 / FPS, 4.12, 4.86)) - 60
            L = ys - yprev
            y0, y1 = int(max(0, ys - L)), int(min(H, ys))
            if L > 2 and y1 > y0:
                g = (np.arange(y0, y1, dtype=np.float32) - (ys - L)) / L
                np.maximum(UI.img[y0:y1], (0.30 * g * g)[:, None], out=UI.img[y0:y1])
            UI.ov.line((0, ys), (W, ys), 0.95, 2)
            pct = int(100 * clamp01(ys / H))
            put_text(UI.img, f'SCAN  {pct:03d}%', W - 80, ys - 22, MONO_SB, 13, 0.16, 0.9, 'rt')
    if show_lines:
        cf = lambda tt: make_cam(cam_l2(tt))
        callout(img, ov, cam, t, 4.92, 'C-SECT 1', 'T2501', anchor=(1165, 640), side=1, camf=cf)
        callout(img, ov, cam, t, 5.26, 'LDR 5', 'T2325', anchor=(987, 373), side=-1, up=-1, camf=cf)
        callout(img, ov, cam, t, 5.60, 'NICU', 'T2105', anchor=(198, 790), side=1, camf=cf)
    return cam, src, dens


def cam_l3(t):
    b = camp(990, 640, 1.12, yaw=1.2)
    c = camp(1150, 662, 1.20, yaw=0.0)
    return cam_lerp(b, c, e_io_cubic(seg(t, T_MORPH + 0.1, T_STACK)))


def s_morph(t, img, ov):
    """In-place LED re-render: Level 2 dots flip to Level 3 along a diagonal wave."""
    cam = make_cam(cam_l3(t))
    s2 = boost(warp_tex(LV[2].full, cam), 0.82)
    s3 = boost(warp_tex(LV[3].full, cam), 0.82)
    d2 = led_density(s2, Q, 1.9, 0.9)
    d3 = led_density(s3, Q, 1.9, 0.9)
    ccx, ccy = cell_centers(Q)
    w = (ccx + 0.55 * ccy) / (W + 0.55 * H)
    ts = T_MORPH + 0.08 + 0.30 * w
    x = (t - ts) / 0.06
    dip = np.clip(np.abs(x), 0, 1)
    d = np.where(t < ts, d2, d3) * dip
    level = 1 + 1.4 * np.exp(-(x * 1.2) ** 2)
    np.maximum(img, led_from_density(d, Q, 0.5, 0.05, level), out=img)
    # L2 lines fade out first, L3 lines resolve at the end with a flicker
    l2 = 1 - e_out_cubic(seg(t, T_MORPH, T_MORPH + 0.14))
    np.maximum(img, s2 * l2, out=img)
    u3 = seg(t, T_MORPH + 0.36, T_L3 + 0.06)
    if u3 > 0:
        fr = tick()
        flick = 1.0 if u3 >= 1 else (0.25 + 0.75 * hash01(fr, 5))
        np.maximum(img, s3 * u3 * flick, out=img)
    return cam


def s_level3(t, img, ov):
    cam = make_cam(cam_l3(t))
    src = boost(warp_tex(LV[3].full, cam), 0.82)
    led, dens = plan_led(src)
    np.maximum(img, led * 0.16, out=img)
    np.maximum(img, src, out=img)
    # room chase
    ids = warp_field(D['room_id'], 1.5, cam, interp=cv2.INTER_NEAREST, border=0, cells=Q)
    t0, step = 6.78, 0.038
    order = np.arange(1, 31)
    ti = t0 + (order - 1) * step
    dt = t - ti
    attack = np.clip(dt / 0.03, 0, 1)
    decay = np.exp(-np.clip(dt, 0, None) / 0.20)
    icu = np.isin(order, list(assets.ICU_ROOMS))
    hold_icu = icu * 0.42 * smoothstep(0.0, 0.12, dt) * (1 - smoothstep(0, 0.4, t - 8.35))
    b = np.where(dt >= 0, np.maximum(attack * decay, hold_icu), 0.0)
    pulse = 0.0
    if t > 8.05:
        pulse = 0.35 * (0.5 + 0.5 * math.sin((t - 8.05) * 18)) * (1 - seg(t, 8.35, 8.6))
    lut = np.zeros(256, np.float32)
    lut[1:31] = b + icu * pulse
    cb = lut[ids]
    head = np.clip((cb - 0.55) / 0.45, 0, 1)
    np.maximum(img, led_from_density(np.clip(cb * 1.05, 0, 1), Q, 0.5, 0.05, 0.95 + 0.45 * head), out=img)
    # counter
    lit = int(np.sum(dt >= 0))
    if t > t0 - 0.05 and UI.on:
        img = UI.img
        fr = tick()
        a = seg(t, t0 - 0.05, t0 + 0.1) * (1 - seg(t, 8.45, 8.62))
        y = 80 + 49 + 62
        put_text(img, 'PATIENT ROOMS', 73, y, MONO_SB, 13, 0.18, 0.7 * a)
        num = dm_text_image(f'{max(lit, 1):02d}', 5, t_rel=10, off_level=0.1)
        blit_max(img, num, 73, y + 22, a)
        if t > 8.0:
            ua = seg(t, 8.0, 8.25)
            num2 = dm_text_image('14', 5, t_rel=(t - 8.0), dur_per_char=0.05, frame=fr, off_level=0.1)
            blit_max(img, num2, 73 + 90, y + 22, a * ua)
            put_text(img, typeon('ICU', ua), 73 + 90, y, MONO_SB, 13, 0.18, 0.7 * a)
    return cam

# --------------------------------------------------------------------------- stack
STACK_ORDER = [1, 2, 3, 4, 5]
GAP = 190.0
FLY = {2: (8.70, -1), 4: (8.78, 1), 1: (8.86, -1), 5: (8.94, 1), 3: (8.60, 0)}
STACK_LABEL = {1: ('01', 'EMERGENCY · LOBBY'), 2: ('02', 'LABOR & DELIVERY · NICU'),
               3: ('03', 'PATIENT CARE · ICU'), 4: ('PH', 'PENTHOUSE · MEP'), 5: ('RF', 'ROOF')}


def stack_state(t):
    """Camera + spread for the exploded axonometric."""
    top = camp(1150, 662, 1.20, yaw=0.0, pitch=0.0, fov=18.0, z=0.0)
    tilt = camp(930, 668, 0.665, yaw=-34.0, pitch=57.0, fov=34.0, z=-25.0)
    orbit = camp(945, 668, 0.70, yaw=-17.0, pitch=50.0, fov=34.0, z=-25.0)
    ph = camp(925, 705, 1.52, yaw=0.0, pitch=0.0, fov=18.0, z=0.0)
    if t < 9.36:
        u = e_io_cubic(seg(t, T_STACK, 9.36))
        p = cam_lerp(top, tilt, u)
        spread = e_out_cubic(seg(t, T_STACK + 0.05, 9.4))
        ref = 3
    elif t < 10.82:
        u = e_io_cubic(seg(t, 9.36, 10.82))
        p = cam_lerp(tilt, orbit, u)
        spread = 1.0
        ref = 3
    else:
        u = e_io_quint(seg(t, 10.82, T_PH))
        p = cam_lerp(orbit, ph, u)
        spread = 1 - u
        ref = 4
    return p, spread, ref, u


def cam_stack(t):
    p, spread, ref, u = stack_state(t)
    if ref == 4:
        p['z'] = lerp(-25.0, 0.0, u)
    return p


def level_z(n, spread, ref_blend):
    idx = STACK_ORDER.index(n)
    ref = lerp(STACK_ORDER.index(3), STACK_ORDER.index(4), ref_blend)
    return (idx - ref) * GAP * spread


def s_stack(t, img, ov):
    p, spread, ref, u = stack_state(t)
    ref_blend = u if ref == 4 else 0.0
    # camera target height follows the reference slab while collapsing
    if ref == 4:
        p['z'] = lerp(-25.0, 0.0, u)
    cam = make_cam(p)
    order = sorted(STACK_ORDER, key=lambda n: STACK_ORDER.index(n))
    zs = {}
    for n in order:
        t_in, sgn = FLY[n]
        a = e_out_cubic(seg(t, t_in, t_in + 0.42)) if n != 3 else 1.0
        dz = (1 - e_out_expo(seg(t, t_in, t_in + 0.55))) * 520 * sgn if n != 3 else 0.0
        if ref == 4 and n != 4:
            a *= 1 - e_in_cubic(seg(t, 10.95, 11.30))
        z = level_z(n, spread, ref_blend) + dz
        zs[n] = (z, a)
        if a <= 0.001:
            continue
        st = STACK[n]
        slab = warp_tex(st['slab'], cam, z)
        lines = warp_tex(st['lines'], cam, z)
        edge = warp_tex(st['edge'], cam, z)
        img *= (1 - 0.9 * slab * a)
        tone = 0.05 * slab * a
        np.maximum(img, tone, out=img)
        np.maximum(img, boost(lines, 0.75) * a * (0.95 if n != 4 else 1.0), out=img)
        np.maximum(img, edge * 0.85 * a, out=img)
    led, _ = plan_led(img, 1.5, 1.0)
    np.maximum(img, led * 0.22, out=img)
    # risers through XT1 / XT3 (Level 2 up to the roof) + elevator core
    ru = e_out_cubic(seg(t, 9.25, 9.85)) * (1 - seg(t, 10.8, 11.05))
    if ru > 0:
        z2, zr = zs[2][0], zs[5][0] + 60 * spread
        for (px, py) in (assets.SHAFT_XT1, assets.SHAFT_XT3):
            a0 = scr(cam, px, py, z2)
            ztop = lerp(z2, zr, ru)
            a1 = scr(cam, px, py, ztop)
            ov.line(a0, a1, 0.95, 2)
            for k in range(10):
                ph = ((t * 0.55 + k / 10.0) % 1.0)
                zz = lerp(z2, zr, ph)
                if zz <= ztop:
                    q = scr(cam, px, py, zz)
                    ov.disk(q, 3.2, 1.0)
                    q2 = scr(cam, px, py, zz - 16)
                    ov.disk(q2, 1.8, 0.5)
            ov.circle(a0, 7, 0.8, 1)
            if ru >= 1:
                ov.circle(a1, 7 + 3 * math.sin(t * 9), 0.8, 1)
        # elevator core (Level 1 to penthouse): four dotted verticals
        z1, zp = zs[1][0], zs[4][0]
        x0, y0, x1, y1 = 506, 660, 578, 726
        for (px, py) in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
            a0 = scr(cam, px, py, z1)
            a1 = scr(cam, px, py, lerp(z1, zp, ru))
            ov.dashed(a0, a1, 0.45, 4, 5, 1)
    # level labels
    lab_u = seg(t, 9.30, 9.9)
    lab_out = seg(t, 10.78, 10.98)
    if lab_u > 0 and lab_out < 1 and UI.on:
        img, ov = UI.img, UI.ov
        fr = tick()
        for i, n in enumerate([5, 4, 3, 2, 1]):
            z, a = zs[n]
            li = seg(t, 9.30 + i * 0.07, 9.62 + i * 0.07)
            if li <= 0:
                continue
            anc = scr(cam, 1762, 470 if n != 4 else 520, z)
            x_lab = W - 405
            y_lab = anc[1]
            fade = (1 - lab_out) * a
            end = (x_lab - 16, y_lab)
            draw_line_partial(ov, [anc, end], e_out_expo(li), 0.7 * fade, 1)
            ov.disk(anc, 3.0 * e_out_back(li), fade)
            code, name = STACK_LABEL[n]
            im = dm_text_image(code, 4, t_rel=(t - 9.30 - i * 0.07), dur_per_char=0.05, frame=fr, off_level=0.0)
            blit_max(img, im, x_lab, y_lab - im.shape[0] / 2, fade)
            put_text(img, scramble_text(name, li * 1.3, fr, i), x_lab + 54, y_lab - 11, COND_B, 20, 0.12, 0.95 * fade)
    return cam

# --------------------------------------------------------------------------- penthouse + roof
CAM_PH_A = camp(925, 705, 1.52)
CAM_PH_B = camp(945, 700, 1.64, yaw=-1.2)


def cam_ph(t):
    return cam_lerp(CAM_PH_A, CAM_PH_B, e_io_cubic(seg(t, T_PH, T_RF)))


def s_penthouse(t, img, ov):
    cam = make_cam(cam_ph(t))
    src = boost(warp_tex(LV[4].full, cam), 0.82)
    led, dens = plan_led(src)
    np.maximum(img, led * 0.16, out=img)
    np.maximum(img, src * 0.92, out=img)
    # ductwork: bright banding + airflow particles along the centrelines
    solid = warp_field(D['duct_solid'], 1.5, cam, border=0.0)
    dd = warp_field(D['duct_dist'], 1.5, cam, interp=cv2.INTER_NEAREST, border=-1.0)
    edge = cv2.morphologyEx((solid > 0.5).astype(np.uint8), cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)).astype(np.float32)
    du = e_out_cubic(seg(t, T_PH + 0.02, T_PH + 0.3))
    fill = led_from_density(led_density(solid, Q, 1.0, 1.0) * 0.55, Q, 0.5, 0.05)
    np.maximum(img, fill * du, out=img)
    np.maximum(img, edge * du, out=img)
    ph = ((dd - 150 * (t - T_PH)) / 26.0) % 1.0
    parts = ((dd >= 0) & (ph < 0.22)).astype(np.float32)
    parts = cv2.dilate(parts, np.ones((3, 3), np.uint8))
    np.maximum(img, parts * 1.4 * du, out=img)
    cf = lambda tt: make_cam(cam_lerp(CAM_PH_A, CAM_PH_B, e_io_cubic(seg(tt, T_PH, T_RF))))
    callout(img, ov, cam, t, T_PH + 0.12, 'DOMESTIC HOT WATER HEATERS', 'T4040', anchor=(773, 830), side=-1, up=-1, life=0.95, camf=cf)
    callout(img, ov, cam, t, T_PH + 0.36, 'MED GAS EQPT', 'T4020', anchor=(897, 815), side=1, up=-1, life=0.75, camf=cf)
    callout(img, ov, cam, t, T_PH + 0.58, 'RO', 'T4030', anchor=(1025, 828), side=1, life=0.52, camf=cf)
    callout(img, ov, cam, t, T_PH + 0.28, 'MAIN EMERGENCY ELEC', 'T4010', anchor=(755, 672), side=1, life=0.8, camf=cf)
    return cam


CAM_RF_A = camp(930, 650, 1.02)
CAM_RF_B = camp(960, 640, 1.16, yaw=0.8)


def cam_rf(t):
    return cam_lerp(CAM_RF_A, CAM_RF_B, e_out_cubic(seg(t, T_RF, T_OUT + 0.1)))


def s_roof(t, img, ov, only_dens=False):
    cam = make_cam(cam_rf(t))
    src = boost(warp_tex(LV[5].full, cam), 0.82)
    dens = led_density(src, Q, 1.9, 0.9)
    # storm-drain ripples converging on the drains (LED cells)
    dd = warp_field(D['drain_dist'], 1.0, cam, border=-1.0, cells=Q)
    ph = (dd / 30.0 + 2.1 * (t - T_RF)) % 1.0
    ring = np.exp(-((ph - 0.5) / 0.09) ** 2) * (dd >= 0) * np.exp(-np.clip(dd, 0, None) / 170.0)
    ru = e_out_cubic(seg(t, T_RF + 0.04, T_RF + 0.35))
    d_all = np.clip(np.maximum(dens * 0.2, ring * 0.9 * ru), 0, 1)
    if only_dens:
        return cam, dens, ring * ru
    np.maximum(img, led_from_density(d_all, Q, 0.5, 0.05), out=img)
    np.maximum(img, src * 0.9, out=img)
    for (x, y) in assets.DRAINS:
        p = scr(cam, x, y)
        k = ((t - T_RF) * 2.1) % 1.0
        ov.circle(p, 4 + 14 * (1 - k), 0.8 * ru * k, 1)
    return cam

# --------------------------------------------------------------------------- outro particles
PART = {}


def init_outro():
    """Every lit LED of the tagline gets one flyer, launched from a roof LED dot;
    the roof's other dots dissolve where they are."""
    cam, dens, ring = s_roof(T_OUT, None, None, only_dens=True)
    d = np.maximum(dens, ring)
    p = 16
    tg = []
    for li, line in enumerate(TAGLINE):
        g = mg.dm_grid(line)
        wline = g.shape[1] * p
        x0 = W / 2 - wline / 2
        y0 = H / 2 - 7 * p - 22 + li * (7 * p + 44)
        yy, xx = np.nonzero(g)
        tg.append(np.stack([x0 + (xx + 0.5) * p, y0 + (yy + 0.5) * p], 1))
    tgt = np.concatenate(tg).astype(np.float32)
    ys, xs = np.nonzero(d > 0.22)
    allp = np.stack([(xs + 0.5) * Q, (ys + 0.5) * Q], 1).astype(np.float32)
    order = np.argsort(allp[:, 0] + 0.25 * allp[:, 1])
    pick = order[np.linspace(0, len(order) - 1, len(tgt)).astype(int)]
    src = allp[pick]
    rsrc = (d[ys[pick], xs[pick]] * 0.5 * Q).astype(np.float32)
    to = np.argsort(tgt[:, 0] + 0.25 * tgt[:, 1])
    rng = np.random.default_rng(7)
    ctrl = (src + tgt[to]) / 2 + rng.normal(0, 60, src.shape).astype(np.float32)
    ctrl[:, 1] -= 90 * np.sin(np.linspace(0, np.pi, len(src)))       # a gentle arc
    delay = (0.05 + 0.30 * src[:, 0] / W + 0.04 * rng.random(len(src))).astype(np.float32)
    # roof cells that do not fly dissolve with a random stagger; flyers' cells go dark on launch
    fade_t = (0.02 + 0.28 * rng.random(d.shape)).astype(np.float32)
    launch = np.full(d.shape, 9.0, np.float32)
    launch[ys[pick], xs[pick]] = delay
    PART.update(src=src, rsrc=rsrc, tgt=tgt[to], ctrl=ctrl, delay=delay, p=p, all_tgt=tgt,
                dens=d.astype(np.float32), fade_t=fade_t, launch=launch)


def s_outro(t, img, ov):
    P = PART
    u = t - T_OUT
    # the roof plan dissolves away as its dots lift off
    if u < 0.3:
        cam = make_cam(cam_rf(t))
        src_img = boost(warp_tex(LV[5].full, cam), 0.82)
        np.maximum(img, src_img * 0.9 * (1 - e_out_cubic(seg(u, 0, 0.22))), out=img)
    p = P['p']
    tgt = P['all_tgt']
    collapse = e_in_quart(seg(t, 14.42, 14.93))
    center = np.array([W / 2, H / 2], np.float32)
    if u < 0.45:
        k = np.clip((u - P['fade_t']) / 0.16, 0, 1)
        dd = P['dens'] * (1 - k * k) * (u < P['launch'])
        np.maximum(img, led_from_density(dd, Q, 0.5, 0.05), out=img)
    if u < 0.95:
        a, c, b = P['src'], P['ctrl'], P['tgt']

        def fly(uu, lag):
            k = (uu - lag - P['delay']) / 0.52
            kk = np.clip(k, 0, 1)
            kk = kk * kk * (3 - 2 * kk)
            k2 = kk[:, None]
            pos = (1 - k2) ** 2 * a + 2 * (1 - k2) * k2 * c + k2 ** 2 * b
            return k, pos, (1 - kk) * P['rsrc'] + kk * 0.42 * p

        for lag, lvl, rs in ((0.0, 1.0, 1.0), (0.035, 0.5, 0.75), (0.07, 0.25, 0.55)):
            k, pos, r = fly(u, lag)
            _, p0, _ = fly(u - SHUTTER / 2, lag)
            _, p1, _ = fly(u + SHUTTER / 2, lag)
            for i in range(len(k)):
                kv = k[i]
                if (lag > 0 and (kv <= 0 or kv >= 1)) or (lag == 0 and kv < 0):
                    continue
                rr = max(r[i] * rs, 0.7)
                L = float(np.hypot(*(p1[i] - p0[i])))
                if L < 1.0:
                    ov.disk(pos[i], rr, lvl)
                else:                           # motion-blurred streak, energy roughly kept
                    v = lvl * max(0.35, min(1.0, math.sqrt((2 * rr + 1) / (L + 2 * rr + 1))))
                    ov.capsule(p0[i], p1[i], rr, v)
    # tagline LED text (crisp) takes over once the swarm lands
    ta = seg(u, 0.62, 0.8)
    if ta <= 0:
        return None
    tag = np.zeros((H, W), np.float32)
    for li, line in enumerate(TAGLINE):
        im = dm_text_image(line, p, t_rel=10, off_level=0.12)
        x0 = W / 2 - im.shape[1] / 2
        y0 = H / 2 - 7 * p - 22 + li * (7 * p + 44)
        blit_max(tag, im, x0, y0, ta)
    sa = seg(u, 0.72, 0.95)
    tov = Overlay()
    if sa > 0:
        put_text(tag, PROJECT, W / 2, H / 2 - 7 * p - 96, COND_B, 30, 0.5, sa, 'mt')
        wl = 120 * e_out_expo(sa)
        tov.line((W / 2 - wl, H / 2 + 7 * p + 72), (W / 2 + wl, H / 2 + 7 * p + 72), 0.5 * sa, 1)
        put_text(tag, 'MECHANICAL  ·  HVAC  ·  PLUMBING', W / 2, H / 2 + 7 * p + 90, MONO_SB, 18, 0.24,
                 0.85 * sa, 'mt')
    np.maximum(tag, tov.f(), out=tag)
    # CRT power-off: squash to a bright scan line, shrink the line to a dot.
    # The loop then opens by powering the same dot back on.
    sq = e_in_cubic(seg(t, 14.50, 14.70))
    sh = e_in_quart(seg(t, 14.70, 14.88))
    if sq <= 0:
        np.maximum(img, tag, out=img)
        return None
    y0b, y1b = int(H / 2 - 7 * p - 110), int(H / 2 + 7 * p + 130)
    x0b, x1b = int(W / 2 - 760), int(W / 2 + 760)
    block = tag[y0b:y1b, x0b:x1b]
    bh = max(2, int(round(block.shape[0] * (1 - 0.99 * sq))))
    bw = max(10, int(round(block.shape[1] * (1 - 0.993 * sh))))
    sm = cv2.resize(block, (block.shape[1], bh), interpolation=cv2.INTER_AREA)
    if bh <= 6:
        # collapsed to a line: the whole row lights up like a CRT trace
        prof = np.clip(sm.max(axis=0, keepdims=True) * 0.4 + 0.9 * sq, 0, 1)
        sm = np.repeat(prof, bh, 0)
    sm = cv2.resize(sm, (bw, bh), interpolation=cv2.INTER_AREA) * (1 + 1.2 * sq)
    blit_max(img, np.clip(sm, 0, 1.6), W / 2 - bw / 2, H / 2 - bh / 2)
    if sh > 0.85:
        ov.disk((W / 2, H / 2), 5.0 + 3.0 * (1 - seg(t, 14.86, 14.92)), 1.0)
    return None


# --------------------------------------------------------------------------- frame assembly
def render_raw(t, ui=True):
    """World layer at time t (linear, pre-finishing); with ui=True also the UI layer."""
    UI.begin(ui)
    img = np.zeros((H, W), np.float32)
    ov = Overlay()
    cam = None
    bgamt = 1.0
    if t < T_L1:
        cam = s_ignite(t, img, ov)
    elif t < T_RIDE:
        cam = s_level1(t, img, ov)
    elif t < T_L2:
        if t < 3.66:
            cam = s_ride_in(t, img, ov)
        if t >= 3.80:
            cam, _, _ = s_level2(t, img, ov, show_lines=False)
        s_shaft(t, img, ov)
        bgamt = 0.5
    elif t < T_MORPH:
        cam, _, _ = s_level2(t, img, ov)
    elif t < T_L3:
        cam = s_morph(t, img, ov)
    elif t < T_STACK:
        cam = s_level3(t, img, ov)
    elif t < T_PH:
        cam = s_stack(t, img, ov)
        bgamt = 0.6
    elif t < T_RF:
        cam = s_penthouse(t, img, ov)
    elif t < T_OUT:
        cam = s_roof(t, img, ov)
    else:
        s_outro(t, img, ov)
        bgamt = 1 - seg(t, 14.3, 14.9)
    if t >= T_L1:
        g = bg_grid(t, bgamt)
        if g is not None:
            np.maximum(img, g, out=img)
    hud(img, ov, t, cam)
    np.maximum(img, ov.f(), out=img)
    return img, ((UI.img, UI.mul, UI.ov.f()) if ui else None)


def cam_at(t):
    """World camera at time t without drawing anything (for motion-blur planning)."""
    if t < 0.26 or t >= T_OUT + 0.3:
        return None
    if t < T_RIDE:
        return make_cam(cam_l1(t))
    if t < T_L2:
        if t < 3.66:
            return make_cam(cam_ride(t))
        return make_cam(cam_l2(t)) if t >= 3.80 else None
    if t < T_MORPH:
        return make_cam(cam_l2(t))
    if t < T_STACK:
        return make_cam(cam_l3(t))
    if t < T_PH:
        return make_cam(cam_stack(t))
    if t < T_RF:
        return make_cam(cam_ph(t))
    return make_cam(cam_rf(t))


_SGRID = np.stack(np.meshgrid(np.linspace(0, W, 13), np.linspace(0, H, 7)), -1).reshape(-1, 2)


def motion_px(t):
    """Largest screen travel (px) of the world during one shutter interval."""
    ta, tb = t - SHUTTER / 2, t + SHUTTER / 2
    if t < T_RF <= tb:
        tb = T_RF - 1e-4                          # same clamp as render_frame: no blur across the cut
    elif ta < T_RF <= t:
        ta = T_RF
    c, c0, c1 = cam_at(t), cam_at(ta), cam_at(tb)
    if c is None or c0 is None or c1 is None:
        return 0.0
    zs = (0.0,) if not (T_STACK <= t < T_PH) else (-2 * GAP, 0.0, 2 * GAP)
    best = 0.0
    for z in zs:
        Hc = c.plane_H(1.0, (0, 0), z, CENTER)
        Pp = np.hstack([_SGRID, np.ones((len(_SGRID), 1))]) @ np.linalg.inv(Hc).T
        ok = np.abs(Pp[:, 2]) > 1e-9
        Pp = Pp[ok] / Pp[ok, 2:3]
        q = []
        for cc in (c0, c1):
            r = Pp @ cc.plane_H(1.0, (0, 0), z, CENTER).T
            q.append((r[:, :2] / r[:, 2:3], r[:, 2]))
        good = (q[0][1] > 0) & (q[1][1] > 0)
        if good.any():
            best = max(best, float(np.max(np.linalg.norm(q[0][0][good] - q[1][0][good], axis=1))))
    return best


MIN_SAMPLES = ((0.26, 0.70, 3), (3.42, 3.67, 11), (3.79, 4.02, 11), (4.12, 4.88, 5),
               (8.60, 9.50, 5), (10.95, 11.36, 3), (14.48, 14.90, 3))


def sample_count(t):
    """Odd number of shutter samples: enough that the world never moves more than
    ~2.5 px between sub-frames (so linework smears instead of doubling)."""
    n = int(math.ceil(motion_px(t) / 2.5)) + 1 if motion_px(t) > 1.2 else 1
    for a, b, k in MIN_SAMPLES:
        if a < t < b:
            n = max(n, k)
    n = min(n, 15)
    return n if n % 2 else n + 1


def finish(img, fi, t):
    out = glow(img, 0.5)
    # accents: a white flash inside the elevator, a glitch + inversion into the roof
    if abs(t - 3.6333) < 0.5 / FPS or abs(t - 3.8) < 0.5 / FPS:
        out = out * 0.55 + 0.45
    if T_RF - 0.05 <= t < T_RF + 0.06:
        rng = np.random.default_rng(fi * 13 + 1)
        g = out.copy()
        for _ in range(16):
            y0 = int(rng.integers(0, H - 10)); h = int(rng.integers(4, 90))
            dx = int(rng.normal(0, 140))
            g[y0:y0 + h] = np.roll(out[y0:y0 + h], dx, axis=1)
        out = g
        if abs(t - T_RF) < 0.5 / FPS:
            out = 1.0 - np.clip(out, 0, 1)
    out = vignette(out, 0.18)
    out = grain(out, 0, 0.006)
    out = np.clip(out / (1 + 0.12 * np.maximum(out - 0.8, 0)), 0, 1)
    return (out * 255 + 0.5).astype(np.uint8)


def render_frame(fi):
    t = fi / FPS
    TICK[0] = int(round(t * 60))
    n = sample_count(t)
    offs = np.linspace(-SHUTTER / 2, SHUTTER / 2, n) if n > 1 else np.zeros(1)
    offs[n // 2] = 0.0
    acc = np.zeros((H, W), np.float32)
    ui = None
    for k, o in enumerate(offs):
        ts = t + o
        if t < T_RF <= ts:                       # never blur across the hard cut into the roof
            ts = T_RF - 1e-4
        elif ts < T_RF <= t:
            ts = T_RF
        world, u = render_raw(ts, ui=(k == n // 2))
        acc += world
        if u is not None:
            ui = u
    acc /= n
    uimg, umul, uov = ui
    out = np.maximum(acc * umul, uimg)
    np.maximum(out, uov, out=out)
    return finish(out, fi, t)

# --------------------------------------------------------------------------- output
def ffmpeg_exe():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def encode(frames_iter, path, n):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cmd = [ffmpeg_exe(), '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'gray',
           '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
           '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
           '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1',
           '-x264-params', f'keyint={FPS}:min-keyint={FPS}', '-movflags', '+faststart', path]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    raw = open(os.environ['RAW_OUT'], 'wb') if os.environ.get('RAW_OUT') else None
    t0 = time.time()
    for i, fr in enumerate(frames_iter):
        p.stdin.write(fr.tobytes())
        if raw:
            raw.write(fr.tobytes())
        if i % 30 == 0:
            el = time.time() - t0
            print(f'  frame {i:4d}/{n}  {el:6.1f}s', flush=True)
    p.stdin.close()
    p.wait()
    if raw:
        raw.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--still', type=float, nargs='+')
    ap.add_argument('--clip', type=float, nargs=2)
    ap.add_argument('--out')
    ap.add_argument('--jobs', type=int, default=os.cpu_count())
    a = ap.parse_args()
    load()
    if a.still:
        for tt in a.still:
            fi = int(round(tt * FPS))
            fr = render_frame(fi)
            path = a.out or os.path.join(OUT, 'stills', f'still_{tt:05.2f}.png')
            if len(a.still) > 1:
                path = os.path.join(os.path.dirname(path), f'still_{tt:05.2f}.png')
            os.makedirs(os.path.dirname(path), exist_ok=True)
            cv2.imwrite(path, fr)
            print(path)
        return
    f0, f1 = (int(round(a.clip[0] * FPS)), int(round(a.clip[1] * FPS))) if a.clip else (0, NF)
    path = a.out or (os.path.join(OUT, 'clip.mp4') if a.clip else os.path.join(HERE, 'mih_tower_loop_1080p30.mp4'))
    idx = list(range(f0, f1))
    if a.jobs > 1:
        import multiprocessing as mp
        with mp.get_context('fork').Pool(a.jobs) as pool:
            encode(pool.imap(render_frame, idx, chunksize=2), path, len(idx))
    else:
        encode(map(render_frame, idx), path, len(idx))
    print(path)


if __name__ == '__main__':
    main()
