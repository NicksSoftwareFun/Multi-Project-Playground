"""MCP server exposing the data domain of Supercell Wx (https://github.com/dpaulat/supercell-wx).

Supercell Wx visualizes live/archive NEXRAD Level 2 and Level 3 radar data and NWS
severe weather alerts. This server gives MCP clients tools over the same public
sources: NEXRAD radar site metadata, the AWS Open Data radar buckets, the NWS
alerts API, and Supercell Wx release info.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

try:  # mcp SDK >= 2.0
    from mcp.server import MCPServer as FastMCP
except ImportError:  # mcp SDK 1.x
    from mcp.server.fastmcp import FastMCP

from mcp.types import ImageContent, TextContent

from . import clients, desktop
from .util import (
    LEVEL3_PRODUCT_CODES,
    haversine_km,
    normalize_site_l2,
    normalize_site_l3,
    parse_level3_key,
)

mcp = FastMCP("supercell-wx")

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Radar station metadata rarely changes; cache it for the process lifetime.
_station_cache: list[dict] | None = None


def _parse_date(date: str | None) -> tuple[str, str, str]:
    """Validate a YYYY-MM-DD string (default: today, UTC) and split it."""
    if date is None:
        date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if not _DATE_RE.match(date):
        raise ValueError(f"date must be YYYY-MM-DD, got {date!r}")
    year, month, day = date.split("-")
    return year, month, day


async def _get_stations() -> list[dict]:
    global _station_cache
    if _station_cache is not None:
        return _station_cache
    async with clients.make_client() as client:
        data = await clients.nws_get(client, "/radar/stations")
    stations = []
    for feature in data.get("features", []):
        props = feature.get("properties", {})
        geom = feature.get("geometry") or {}
        coords = geom.get("coordinates") or [None, None]
        station_id = props.get("id") or (feature.get("id", "").rsplit("/", 1)[-1])
        elevation = (props.get("elevation") or {}).get("value")
        stations.append(
            {
                "id": station_id,
                "name": props.get("name"),
                "station_type": props.get("stationType"),
                "latitude": coords[1],
                "longitude": coords[0],
                "elevation_m": elevation,
                "time_zone": props.get("timeZone"),
            }
        )
    _station_cache = stations
    return stations


@mcp.tool()
async def list_radar_sites(station_type: str | None = None, state_or_name: str | None = None) -> dict:
    """List NEXRAD/TDWR radar sites that Supercell Wx can display.

    Args:
        station_type: Optional filter, e.g. "WSR-88D" or "TDWR".
        state_or_name: Optional case-insensitive substring match against the site name.
    """
    stations = await _get_stations()
    if station_type:
        stations = [s for s in stations if (s["station_type"] or "").upper() == station_type.upper()]
    if state_or_name:
        needle = state_or_name.lower()
        stations = [s for s in stations if needle in (s["name"] or "").lower()]
    return {"count": len(stations), "sites": stations}


@mcp.tool()
async def get_radar_site(site_id: str) -> dict:
    """Get metadata for a single radar site by its ICAO id (e.g. KTLX, KDMX, TOKC)."""
    site = normalize_site_l2(site_id)
    for station in await _get_stations():
        if station["id"] == site:
            return station
    raise ValueError(f"Unknown radar site {site!r}. Use list_radar_sites to browse ids.")


@mcp.tool()
async def find_nearest_radar(latitude: float, longitude: float, limit: int = 3) -> dict:
    """Find the radar sites closest to a point — useful for picking the site to view in Supercell Wx.

    Args:
        latitude: Latitude in decimal degrees.
        longitude: Longitude in decimal degrees.
        limit: Number of nearest sites to return (default 3).
    """
    stations = [s for s in await _get_stations() if s["latitude"] is not None]
    ranked = sorted(
        (
            {**s, "distance_km": round(haversine_km(latitude, longitude, s["latitude"], s["longitude"]), 1)}
            for s in stations
        ),
        key=lambda s: s["distance_km"],
    )
    return {"query": {"latitude": latitude, "longitude": longitude}, "sites": ranked[: max(1, limit)]}


@mcp.tool()
async def list_level2_files(
    site_id: str,
    date: str | None = None,
    max_files: int = 50,
    latest_first: bool = True,
) -> dict:
    """List NEXRAD Level 2 volume files for a site and UTC date from the noaa-nexrad-level2 bucket.

    These are the same archive volumes Supercell Wx loads in archive mode. New volumes
    typically appear within minutes of completion, so today's date approximates live data.

    Args:
        site_id: 4-letter radar id, e.g. KTLX.
        date: UTC date as YYYY-MM-DD (default: today).
        max_files: Maximum files to return (default 50).
        latest_first: Return the most recent files first (default true).
    """
    site = normalize_site_l2(site_id)
    year, month, day = _parse_date(date)
    prefix = f"{year}/{month}/{day}/{site}/"

    keys: list[dict] = []
    token: str | None = None
    async with clients.make_client() as client:
        for _ in range(5):  # a full day is < 300 volumes; cap pagination defensively
            page = await clients.s3_list(
                client, clients.LEVEL2_ARCHIVE_BUCKET, prefix, max_keys=1000, continuation_token=token
            )
            keys.extend(page["keys"])
            token = page["next_continuation_token"]
            if not page["is_truncated"] or not token:
                break

    files = [
        {
            **k,
            "url": clients.s3_url(clients.LEVEL2_ARCHIVE_BUCKET, k["key"]),
            "is_mdm": k["key"].endswith("_MDM"),  # metadata-only companion files
        }
        for k in keys
    ]
    if latest_first:
        files.reverse()
    return {
        "site": site,
        "date": f"{year}-{month}-{day}",
        "total_files_found": len(files),
        "files": files[: max(1, max_files)],
    }


@mcp.tool()
async def list_level3_files(
    site_id: str,
    product: str = "N0B",
    date: str | None = None,
    max_files: int = 25,
) -> dict:
    """List NEXRAD Level 3 product files for a site from the unidata-nexrad-level3 bucket.

    This bucket holds recent data only (roughly the last month). Files are returned
    most recent first.

    Args:
        site_id: Radar id, 4-letter (KTLX) or 3-letter (TLX) form.
        product: Level 3 product code, e.g. N0B, N0G, N0C, DVL (see list_level3_product_codes).
        date: UTC date as YYYY-MM-DD (default: today).
        max_files: Maximum files to return (default 25).
    """
    site = normalize_site_l3(site_id)
    code = product.strip().upper()
    year, month, day = _parse_date(date)
    prefix = f"{site}_{code}_{year}_{month}_{day}"

    keys: list[dict] = []
    token: str | None = None
    async with clients.make_client() as client:
        for _ in range(5):
            page = await clients.s3_list(
                client, clients.LEVEL3_BUCKET, prefix, max_keys=1000, continuation_token=token
            )
            keys.extend(page["keys"])
            token = page["next_continuation_token"]
            if not page["is_truncated"] or not token:
                break

    files = []
    for k in reversed(keys):  # keys sort chronologically; reverse for latest first
        parsed = parse_level3_key(k["key"]) or {}
        files.append(
            {
                **k,
                "url": clients.s3_url(clients.LEVEL3_BUCKET, k["key"]),
                "scan_time": parsed.get("time"),
            }
        )
    return {
        "site": site,
        "product": code,
        "product_description": LEVEL3_PRODUCT_CODES.get(code, "unknown product code"),
        "date": f"{year}-{month}-{day}",
        "total_files_found": len(files),
        "files": files[: max(1, max_files)],
    }


@mcp.tool()
def list_level3_product_codes() -> dict:
    """List common NEXRAD Level 3 product codes usable with list_level3_files."""
    return {"products": LEVEL3_PRODUCT_CODES}


@mcp.tool()
async def get_active_alerts(
    area: str | None = None,
    point: str | None = None,
    event: str | None = None,
    severity: str | None = None,
    limit: int = 25,
) -> dict:
    """Get active NWS severe weather alerts — the same alerts Supercell Wx overlays on the map.

    Args:
        area: Two-letter state/marine area code, e.g. "OK".
        point: "latitude,longitude" to get alerts covering a specific location.
        event: Filter by event name, e.g. "Tornado Warning".
        severity: One of Extreme, Severe, Moderate, Minor, Unknown.
        limit: Maximum alerts to return (default 25).
    """
    params: dict[str, Any] = {"limit": max(1, min(limit, 500))}
    if area:
        params["area"] = area.upper()
    if point:
        params["point"] = point.replace(" ", "")
    if event:
        params["event"] = event
    if severity:
        params["severity"] = severity.capitalize()

    async with clients.make_client() as client:
        data = await clients.nws_get(client, "/alerts/active", params)

    alerts = []
    for feature in data.get("features", []):
        p = feature.get("properties", {})
        alerts.append(
            {
                "id": p.get("id"),
                "event": p.get("event"),
                "headline": p.get("headline"),
                "severity": p.get("severity"),
                "urgency": p.get("urgency"),
                "certainty": p.get("certainty"),
                "onset": p.get("onset"),
                "expires": p.get("expires"),
                "area": p.get("areaDesc"),
                "sender": p.get("senderName"),
            }
        )
    return {"count": len(alerts), "alerts": alerts}


@mcp.tool()
async def get_alert(alert_id: str) -> dict:
    """Get the full text of a single NWS alert by the id returned from get_active_alerts."""
    # Ids come back as full URLs (https://api.weather.gov/alerts/urn:oid:...); accept either form.
    path = alert_id.removeprefix(clients.NWS_API)
    if not path.startswith("/alerts/"):
        path = f"/alerts/{path.lstrip('/')}"
    async with clients.make_client() as client:
        data = await clients.nws_get(client, path)
    p = data.get("properties", {})
    return {
        "id": p.get("id"),
        "event": p.get("event"),
        "headline": p.get("headline"),
        "severity": p.get("severity"),
        "urgency": p.get("urgency"),
        "certainty": p.get("certainty"),
        "onset": p.get("onset"),
        "expires": p.get("expires"),
        "area": p.get("areaDesc"),
        "sender": p.get("senderName"),
        "description": p.get("description"),
        "instruction": p.get("instruction"),
    }


@mcp.tool()
async def get_supercell_wx_latest_release() -> dict:
    """Get the latest Supercell Wx release (version, notes, and download assets)."""
    async with clients.make_client() as client:
        data = await clients.github_get(client, f"/repos/{clients.SUPERCELL_WX_REPO}/releases/latest")
    body = data.get("body") or ""
    return {
        "tag": data.get("tag_name"),
        "name": data.get("name"),
        "published_at": data.get("published_at"),
        "url": data.get("html_url"),
        "notes": body[:4000] + ("…" if len(body) > 4000 else ""),
        "assets": [
            {
                "name": a.get("name"),
                "size_bytes": a.get("size"),
                "download_url": a.get("browser_download_url"),
            }
            for a in data.get("assets", [])
        ],
    }


# --- Desktop control of a running Supercell Wx window -----------------------
#
# These tools drive the actual desktop app: take screenshots (return them as
# images for the AI client to analyze), and inject the app's own mouse
# gestures and default hotkeys to zoom, pan, and change display modes.
# They require the [desktop] extra and a desktop session on the machine
# running this server.


@mcp.tool()
def screenshot(target: str = "window", monitor: int = 1, max_width: int = 1536) -> list:
    """Capture the Supercell Wx window (or full desktop) and return the image for analysis.

    Take a screenshot after each control action to see its effect. The returned
    text block gives the capture geometry; click_at/drag_at/scroll_at accept
    coordinates measured directly on this image (space="image").

    Args:
        target: "window" for the Supercell Wx window (falls back to desktop if
            not found), or "desktop" for the whole screen.
        monitor: Monitor number for desktop capture (1 = primary).
        max_width: Downscale the image to at most this many pixels wide.
    """
    png, info = desktop.capture(target=target, monitor=monitor, max_width=max_width)
    return [
        TextContent(type="text", text=json.dumps(info)),
        ImageContent(
            type="image",
            data=desktop.png_to_data_url_size(png),
            mimeType="image/png",
        ),
    ]


@mcp.tool()
def get_window_info() -> dict:
    """Locate the Supercell Wx window and report its screen geometry."""
    region = desktop.find_window()
    if region is None:
        return {
            "found": False,
            "note": f"No visible window titled {desktop.WINDOW_TITLE!r}. "
                    "Is Supercell Wx running? Screenshots will fall back to the desktop.",
        }
    return {
        "found": True,
        "left": region.left,
        "top": region.top,
        "width": region.width,
        "height": region.height,
    }


@mcp.tool()
def focus_supercell_window() -> dict:
    """Bring the Supercell Wx window to the foreground so hotkeys and clicks reach it."""
    ok = desktop.focus_window()
    return {"focused": ok}


@mcp.tool()
def map_zoom(steps: int, method: str = "keys") -> dict:
    """Zoom the Supercell Wx map in (positive steps) or out (negative steps).

    Args:
        steps: Number of zoom steps; positive zooms in, negative zooms out.
        method: "keys" presses the app's '='/'-' zoom hotkeys; "wheel" scrolls
            the mouse wheel at the window center.
    """
    if steps == 0:
        return {"zoomed": 0}
    desktop.focus_window()
    count = min(abs(steps), 20)
    if method == "wheel":
        cx, cy = desktop.window_center()
        desktop.scroll(cx, cy, count if steps > 0 else -count)
    else:
        key = desktop.ZOOM_IN_KEY if steps > 0 else desktop.ZOOM_OUT_KEY
        desktop.press_hotkey((key,), presses=count)
    return {"zoomed": count if steps > 0 else -count, "method": method,
            "hint": "Take a screenshot to verify the new view."}


@mcp.tool()
def map_pan(direction: str, seconds: float = 0.5) -> dict:
    """Pan the Supercell Wx map using the app's W/A/S/D pan hotkeys.

    Args:
        direction: One of "up", "down", "left", "right".
        seconds: How long to hold the pan key (0.05-5.0; longer = farther).
    """
    key = desktop.PAN_KEYS.get(direction.lower())
    if key is None:
        raise ValueError(f"direction must be one of {sorted(desktop.PAN_KEYS)}")
    desktop.focus_window()
    desktop.hold_key(key, seconds)
    return {"panned": direction, "seconds": seconds,
            "hint": "Take a screenshot to verify the new view. For precise pans, "
                    "use drag_at on the map instead."}


@mcp.tool()
def change_display_mode(action: str, presses: int = 1) -> dict:
    """Change what the Supercell Wx map displays, via the app's default hotkeys.

    Args:
        action: One of:
            - "next_product_category" / "previous_product_category": cycle the
              radar product category (reflectivity, velocity, etc.)
            - "increase_tilt" / "decrease_tilt": change the elevation tilt
            - "cycle_map_style": switch the base map style
        presses: Repeat the action this many times (1-10).
    """
    keys = desktop.DISPLAY_MODE_HOTKEYS.get(action)
    if keys is None:
        raise ValueError(f"action must be one of {sorted(desktop.DISPLAY_MODE_HOTKEYS)}")
    desktop.focus_window()
    desktop.press_hotkey(keys, presses=max(1, min(presses, 10)))
    return {"action": action, "presses": presses,
            "hint": "Take a screenshot to see the new display mode."}


@mcp.tool()
def click_at(x: float, y: float, button: str = "left", double: bool = False,
             space: str = "image") -> dict:
    """Click in the Supercell Wx window (or anywhere on screen).

    On the map: middle-click selects and centers the nearest radar site to the
    clicked point; double left-click zooms in 2x; double right-click zooms out.

    Args:
        x: X coordinate.
        y: Y coordinate.
        button: "left", "right", or "middle".
        double: Double-click instead of single.
        space: "image" to use coordinates measured on the last screenshot
            (recommended), or "screen" for raw screen pixels.
    """
    sx, sy = desktop.resolve_point(x, y, space)
    desktop.click(sx, sy, button=button, double=double)
    return {"clicked": {"x": sx, "y": sy}, "button": button, "double": double}


@mcp.tool()
def drag_at(from_x: float, from_y: float, to_x: float, to_y: float,
            duration: float = 0.6, space: str = "image") -> dict:
    """Left-click drag, e.g. to pan the map by an exact pixel offset.

    Dragging the map moves the ground with the cursor: drag left to look
    further right. Coordinates default to the last screenshot's image space.
    """
    sx1, sy1 = desktop.resolve_point(from_x, from_y, space)
    sx2, sy2 = desktop.resolve_point(to_x, to_y, space)
    desktop.drag(sx1, sy1, sx2, sy2, duration=duration)
    return {"dragged": {"from": [sx1, sy1], "to": [sx2, sy2]}}


@mcp.tool()
def scroll_at(x: float, y: float, clicks: int, space: str = "image") -> dict:
    """Scroll the mouse wheel at a point (positive = zoom in on the map)."""
    sx, sy = desktop.resolve_point(x, y, space)
    desktop.scroll(sx, sy, clicks)
    return {"scrolled": clicks, "at": {"x": sx, "y": sy}}


@mcp.tool()
def press_keys(keys: str, presses: int = 1) -> dict:
    """Press a key or hotkey combo in the focused window, e.g. "z", "ctrl+]", "f11".

    Useful Supercell Wx defaults: '='/'-' zoom, 'z' map style, 'ctrl+]' next
    product category, ']' tilt up, space timeline play, 'f11' full screen.
    """
    combo = tuple(k.strip().lower() for k in keys.split("+") if k.strip())
    if not combo:
        raise ValueError("keys must be a non-empty key or 'mod+key' combo")
    desktop.focus_window()
    desktop.press_hotkey(combo, presses=max(1, min(presses, 20)))
    return {"pressed": list(combo), "presses": presses}


@mcp.tool()
def type_text(text: str) -> dict:
    """Type text into the focused control (e.g. a radar site search box)."""
    desktop.type_text(text)
    return {"typed_chars": len(text)}


@mcp.tool()
async def center_on_location(latitude: float, longitude: float) -> dict:
    """Prepare to center the Supercell Wx map on a location, and return the plan.

    Focuses the window and looks up the nearest radar site. Centering is then a
    short visual loop for you to drive: Supercell Wx centers on a radar site
    when one is selected, and middle-clicking the map selects the site nearest
    the click. Follow the returned steps, taking a screenshot between actions.
    """
    focused = desktop.focus_window()
    nearest: list[dict] = []
    lookup_error = None
    try:
        stations = [s for s in await _get_stations() if s["latitude"] is not None]
        nearest = sorted(
            (
                {**s, "distance_km": round(
                    haversine_km(latitude, longitude, s["latitude"], s["longitude"]), 1)}
                for s in stations
            ),
            key=lambda s: s["distance_km"],
        )[:3]
    except Exception as exc:
        lookup_error = str(exc)
    return {
        "target": {"latitude": latitude, "longitude": longitude},
        "window_focused": focused,
        "nearest_radar_sites": nearest,
        "nearest_site_lookup_error": lookup_error,
        "steps": [
            "1. screenshot() to see the current view.",
            "2. If the target region is not visible, map_zoom(-5) to zoom out "
            "until it is, taking screenshots to check.",
            "3. click_at(x, y, button='middle') on the target location in the "
            "image: Supercell Wx selects and centers the nearest radar site "
            f"(expected: {nearest[0]['id'] if nearest else 'see nearest_radar_sites'}).",
            "4. screenshot() to confirm, then map_zoom(+N) to zoom in, and "
            "drag_at(...) for fine centering on the exact location.",
        ],
    }


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
