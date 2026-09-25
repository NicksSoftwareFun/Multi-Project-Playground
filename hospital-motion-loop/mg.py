"""
Motion-graphics toolkit: easing, LED dot-matrix type, halftone, camera/plane
projection, overlay drawing, and finishing (glow, grain).

Frames are single-channel float32 in [0, 1] - the piece is strictly black & white.
"""
import os, math, functools
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
FPS = 30
HERE = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = os.path.join(HERE, 'fonts')

# --------------------------------------------------------------------------- easing
def clamp01(x):
    return min(1.0, max(0.0, x))

def seg(t, a, b):
    """0..1 progress of t through [a, b]."""
    return clamp01((t - a) / (b - a)) if b > a else float(t >= a)

def lerp(a, b, u):
    return a + (b - a) * u

def e_out_cubic(u):  return 1 - (1 - u) ** 3
def e_in_cubic(u):   return u ** 3
def e_io_cubic(u):   return 4 * u ** 3 if u < 0.5 else 1 - (-2 * u + 2) ** 3 / 2
def e_out_quart(u):  return 1 - (1 - u) ** 4
def e_in_quart(u):   return u ** 4
def e_io_quint(u):   return 16 * u ** 5 if u < 0.5 else 1 - (-2 * u + 2) ** 5 / 2
def e_out_expo(u):   return 1.0 if u >= 1 else 1 - 2 ** (-10 * u)
def e_in_expo(u):    return 0.0 if u <= 0 else 2 ** (10 * u - 10)
def e_io_expo(u):
    if u <= 0: return 0.0
    if u >= 1: return 1.0
    return 2 ** (20 * u - 10) / 2 if u < 0.5 else (2 - 2 ** (-20 * u + 10)) / 2
def e_out_back(u, s=1.70158):
    u -= 1
    return u * u * ((s + 1) * u + s) + 1
def e_spring(u, k=7.0, damp=4.5):
    """Critically-underdamped settle from 0 to 1 with one soft overshoot."""
    if u <= 0: return 0.0
    return 1 - math.exp(-damp * u) * math.cos(k * u)

def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)

def hash01(*xs):
    """Deterministic pseudo-random in [0,1) from integers."""
    h = 2166136261
    for x in xs:
        h = ((h ^ (int(x) & 0xffffffff)) * 16777619) & 0xffffffff
    h ^= h >> 13; h = (h * 0x5bd1e995) & 0xffffffff; h ^= h >> 15
    return (h & 0xffffff) / float(0x1000000)

