# supercell-wx-mcp

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server for
[Supercell Wx](https://github.com/dpaulat/supercell-wx), the free, open source
application for visualizing live and archive NEXRAD radar data and severe
weather alerts.

The server does two things:

1. **Weather data tools** — expose the same public data sources the app reads
   (NEXRAD Level 2/3 buckets, NWS alerts, radar site metadata), so an AI
   assistant can look up radar sites, browse radar data, and summarize warnings.
2. **Desktop control tools** — drive a *running* Supercell Wx window: take
   screenshots the AI can view and analyze (e.g. "what does this storm
   structure look like?"), change the display mode, pan/center the map on
   locations, and zoom in and out, using the app's own default hotkeys and
   mouse gestures.

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

### Desktop control tools (require the `[desktop]` extra and a running Supercell Wx)

| Tool | Description |
| --- | --- |
| `screenshot` | Capture the Supercell Wx window (or desktop) as an image the AI can analyze |
| `get_window_info` | Locate the Supercell Wx window and report its geometry |
| `focus_supercell_window` | Bring the app to the foreground |
| `map_zoom` | Zoom in/out N steps (`=`/`-` hotkeys or mouse wheel) |
| `map_pan` | Pan up/down/left/right (the app's W/A/S/D hotkeys) |
| `change_display_mode` | Cycle product category (`Ctrl+]`/`Ctrl+[`), tilt (`]`/`[`), or map style (`Z`) |
| `center_on_location` | Focus the app, find the nearest radar site to a lat/lon, and return the centering plan |
| `click_at` / `drag_at` / `scroll_at` | Precise mouse control (middle-click selects + centers the nearest radar site; drags pan the map) |
| `press_keys` / `type_text` | Keyboard input for anything else (e.g. `F11`, dialogs) |

The intended workflow is a **visual loop**: take a `screenshot`, let the AI
look at it, act (`map_zoom`, `change_display_mode`, `click_at`, …), then take
another screenshot to verify. Click/drag/scroll coordinates can be given
directly in the last screenshot's pixel space (`space="image"`); the server
converts them to screen pixels. Hotkeys assume the app's default bindings —
if you've remapped them in Supercell Wx settings, use `press_keys` with your
own bindings instead.

Example analysis flow: `change_display_mode("next_product_category")` →
`screenshot()` → *"reflectivity shows a hook echo southwest of the couplet —
switch to storm relative velocity and check the rotation"* →
`change_display_mode(...)` → `screenshot()`.

All data sources are public and require no API keys:

- **NEXRAD Level 2**: `noaa-nexrad-level2` S3 bucket (NOAA Open Data, near-real-time archive)
- **NEXRAD Level 3**: `unidata-nexrad-level3` S3 bucket (recent data, ~1 month retention)
- **Alerts + radar station metadata**: `api.weather.gov` (NWS API)
- **Releases**: GitHub REST API

## Installation

Requires Python 3.10+.

```bash
cd supercell-wx-mcp
pip install .              # weather data tools only
pip install ".[desktop]"   # + desktop control of a running Supercell Wx
```

Desktop control needs the server running on the same machine (and desktop
session) as Supercell Wx. On Linux it uses X11 and `xdotool`
(`sudo apt install xdotool`); Wayland sessions are not supported. Windows and
macOS work out of the box (macOS will prompt for Screen Recording and
Accessibility permissions).

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
- "Take a screenshot of Supercell Wx and tell me what the storm structure looks like."
- "Switch to velocity, zoom into the strongest cell, and check for rotation."
- "Center the map on Norman, Oklahoma and zoom in."

## Development

Run the offline unit tests (no network needed):

```bash
python -m unittest discover tests
```

## License

MIT
