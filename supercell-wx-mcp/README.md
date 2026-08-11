# supercell-wx-mcp

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server for
[Supercell Wx](https://github.com/dpaulat/supercell-wx), the free, open source
application for visualizing live and archive NEXRAD radar data and severe
weather alerts.

Supercell Wx itself is a C++/Qt desktop app. This server exposes the **same
public data sources the app reads** as MCP tools, so an AI assistant (Claude
Desktop, Claude Code, or any MCP client) can look up radar sites, browse NEXRAD
Level 2/Level 3 data in the AWS Open Data buckets, query active NWS alerts, and
check Supercell Wx releases — for example to help a user pick a radar site,
find archive data for a storm event, or summarize active warnings.

## Tools

| Tool | Description |
| --- | --- |
| `list_radar_sites` | List NEXRAD WSR-88D / TDWR sites (filter by type or name) |
| `get_radar_site` | Metadata for one site by ICAO id (e.g. `KTLX`) |
| `find_nearest_radar` | Nearest radar sites to a latitude/longitude |
| `list_level2_files` | Level 2 volume files for a site/date (`noaa-nexrad-level2` bucket) |
| `list_level3_files` | Level 3 product files for a site/product/date (`unidata-nexrad-level3` bucket) |
| `list_level3_product_codes` | Reference list of common Level 3 product codes (N0B, N0G, DVL, …) |
| `get_active_alerts` | Active NWS alerts, filterable by state, point, event, severity |
| `get_alert` | Full text and instructions for a single alert |
| `get_supercell_wx_latest_release` | Latest Supercell Wx release with download assets |

All data sources are public and require no API keys:

- **NEXRAD Level 2**: `noaa-nexrad-level2` S3 bucket (NOAA Open Data, near-real-time archive)
- **NEXRAD Level 3**: `unidata-nexrad-level3` S3 bucket (recent data, ~1 month retention)
- **Alerts + radar station metadata**: `api.weather.gov` (NWS API)
- **Releases**: GitHub REST API

## Installation

Requires Python 3.10+.

```bash
cd supercell-wx-mcp
pip install .
```

Or run without installing, using [uv](https://docs.astral.sh/uv/):

```bash
uv run --with mcp --with httpx python -m supercell_wx_mcp.server
```

## Configuring an MCP client

### Claude Code

```bash
claude mcp add supercell-wx -- supercell-wx-mcp
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "supercell-wx": {
      "command": "supercell-wx-mcp"
    }
  }
}
```

The server communicates over stdio, the standard MCP transport for local servers.

## Example prompts

- "What's the nearest radar site to Norman, Oklahoma?"
- "List today's Level 2 volumes for KTLX."
- "Are there any active tornado warnings in Oklahoma right now?"
- "Get the latest super-res reflectivity (N0B) files for KDMX."
- "What's the newest Supercell Wx release and which Windows asset should I download?"

## Development

Run the offline unit tests (no network needed):

```bash
python -m unittest discover tests
```

## License

MIT