# --------------------------------------------------------------------------- 5x7 LED font
_GLYPHS = {
 'A': ".###.|#...#|#...#|#####|#...#|#...#|#...#",
 'B': "####.|#...#|#...#|####.|#...#|#...#|####.",
 'C': ".###.|#...#|#....|#....|#....|#...#|.###.",
 'D': "###..|#..#.|#...#|#...#|#...#|#..#.|###..",
 'E': "#####|#....|#....|####.|#....|#....|#####",
 'F': "#####|#....|#....|####.|#....|#....|#....",
 'G': ".###.|#...#|#....|#.###|#...#|#...#|.####",
 'H': "#...#|#...#|#...#|#####|#...#|#...#|#...#",
 'I': ".###.|..#..|..#..|..#..|..#..|..#..|.###.",
 'J': "..###|...#.|...#.|...#.|...#.|#..#.|.##..",
 'K': "#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#",
 'L': "#....|#....|#....|#....|#....|#....|#####",
 'M': "#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#",
 'N': "#...#|#...#|##..#|#.#.#|#..##|#...#|#...#",
 'O': ".###.|#...#|#...#|#...#|#...#|#...#|.###.",
 'P': "####.|#...#|#...#|####.|#....|#....|#....",
 'Q': ".###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#",
 'R': "####.|#...#|#...#|####.|#.#..|#..#.|#...#",
 'S': ".####|#....|#....|.###.|....#|....#|####.",
 'T': "#####|..#..|..#..|..#..|..#..|..#..|..#..",
 'U': "#...#|#...#|#...#|#...#|#...#|#...#|.###.",
 'V': "#...#|#...#|#...#|#...#|#...#|.#.#.|..#..",
 'W': "#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.",
 'X': "#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#",
 'Y': "#...#|#...#|#...#|.#.#.|..#..|..#..|..#..",
 'Z': "#####|....#|...#.|..#..|.#...|#....|#####",
 '0': ".###.|#...#|#..##|#.#.#|##..#|#...#|.###.",
 '1': "..#..|.##..|..#..|..#..|..#..|..#..|.###.",
 '2': ".###.|#...#|....#|...#.|..#..|.#...|#####",
 '3': "#####|...#.|..#..|...#.|....#|#...#|.###.",
 '4': "...#.|..##.|.#.#.|#..#.|#####|...#.|...#.",
 '5': "#####|#....|####.|....#|....#|#...#|.###.",
 '6': "..##.|.#...|#....|####.|#...#|#...#|.###.",
 '7': "#####|....#|...#.|..#..|.#...|.#...|.#...",
 '8': ".###.|#...#|#...#|.###.|#...#|#...#|.###.",
 '9': ".###.|#...#|#...#|.####|....#|...#.|.##..",
 ' ': ".....|.....|.....|.....|.....|.....|.....",
 '.': ".....|.....|.....|.....|.....|.##..|.##..",
 ',': ".....|.....|.....|.....|.##..|..#..|.#...",
 ':': ".....|.##..|.##..|.....|.##..|.##..|.....",
 '-': ".....|.....|.....|#####|.....|.....|.....",
 '/': ".....|....#|...#.|..#..|.#...|#....|.....",
 '&': ".##..|#..#.|#.#..|.#...|#.#.#|#..#.|.##.#",
 "'": "..#..|..#..|.#...|.....|.....|.....|.....",
 '(': "...#.|..#..|.#...|.#...|.#...|..#..|...#.",
 ')': ".#...|..#..|...#.|...#.|...#.|..#..|.#...",
 '#': ".#.#.|.#.#.|#####|.#.#.|#####|.#.#.|.#.#.",
 '+': ".....|..#..|..#..|#####|..#..|..#..|.....",
 '>': ".#...|..#..|...#.|....#|...#.|..#..|.#...",
 '<': "...#.|..#..|.#...|#....|.#...|..#..|...#.",
 '|': "..#..|..#..|..#..|..#..|..#..|..#..|..#..",
 '·': ".....|.....|.....|..#..|.....|.....|.....",
 '%': "##...|##..#|...#.|..#..|.#...|#..##|...##",
 '^': "..#..|.###.|#.#.#|..#..|..#..|..#..|..#..",
}
GLYPH = {k: np.array([[c == '#' for c in row] for row in v.split('|')], bool)
         for k, v in _GLYPHS.items()}
SCRAMBLE = list('ABCDEFGHJKLMNPRSTUVXYZ0123456789#+/')

def dm_grid(text):
    """Text -> boolean cell grid (7 rows) with 1-cell letter spacing."""
    cols = []
    for i, ch in enumerate(text):
        g = GLYPH.get(ch.upper(), GLYPH[' '])
        cols.append(g)
        if i < len(text) - 1:
            cols.append(np.zeros((7, 1), bool))
    return np.concatenate(cols, axis=1) if cols else np.zeros((7, 0), bool)

def dm_width(text, pitch):
    return (len(text) * 6 - 1) * pitch

@functools.lru_cache(maxsize=64)
def _dist_tile(q):
    yy, xx = np.mgrid[0:q, 0:q].astype(np.float32) + 0.5
    return np.sqrt((xx - q / 2) ** 2 + (yy - q / 2) ** 2)

