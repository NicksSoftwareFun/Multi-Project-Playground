# Running it as your Windows wallpaper

Two pieces work together:

1. **The helper** (`rw-helper.ps1`) is a small PowerShell script. It asks Windows where your
   windows, desktop icons, taskbar and cursor are, and shares that with the
   wallpaper over `http://localhost:47315`, so only this PC can reach it. It also
   serves the wallpaper files. It reads **rectangles only**, never window titles
   or contents.
2. **[Lively Wallpaper](https://www.rocksdanister.com/lively/)** is a free live-wallpaper
   app (Microsoft Store or GitHub). It displays the wallpaper page behind your
   desktop icons.

Nothing needs installing besides Lively. The helper uses the PowerShell that ships
with Windows 10/11.

## Setup

1. Copy the whole `rain-world-desktop` folder somewhere permanent, for example
   `Documents\rain-world-desktop`.
2. Double-click **`windows\start-helper.cmd`**. A console window opens showing
   `Rain World Desktop helper … wallpaper : http://localhost:47315/`. Leave it open.
   - If Windows SmartScreen or your antivirus asks, allow it; the script source is in this folder.
   - To have it start automatically (hidden) at sign-in, run
     `powershell -ExecutionPolicy Bypass -File windows\install-startup.ps1`
     (undo with `-Remove`).
3. In Lively: **Add wallpaper (+)** → paste the URL **`http://localhost:47315/`** → set it as the wallpaper.
4. In Lively **Settings → Wallpaper → Interaction**, set *Wallpaper input* to
   **Mouse** so creatures can react to the cursor and you can drag creatures
   around by pressing on them on bare desktop.

You should see creatures standing on top of your windows, climbing their sides,
perching on desktop icons and walking along the taskbar. Drag a window and
anything standing on it rides along.

## Changing settings (spawn weights, rain, palette, size)

Open **<http://localhost:47315/?panel=1>** in your normal browser. That gives a
preview with the ecosystem panel open. Changes save to `windows\config.json`,
and the live wallpaper picks them up within about 3 seconds.

Alternative: zip the `rain-world-desktop` folder (with `LivelyInfo.json` at the
top of the zip) and drag the zip into Lively. Lively's **Customise** button then
shows sliders for creature scale, population and per-creature spawn weights.
The helper still needs to be running for creatures to see your windows, and
for a packaged wallpaper it must be started with `-AllowFileOrigin`
(`start-helper.cmd -AllowFileOrigin`). That lets pages loaded from files read the
geometry API. It's off by default because sandboxed frames on websites
share that "null" origin. The URL route above doesn't need it.

## Notes and limits

- **Fullscreen or maximised apps:** when a window covers ~90% of the screen the
  simulation pauses. Lively also pauses wallpapers behind fullscreen apps by default.
- **Primary monitor only** for now.
- **Display scaling** (125%, 150%, …) is handled. The helper reports physical pixels
  and the wallpaper converts them.
- **Without the helper** the wallpaper still runs, but creatures only know about
  the screen edges and the wallpaper's own ledges and poles.
- Stop the helper by closing its console window (or Ctrl+C).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Console says *Could not listen on http://localhost:47315/* | The helper is already running (look for `powershell` in Task Manager), or another app uses the port. Run with `-Port 47316` and use that port in Lively. |
| Creatures walk through windows | Open `http://localhost:47315/api/geometry` in a browser. You should see your windows listed. If it fails to load, the helper isn't running. |
| Creatures ignore the cursor | Enable Lively's *Wallpaper input → Mouse*. The helper also reports the cursor, so this mostly affects clicks. |
| Desktop icons aren't solid | Some icon-hiding or desktop-replacement tools move the icon view; the helper then reports no icons. Windows and the taskbar still work. |

## Files

- `rw-helper.ps1`: the helper (web server + geometry API)
- `RwNative.cs`: the Win32 calls (window, icon, taskbar and cursor lookups), compiled on the fly by PowerShell
- `start-helper.cmd`: double-click launcher
- `install-startup.ps1`: start the helper at sign-in
- `config.json`: created when you change settings
