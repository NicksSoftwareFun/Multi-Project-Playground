"""Desktop control for a running Supercell Wx window.

Captures screenshots (for AI analysis of the radar display) and injects
keyboard/mouse input to drive the app: zoom, pan, display mode changes, and
radar site selection. Uses the app's default hotkeys and mouse gestures, as
implemented in scwx-qt/source/scwx/qt/map/map_widget.cpp and
settings/hotkey_settings.cpp:

- Zoom: '=' / '-' keys, mouse wheel, double-click (in) / double-right-click (out)
- Pan: W/A/S/D (time-based) or left-click drag
- Display: Z cycles map style, Ctrl+] / Ctrl+[ next/previous product category,
  ] / [ raise/lower tilt
- Middle-click selects (and centers on) the nearest radar site to the click

GUI dependencies (pyautogui, mss, Pillow, pygetwindow) are imported lazily so
the data-only tools keep working on headless machines. Install them with:
    pip install "supercell-wx-mcp[desktop]"
"""

from __future__ import annotations

import base64
import io
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass

WINDOW_TITLE = "Supercell Wx"

DESKTOP_INSTALL_HINT = (
    'Desktop control dependencies are missing. Install them with: '
    'pip install "supercell-wx-mcp[desktop]" '
    "(requires a desktop session; on Linux, X11)"
)

# Default Supercell Wx hotkeys (settings/hotkey_settings.cpp). If the user has
# remapped hotkeys in the app, these tools follow the defaults, not the remap.
DISPLAY_MODE_HOTKEYS: dict[str, tuple[str, ...]] = {
    "next_product_category": ("ctrl", "]"),
    "previous_product_category": ("ctrl", "["),
    "increase_tilt": ("]",),
    "decrease_tilt": ("[",),
    "cycle_map_style": ("z",),
}

PAN_KEYS = {"up": "w", "down": "s", "left": "a", "right": "d"}

ZOOM_IN_KEY = "="
ZOOM_OUT_KEY = "-"


@dataclass
class Region:
    """A screen-space rectangle (physical pixels)."""

    left: int
    top: int
    width: int
    height: int


@dataclass
class CaptureTransform:
    """Maps coordinates in the last captured image back to screen pixels."""

    origin_x: int
    origin_y: int
    scale: float  # image pixels per screen pixel (<= 1.0 when downscaled)

    def to_screen(self, image_x: float, image_y: float) -> tuple[int, int]:
        return (
            round(self.origin_x + image_x / self.scale),
            round(self.origin_y + image_y / self.scale),
        )


# Transform for the most recent screenshot, so click/drag/scroll tools can
# accept coordinates measured directly on that image.
_last_transform: CaptureTransform | None = None


def _require(module_name: str):
    try:
        return __import__(module_name)
    except Exception as exc:  # ImportError, or DISPLAY errors on Linux
        raise RuntimeError(f"{DESKTOP_INSTALL_HINT} (import of {module_name!r} failed: {exc})")


def find_window() -> Region | None:
    """Locate the Supercell Wx window, or None if not found.

    Uses pygetwindow on Windows/macOS and xdotool on Linux/X11.
    """
    if sys.platform.startswith("linux"):
        return _find_window_xdotool()
    gw = _require("pygetwindow")
    try:
        windows = gw.getWindowsWithTitle(WINDOW_TITLE)
    except Exception:
        return None
    for win in windows:
        if win.width > 0 and win.height > 0:
            return Region(win.left, win.top, win.width, win.height)
    return None


def _find_window_xdotool() -> Region | None:
    if not shutil.which("xdotool"):
        return None
    try:
        out = subprocess.run(
            ["xdotool", "search", "--onlyvisible", "--name", WINDOW_TITLE],
            capture_output=True, text=True, timeout=10,
        )
        window_ids = out.stdout.split()
        if not window_ids:
            return None
        geo = subprocess.run(
            ["xdotool", "getwindowgeometry", "--shell", window_ids[0]],
            capture_output=True, text=True, timeout=10,
        )
        values = dict(
            line.split("=", 1) for line in geo.stdout.splitlines() if "=" in line
        )
        return Region(
            int(values["X"]), int(values["Y"]),
            int(values["WIDTH"]), int(values["HEIGHT"]),
        )
    except Exception:
        return None