def dots_from_radii(R, q):
    """Rasterize a grid of dot radii (px) at pitch q into an anti-aliased image."""
    tile = _dist_tile(q)
    D = np.tile(tile, R.shape)
    Rup = np.repeat(np.repeat(R.astype(np.float32), q, 0), q, 1)
    return np.clip(Rup - D + 0.5, 0.0, 1.0)

def dm_text_image(text, pitch, t_rel=1e9, dur_per_char=0.035, scramble=0.12, seed=0,
                  on_r=0.42, off_r=0.16, off_level=0.16, frame=0, reveal='scramble'):
    """Dot-matrix text as a float image (plus 'off' LEDs).

    t_rel: seconds since the text started animating.  Each character resolves at
    i*dur_per_char + scramble; before that it flickers through random glyphs.
    """
    n = len(text)
    chars = []
    for i, ch in enumerate(text):
        start = i * dur_per_char
        if t_rel < start:
            chars.append(' ')
        elif t_rel < start + scramble and ch != ' ':
            k = int(hash01(seed, i, frame // 2) * len(SCRAMBLE))
            chars.append(SCRAMBLE[k])
        else:
            chars.append(ch)
    grid = dm_grid(''.join(chars))
    lit = np.zeros(grid.shape, np.float32)
    # per-character pop (dots swell in)
    x = 0
    for i, ch in enumerate(chars):
        a = seg(t_rel, i * dur_per_char, i * dur_per_char + 0.10)
        s = e_out_back(a, 2.2) if a < 1 else 1.0
        lit[:, x:x + 5] = s
        x += 6
    R_on = grid * lit * on_r * pitch
    img_on = dots_from_radii(R_on, pitch)
    if off_level > 0:
        R_off = (~grid) * off_r * pitch * np.clip(lit, 0, 1)
        img_off = dots_from_radii(R_off, pitch) * off_level
        return np.maximum(img_on, img_off)
    return img_on

# --------------------------------------------------------------------------- text (vector fonts)
@functools.lru_cache(maxsize=32)
def font(name, size):
    return ImageFont.truetype(os.path.join(FONT_DIR, name), size)

MONO = 'IBMPlexMono-Medium.ttf'
MONO_R = 'IBMPlexMono-Regular.ttf'
MONO_SB = 'IBMPlexMono-SemiBold.ttf'
COND = 'IBMPlexSansCondensed-SemiBold.ttf'
COND_B = 'IBMPlexSansCondensed-Bold.ttf'
COND_M = 'IBMPlexSansCondensed-Medium.ttf'

@functools.lru_cache(maxsize=4096)
def text_img(s, fname=MONO, size=16, track=0.0):
    """Anti-aliased text bitmap (float32, 0..1) with letter tracking (em fraction)."""
    f = font(fname, size)
    asc, desc = f.getmetrics()
    adv = [f.getlength(c) + track * size for c in s]
    w = int(math.ceil(sum(adv))) + 4
    h = asc + desc + 2
    im = Image.new('L', (max(w, 1), h), 0)
    d = ImageDraw.Draw(im)
    x = 1.0
    for c, a in zip(s, adv):
        d.text((x, 1), c, font=f, fill=255)
        x += a
    return np.asarray(im, np.float32) / 255.0

def text_width(s, fname=MONO, size=16, track=0.0):
    f = font(fname, size)
    return sum(f.getlength(c) + track * size for c in s)

def typeon(s, u, cursor=True, frame=0):
    """Type-on substring for progress u in [0,1] with a blinking block cursor."""
    n = int(round(len(s) * clamp01(u)))
    out = s[:n]
    if cursor and u < 1.0 and u > 0:
        out += '_' if (frame // 4) % 2 == 0 else ' '
    return out

def scramble_text(s, u, frame, seed=0):
    """Characters resolve left-to-right; unresolved ones flicker."""
    n = len(s)
    res = int(n * clamp01(u))
    out = []
    for i, ch in enumerate(s):
        if i < res or ch == ' ':
            out.append(ch)
        elif i < res + 4:
            out.append(SCRAMBLE[int(hash01(seed, i, frame // 2) * len(SCRAMBLE))])
        else:
            out.append(' ')
    return ''.join(out)

# --------------------------------------------------------------------------- canvas helpers
def blit_max(dst, img, x, y, alpha=1.0):
    """max-composite img (float) into dst at integer top-left (x, y)."""
    x, y = int(round(x)), int(round(y))
    h, w = img.shape
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(dst.shape[1], x + w), min(dst.shape[0], y + h)
    if x1 <= x0 or y1 <= y0:
        return
    sub = img[y0 - y:y1 - y, x0 - x:x1 - x]
    if alpha != 1.0:
        sub = sub * alpha
    np.maximum(dst[y0:y1, x0:x1], sub, out=dst[y0:y1, x0:x1])

def blit_mul(dst, img, x, y, amount=1.0):
    """Knock out dst under img (multiply by 1-img*amount)."""
    x, y = int(round(x)), int(round(y))
    h, w = img.shape
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(dst.shape[1], x + w), min(dst.shape[0], y + h)
    if x1 <= x0 or y1 <= y0:
        return
    sub = img[y0 - y:y1 - y, x0 - x:x1 - x]
    dst[y0:y1, x0:x1] *= (1.0 - sub * amount)

def put_text(dst, s, x, y, fname=MONO, size=16, track=0.0, alpha=1.0, anchor='lt'):
    if not s:
        return 0
    img = text_img(s, fname, size, track)
    w = img.shape[1]
    if anchor[0] == 'r': x -= w
    elif anchor[0] == 'm': x -= w / 2
    if anchor[1] == 'b': y -= img.shape[0]
    elif anchor[1] == 'm': y -= img.shape[0] / 2
    blit_max(dst, img, x, y, alpha)
    return w

class Overlay:
    """uint8 canvas for anti-aliased vector drawing (cv2 AA needs 8-bit)."""
    SH = 4
    def __init__(self):
        self.a = np.zeros((H, W), np.uint8)
    def _p(self, p):
        return (int(round(p[0] * 16)), int(round(p[1] * 16)))
    def line(self, p, q, v=1.0, th=1):
        cv2.line(self.a, self._p(p), self._p(q), int(255 * clamp01(v)), th, cv2.LINE_AA, self.SH)
    def poly(self, pts, v=1.0, th=1, closed=False):
        P = np.round(np.asarray(pts, np.float64) * 16).astype(np.int32)
        cv2.polylines(self.a, [P], closed, int(255 * clamp01(v)), th, cv2.LINE_AA, self.SH)
    def circle(self, c, r, v=1.0, th=1):
        if r <= 0: return
        cv2.circle(self.a, self._p(c), int(round(r * 16)), int(255 * clamp01(v)), th, cv2.LINE_AA, self.SH)
    def disk(self, c, r, v=1.0):
        self.circle(c, r, v, -1)
    def capsule(self, p, q, r, v=1.0):
        """Round-capped stroke: a dot of radius r smeared from p to q."""
        th = max(1, int(round(2 * r)))
        cv2.line(self.a, self._p(p), self._p(q), int(255 * clamp01(v)), th, cv2.LINE_AA, self.SH)
    def rect(self, x0, y0, x1, y1, v=1.0, th=1):
        self.poly([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], v, th, True)
    def fill_rect(self, x0, y0, x1, y1, v=1.0):
        P = np.round(np.array([(x0, y0), (x1, y0), (x1, y1), (x0, y1)]) * 16).astype(np.int32)
        cv2.fillPoly(self.a, [P], int(255 * clamp01(v)), cv2.LINE_AA, self.SH)
    def dashed(self, p, q, v=1.0, dash=6, gap=6, th=1, phase=0.0):
        p, q = np.array(p, float), np.array(q, float)
        L = np.linalg.norm(q - p)
        if L < 1e-3: return
        d = (q - p) / L
        s = -(phase % (dash + gap))
        while s < L:
            a, b = max(s, 0), min(s + dash, L)
            if b > a:
                self.line(p + d * a, p + d * b, v, th)
            s += dash + gap
    def f(self):
        return self.a.astype(np.float32) / 255.0

def draw_line_partial(ov, pts, u, v=1.0, th=1):
    """Polyline drawn to fraction u of its length (for leader lines)."""
    P = np.asarray(pts, float)
    seglen = np.linalg.norm(np.diff(P, axis=0), axis=1)
    total = seglen.sum() * clamp01(u)
    acc = 0.0
    for i, L in enumerate(seglen):
        if acc + L <= total:
            ov.line(P[i], P[i + 1], v, th)
            acc += L
        else:
            r = (total - acc) / L if L > 0 else 0
            if r > 0:
                ov.line(P[i], P[i] + (P[i + 1] - P[i]) * r, v, th)
            return P[i] + (P[i + 1] - P[i]) * r
    return P[-1]

# --------------------------------------------------------------------------- halftone / LED
_LED_CACHE = {}
def led_density(img, q, gain=3.0, gamma=0.8):
    """Per-cell LED drive (0..1) from the mean ink of each q x q screen cell."""
    cells = cv2.resize(img, (W // q, H // q), interpolation=cv2.INTER_AREA)
    return np.clip(cells * gain, 0, 1) ** gamma

def led_from_density(d, q, rmax=0.48, rmin_cut=0.06, level=None):
    """Rasterize per-cell drive into dots; optional per-cell brightness."""
    R = np.where(d > rmin_cut, d * rmax * q, 0.0)
    out = dots_from_radii(R, q)
    if level is not None:
        out *= np.repeat(np.repeat(level.astype(np.float32), q, 0), q, 1)
    return out

def led_halftone(img, q, gain=3.0, gamma=0.8, rmax=0.48, rmin_cut=0.06, radius_mul=None):
    """Screen-space LED halftone: each q x q cell becomes a dot sized by mean ink."""
    d = led_density(img, q, gain, gamma)
    if radius_mul is not None:
        d = d * radius_mul
    return led_from_density(d, q, rmax, rmin_cut)

def cell_centers(q):
    key = ('cc', q)
    if key not in _LED_CACHE:
        ys, xs = np.mgrid[0:H // q, 0:W // q].astype(np.float32)
        _LED_CACHE[key] = ((xs + 0.5) * q, (ys + 0.5) * q)
    return _LED_CACHE[key]

def dot_grid(q=24, r=1.1, level=0.14, reveal=None):
    """Background engineering dot-grid.  reveal: per-cell scale (H//q, W//q)."""
    R = np.full((H // q, W // q), r, np.float32)
    if reveal is not None:
        R = R * reveal
    return dots_from_radii(R, q) * level

# --------------------------------------------------------------------------- camera
class Cam:
    """Look-down camera: yaw spins the plan, pitch tilts toward the horizon."""
    def __init__(self, target=(0, 0, 0), scale=1.0, yaw=0.0, pitch=0.0, fov=18.0, roll=0.0,
                 dist=None, shift=(0.0, 0.0)):
        self.target = np.array(target, float)
        self.fov = fov
        self.F = (W / 2) / math.tan(math.radians(fov) / 2)
        self.dist = dist if dist is not None else self.F / scale
        th, ps, rl = math.radians(pitch), math.radians(yaw), math.radians(roll)
        r = np.array([1.0, 0, 0]); d = np.array([0, -math.cos(th), -math.sin(th)])
        f = np.array([0, math.sin(th), -math.cos(th)])
        Rz = np.array([[math.cos(ps), -math.sin(ps), 0], [math.sin(ps), math.cos(ps), 0], [0, 0, 1]])
        r, d, f = Rz @ r, Rz @ d, Rz @ f
        if rl:
            c, s = math.cos(rl), math.sin(rl)
            r, d = c * r + s * d, -s * r + c * d
        self.R = np.stack([r, d, f])
        self.pos = self.target - f * self.dist
        self.shift = shift
        Kint = np.array([[self.F, 0, W / 2 + shift[0]], [0, self.F, H / 2 + shift[1]], [0, 0, 1]])
        self.P = Kint @ np.hstack([self.R, (-self.R @ self.pos)[:, None]])

    def project(self, X):
        X = np.atleast_2d(np.asarray(X, float))
        Xh = np.hstack([X, np.ones((len(X), 1))])
        p = (self.P @ Xh.T).T
        z = p[:, 2:3]
        return p[:, :2] / z, z[:, 0]

    def plane_H(self, K, origin, z, center):
        """Homography: texture pixel (u, v) at K px/pt on the plane z -> screen."""
        cx, cy = center
        ox, oy = origin
        A = np.array([[1 / K, 0, ox - cx],
                      [0, -1 / K, -(oy - cy)],
                      [0, 0, z],
                      [0, 0, 1]], float)
        return self.P @ A

def plan_to_world(px, py, z, center):
    return np.array([px - center[0], -(py - center[1]), z], float)

# --------------------------------------------------------------------------- mip textures
class MipTex:
    """uint8 texture pyramid; samples with trilinear mip blending via warpPerspective."""
    def __init__(self, img, K, levels=4):
        self.K = K
        self.levels = [img]
        for i in range(1, levels):
            p = self.levels[-1]
            self.levels.append(cv2.resize(p, (p.shape[1] // 2, p.shape[0] // 2), interpolation=cv2.INTER_AREA))

    def warp(self, Hs, px_per_pt, out=None, interp=cv2.INTER_LINEAR):
        """Hs: homography mapping level-0 texture px -> screen. px_per_pt: approx screen scale."""
        ratio = self.K / max(px_per_pt, 1e-6)          # texels per screen px at level 0
        lv = max(0.0, math.log2(max(ratio, 1e-6)))
        lv = min(lv, len(self.levels) - 1)
        l0 = int(math.floor(lv)); fr = lv - l0
        def one(l):
            s = 2.0 ** l
            S = np.array([[s, 0, 0], [0, s, 0], [0, 0, 1]], float)   # level-l px -> level-0 px
            M = Hs @ S
            return cv2.warpPerspective(self.levels[l], M, (W, H), flags=interp,
                                       borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        a = one(l0).astype(np.float32)
        if fr > 0.02 and l0 + 1 < len(self.levels):
            b = one(l0 + 1).astype(np.float32)
            a = a * (1 - fr) + b * fr
        return a / 255.0

# --------------------------------------------------------------------------- finishing
def glow(img, strength=0.55, s1=2.2, s2=9.0, s3=28.0):
    small = cv2.resize(img, (W // 2, H // 2), interpolation=cv2.INTER_AREA)
    g1 = cv2.GaussianBlur(img, (0, 0), s1)
    g2 = cv2.resize(cv2.GaussianBlur(small, (0, 0), s2 / 2), (W, H), interpolation=cv2.INTER_LINEAR)
    g3 = cv2.resize(cv2.GaussianBlur(cv2.resize(small, (W // 8, H // 8), interpolation=cv2.INTER_AREA),
                                     (0, 0), s3 / 8), (W, H), interpolation=cv2.INTER_LINEAR)
    return img + strength * (0.35 * g1 + 0.45 * g2 + 0.35 * g3)

_VIG = None
def vignette(img, amt=0.22):
    global _VIG
    if _VIG is None:
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        r = np.sqrt(((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2) / math.sqrt(2)
        _VIG = (1 - amt * smoothstep(0.35, 1.0, r)).astype(np.float32)
    return img * _VIG

def grain(img, frame, amt=0.018):
    rng = np.random.default_rng(1000 + frame)
    n = rng.standard_normal((H // 2, W // 2)).astype(np.float32)
    n = cv2.resize(n, (W, H), interpolation=cv2.INTER_LINEAR)
    return img + n * amt
