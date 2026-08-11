"""Pure helpers (stdlib only) so they can be unit-tested without network or MCP deps."""

from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET

S3_NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"

# Common NEXRAD Level 3 product codes, as used by Supercell Wx and the
# unidata-nexrad-level3 bucket. The digit in N?B/N?G-style codes is the
# elevation tilt (0 = lowest).
LEVEL3_PRODUCT_CODES: dict[str, str] = {
    "N0B": "Digital base reflectivity, super-resolution (tilt 1)",
    "N1B": "Digital base reflectivity, super-resolution (tilt 2)",
    "N2B": "Digital base reflectivity, super-resolution (tilt 3)",
    "N3B": "Digital base reflectivity, super-resolution (tilt 4)",
    "N0G": "Digital base velocity, super-resolution (tilt 1)",
    "N1G": "Digital base velocity, super-resolution (tilt 2)",
    "N2G": "Digital base velocity, super-resolution (tilt 3)",
    "N3G": "Digital base velocity, super-resolution (tilt 4)",
    "N0Q": "Digital base reflectivity, legacy resolution (tilt 1)",
    "N0U": "Digital base velocity, legacy resolution (tilt 1)",
    "N0C": "Digital correlation coefficient (tilt 1)",
    "N0X": "Digital differential reflectivity (tilt 1)",
    "N0K": "Digital specific differential phase (tilt 1)",
    "N0H": "Hydrometeor classification (tilt 1)",
    "N0S": "Storm relative mean velocity (tilt 1)",
    "NSW": "Base spectrum width",
    "NCR": "Composite reflectivity",
    "N0Z": "Base reflectivity, 248 nm range (tilt 1)",
    "DVL": "Digital vertically integrated liquid",
    "EET": "Enhanced echo tops",
    "DAA": "Digital one-hour precipitation accumulation",
    "DTA": "Digital storm total precipitation accumulation",
    "NST": "Storm tracking information",
    "NMD": "Mesocyclone detection",
    "NTV": "Tornado vortex signature",
}

_LEVEL3_KEY_RE = re.compile(
    r"^(?P<site>[A-Z0-9]{3})_(?P<product>[A-Z0-9]{3})_"
    r"(?P<year>\d{4})_(?P<month>\d{2})_(?P<day>\d{2})_"
    r"(?P<hour>\d{2})_(?P<minute>\d{2})_(?P<second>\d{2})$"
)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points in kilometers."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def normalize_site_l2(site_id: str) -> str:
    """Normalize a radar site id to the 4-letter form used by Level 2 buckets (e.g. KTLX)."""
    return site_id.strip().upper()


def normalize_site_l3(site_id: str) -> str:
    """Normalize a radar site id to the 3-letter form used by Level 3 keys (KTLX -> TLX)."""
    site = site_id.strip().upper()
    if len(site) == 4:
        return site[1:]
    return site


def parse_level3_key(key: str) -> dict | None:
    """Parse a unidata-nexrad-level3 object key like TLX_N0B_2026_08_11_17_32_05."""
    m = _LEVEL3_KEY_RE.match(key)
    if not m:
        return None
    g = m.groupdict()
    return {
        "site": g["site"],
        "product": g["product"],
        "time": (
            f"{g['year']}-{g['month']}-{g['day']}"
            f"T{g['hour']}:{g['minute']}:{g['second']}Z"
        ),
    }


def parse_s3_listing(xml_text: str) -> dict:
    """Parse an S3 ListObjectsV2 XML response into keys / prefixes / pagination info."""
    root = ET.fromstring(xml_text)
    keys = []
    for contents in root.findall(f"{S3_NS}Contents"):
        key = contents.findtext(f"{S3_NS}Key")
        size = contents.findtext(f"{S3_NS}Size")
        modified = contents.findtext(f"{S3_NS}LastModified")
        keys.append(
            {
                "key": key,
                "size_bytes": int(size) if size else None,
                "last_modified": modified,
            }
        )
    prefixes = [
        p.findtext(f"{S3_NS}Prefix")
        for p in root.findall(f"{S3_NS}CommonPrefixes")
    ]
    return {
        "keys": keys,
        "prefixes": prefixes,
        "is_truncated": root.findtext(f"{S3_NS}IsTruncated") == "true",
        "next_continuation_token": root.findtext(f"{S3_NS}NextContinuationToken"),
    }
