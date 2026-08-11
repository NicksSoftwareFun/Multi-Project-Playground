"""MCP server exposing the data domain of Supercell Wx (https://github.com/dpaulat/supercell-wx).

Supercell Wx visualizes live/archive NEXRAD Level 2 and Level 3 radar data and NWS
severe weather alerts. This server gives MCP clients tools over the same public
sources: NEXRAD radar site metadata, the AWS Open Data radar buckets, the NWS
alerts API, and Supercell Wx release info.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

try:  # mcp SDK >= 2.0
    from mcp.server import MCPServer as FastMCP
except ImportError:  # mcp SDK 1.x
    from mcp.server.fastmcp import FastMCP

from . import clients
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


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
