"""HTTP clients for the public data sources Supercell Wx reads.

- NEXRAD Level 2/Level 3 data: AWS Open Data S3 buckets (anonymous REST access)
- Severe weather alerts + radar station metadata: NWS API (api.weather.gov)
- Project release info: GitHub REST API
"""

from __future__ import annotations

import httpx

from . import __version__
from .util import parse_s3_listing

USER_AGENT = f"supercell-wx-mcp/{__version__} (github.com/NicksSoftwareFun/Multi-Project-Playground)"

LEVEL2_ARCHIVE_BUCKET = "noaa-nexrad-level2"
LEVEL3_BUCKET = "unidata-nexrad-level3"

NWS_API = "https://api.weather.gov"
SUPERCELL_WX_REPO = "dpaulat/supercell-wx"

_TIMEOUT = httpx.Timeout(30.0)


def make_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=_TIMEOUT,
        headers={"User-Agent": USER_AGENT, "Accept": "*/*"},
        follow_redirects=True,
    )


async def s3_list(
    client: httpx.AsyncClient,
    bucket: str,
    prefix: str,
    max_keys: int = 200,
    delimiter: str | None = None,
    continuation_token: str | None = None,
) -> dict:
    """List objects in a public S3 bucket via the anonymous REST API."""
    params: dict[str, str] = {
        "list-type": "2",
        "prefix": prefix,
        "max-keys": str(max_keys),
    }
    if delimiter:
        params["delimiter"] = delimiter
    if continuation_token:
        params["continuation-token"] = continuation_token
    resp = await client.get(f"https://{bucket}.s3.amazonaws.com/", params=params)
    resp.raise_for_status()
    return parse_s3_listing(resp.text)


def s3_url(bucket: str, key: str) -> str:
    return f"https://{bucket}.s3.amazonaws.com/{key}"


async def nws_get(client: httpx.AsyncClient, path: str, params: dict | None = None) -> dict:
    """GET a JSON document from the NWS API."""
    resp = await client.get(
        f"{NWS_API}{path}",
        params=params,
        headers={"Accept": "application/geo+json"},
    )
    resp.raise_for_status()
    return resp.json()


async def github_get(client: httpx.AsyncClient, path: str) -> dict | list:
    resp = await client.get(
        f"https://api.github.com{path}",
        headers={"Accept": "application/vnd.github+json"},
    )
    resp.raise_for_status()
    return resp.json()
