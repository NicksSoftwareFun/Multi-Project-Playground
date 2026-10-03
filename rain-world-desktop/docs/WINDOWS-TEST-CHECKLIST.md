# Testing on the real Windows desktop

A 10-15 minute check after a batch of changes. Things the cloud sessions
can't test: real windows, Lively, real hardware speed.

## Use the right page

`index.html` is the **browser preview**: it draws a pretend desktop with fake
windows and icons, and creatures only see those. Don't put it in Lively.
The real wallpaper is **`wallpaper.html`, served by the helper**:

1. Copy the latest `rain-world-desktop` folder somewhere permanent (e.g.
   `Documents\rain-world-desktop`), replacing the old copy.
2. Double-click `windows\start-helper.cmd`. Leave the console open. It
   should say `wallpaper : http://localhost:47315/`.
3. In your normal browser open <http://localhost:47315/api/geometry>. You
   should see a list of your windows and icons. If it doesn't load, the helper
   isn't running and creatures won't see anything real.
4. In Lively: remove any old Rain World wallpaper, then **Add wallpaper (+)**,
   paste **`http://localhost:47315/`**, and set it as the wallpaper.
5. Lively **Settings → Wallpaper → Interaction → Wallpaper input: Mouse**.

(Alternative: zip the folder and drag the zip into Lively; that uses
`wallpaper.html` too. Start the helper with
`windows\start-helper.cmd -AllowFileOrigin` for that route.)

## What to check

- [ ] Creatures stand on top of your real windows, climb their sides, perch
      on desktop icons and walk the taskbar.
- [ ] Drag a window with a creature on it: it rides along. Drop a window on
      a creature: it gets out from underneath.
- [ ] Maximise an app: the wallpaper pauses. Restore: it carries on.
- [ ] Press on a creature on bare desktop and drag: it hangs limp and drops
      where you let go.
- [ ] Settings: open <http://localhost:47315/?panel=1> in your browser, switch
      Size to XL and Wildlife to something else; the wallpaper should follow
      within a few seconds. Also try Lively's **Customise** dropdowns (zip
      route only).
- [ ] Leave it on **Normal** for 10 minutes: does it stay smooth? Then **XL**:
      any stutter? (If so: Settings panel → World → max fps 30.)
- [ ] Display scaling (125%/150%): creatures line up with window edges.
- [ ] Watch one rain cycle (about 4 minutes): light rain, a build-up, the
      downpour (everyone shelters), then easing off.

Note anything odd with a screenshot and roughly where on screen it happened.
