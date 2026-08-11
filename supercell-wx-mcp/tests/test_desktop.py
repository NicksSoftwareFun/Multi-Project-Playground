"""Offline unit tests for desktop-control helpers (no GUI deps needed)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from supercell_wx_mcp import desktop  # noqa: E402


class TestCaptureTransform(unittest.TestCase):
    def test_identity_transform(self):
        t = desktop.CaptureTransform(origin_x=0, origin_y=0, scale=1.0)
        self.assertEqual(t.to_screen(100, 50), (100, 50))

    def test_offset_and_downscale(self):
        # Window at (200, 100), image downscaled to half size: image pixel
        # (300, 150) is screen pixel (200 + 600, 100 + 300).
        t = desktop.CaptureTransform(origin_x=200, origin_y=100, scale=0.5)
        self.assertEqual(t.to_screen(300, 150), (800, 400))


class TestResolvePoint(unittest.TestCase):
    def setUp(self):
        desktop._last_transform = None

    def test_screen_space_passthrough(self):
        self.assertEqual(desktop.resolve_point(10.6, 20.4, "screen"), (11, 20))

    def test_image_space_requires_screenshot(self):
        with self.assertRaises(RuntimeError):
            desktop.resolve_point(10, 10, "image")

    def test_image_space_uses_last_transform(self):
        desktop._last_transform = desktop.CaptureTransform(50, 60, 0.5)
        self.assertEqual(desktop.resolve_point(100, 100, "image"), (250, 260))


class TestHotkeyTables(unittest.TestCase):
    def test_display_mode_actions_match_supercell_defaults(self):
        # Default bindings from scwx-qt settings/hotkey_settings.cpp
        self.assertEqual(desktop.DISPLAY_MODE_HOTKEYS["next_product_category"], ("ctrl", "]"))
        self.assertEqual(desktop.DISPLAY_MODE_HOTKEYS["increase_tilt"], ("]",))
        self.assertEqual(desktop.DISPLAY_MODE_HOTKEYS["cycle_map_style"], ("z",))

    def test_pan_keys_are_wasd(self):
        self.assertEqual(
            [desktop.PAN_KEYS[d] for d in ("up", "left", "down", "right")],
            ["w", "a", "s", "d"],
        )

    def test_zoom_keys(self):
        self.assertEqual((desktop.ZOOM_IN_KEY, desktop.ZOOM_OUT_KEY), ("=", "-"))


class TestLazyDeps(unittest.TestCase):
    def test_missing_gui_dep_raises_helpful_error(self):
        with self.assertRaises(RuntimeError) as ctx:
            desktop._require("definitely_not_a_real_module_xyz")
        self.assertIn("supercell-wx-mcp[desktop]", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
