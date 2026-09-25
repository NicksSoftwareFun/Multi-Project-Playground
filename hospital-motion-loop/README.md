# MIH Tower: 15-second booth loop

`mih_tower_loop_1080p30.mp4` is a seamless 15 s loop (1920×1080, 30 fps, H.264) built
from the vector PDFs of the MIH Tower architectural overlay sheets. It's black & white
linework plus an LED dot-matrix treatment, made to run on repeat on a trade-show screen.
It starts and ends on the same single dot, so the loop point is invisible.

| time | shot |
|---|---|
| 0.0 s | a single dot sparks a shockwave; Level 1 ripples in as LED dots |
| 0.9 s | **Level 01**: the plan draws itself along its own walls from the ambulance entry |
| 3.3 s | dive into elevator T1E3; floor indicator rolls 01 → 02 |
| 4.1 s | **Level 02**: scan bar converts dots to linework; L&D / NICU callouts |
| 6.1 s | the LED matrix re-renders in place from Level 2 to Level 3 |
| 6.6 s | **Level 03**: all 30 patient rooms chase around the floor; the 14 ICU rooms hold |
| 8.6 s | exploded axonometric of all five levels with MEP risers through shafts XT1 / XT3 |
| 11.4 s | **Penthouse**: airflow runs along the ductwork centrelines; equipment callouts |
| 12.5 s | **Roof**: storm-drain ripples converge on every roof drain |
| 13.3 s | the roof's dots fly into the tagline, then a CRT power-off back to the dot |

Every label, room tag, count and drain position comes from the drawings: room tags
are read from the PDF text layer, rooms are flood-filled from the linework, duct
centrelines are skeletonised from the duct strokes, and all levels are registered
to each other on the blue column grid.

## Re-rendering

The source PDFs are not committed. Put `MIH_Tower_Architectural_Overlay_Experiment_{1..5}.pdf`
in `plans/`, then:

```bash
pip install -r requirements.txt
python3 prep.py        # vector PDFs -> registered raster layers (.cache/)
python3 assets.py      # draw-on maps, footprints, duct flow, drain field, room shapes
python3 render.py      # full loop -> mih_tower_loop_1080p30.mp4 (~4 min on 4 cores)
python3 render.py --still 9.9          # one frame -> out/stills/
python3 render.py --clip 3.0 4.5       # a section -> out/clip.mp4
```

Fonts: IBM Plex Mono and IBM Plex Sans Condensed (SIL Open Font License, see `fonts/`).