def focus_window() -> bool:
    """Bring the Supercell Wx window to the foreground so hotkeys reach it."""
    if sys.platform.startswith("linux"):
        if not shutil.which("xdotool"):
            return False
        result = subprocess.run(
            ["xdotool", "search", "--onlyvisible", "--name", WINDOW_TITLE,
             "windowactivate", "--sync"],
            capture_output=True, timeout=10,
        )
        time.sleep(0.3)
        return result.returncode == 0
    gw = _require("pygetwindow")
    try:
        windows = gw.getWindowsWithTitle(WINDOW_TITLE)
        if not windows:
            return False
        windows[0].activate()
        time.sleep(0.3)
        return True
    except Exception:
        return False


def capture(target: str = "window", monitor: int = 1, max_width: int = 1536) -> tuple[bytes, dict]:
    """Capture the Supercell Wx window (or the full desktop) as PNG bytes.

    Returns (png_bytes, info). info records the capture region and scale, and
    the module remembers the transform so later clicks can use image coordinates.
    """
    global _last_transform
    mss_mod = _require("mss")
    from PIL import Image  # via the pillow requirement in the desktop extra

    region: Region | None = None
    if target == "window":
        region = find_window()

    with mss_mod.mss() as sct:
        if region is None:
            mon_index = min(max(monitor, 1), len(sct.monitors) - 1)
            mon = sct.monitors[mon_index]
            region = Region(mon["left"], mon["top"], mon["width"], mon["height"])
        raw = sct.grab(
            {"left": region.left, "top": region.top,
             "width": region.width, "height": region.height}
        )

    img = Image.frombytes("RGB", raw.size, raw.rgb)
    scale = 1.0
    if img.width > max_width:
        scale = max_width / img.width
        img = img.resize((max_width, round(img.height * scale)), Image.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    png = buf.getvalue()

    _last_transform = CaptureTransform(region.left, region.top, scale)
    info = {
        "captured": "window" if target == "window" and region is not None else "desktop",
        "screen_region": {"left": region.left, "top": region.top,
                          "width": region.width, "height": region.height},
        "image_size": {"width": img.width, "height": img.height},
        "image_scale": round(scale, 4),
        "note": "Pass coordinates measured on this image to the click/drag/scroll "
                "tools with space='image'; they are converted to screen pixels.",
    }
    return png, info


def png_to_data_url_size(png: bytes) -> str:
    return base64.standard_b64encode(png).decode("ascii")


def resolve_point(x: float, y: float, space: str) -> tuple[int, int]:
    """Convert a point to screen pixels from image space (last screenshot) or screen space."""
    if space == "screen":
        return round(x), round(y)
    if _last_transform is None:
        raise RuntimeError(
            "No screenshot taken yet; take one first or pass space='screen'."
        )
    return _last_transform.to_screen(x, y)


def window_center() -> tuple[int, int]:
    region = find_window()
    if region is None:
        pyautogui = _require("pyautogui")
        size = pyautogui.size()
        return size.width // 2, size.height // 2
    return region.left + region.width // 2, region.top + region.height // 2


def click(x: int, y: int, button: str = "left", double: bool = False) -> None:
    pyautogui = _require("pyautogui")
    pyautogui.click(x=x, y=y, button=button, clicks=2 if double else 1, interval=0.1)


def drag(x1: int, y1: int, x2: int, y2: int, duration: float = 0.6) -> None:
    pyautogui = _require("pyautogui")
    pyautogui.moveTo(x1, y1)
    pyautogui.dragTo(x2, y2, duration=max(0.2, min(duration, 3.0)), button="left")


def scroll(x: int, y: int, clicks: int) -> None:
    pyautogui = _require("pyautogui")
    pyautogui.moveTo(x, y)
    pyautogui.scroll(clicks)


def press_hotkey(keys: tuple[str, ...], presses: int = 1) -> None:
    pyautogui = _require("pyautogui")
    for _ in range(presses):
        if len(keys) == 1:
            pyautogui.press(keys[0])
        else:
            pyautogui.hotkey(*keys)
        time.sleep(0.1)


def hold_key(key: str, seconds: float) -> None:
    pyautogui = _require("pyautogui")
    pyautogui.keyDown(key)
    try:
        time.sleep(max(0.05, min(seconds, 5.0)))
    finally:
        pyautogui.keyUp(key)


def type_text(text: str, interval: float = 0.03) -> None:
    pyautogui = _require("pyautogui")
    pyautogui.write(text, interval=interval)
