#!/usr/bin/env python3
"""After an imagery rebuild: drop tiles imagery.json no longer lists, check that
label text sits where the PDF puts it, and print the artifact file map."""
import os, json, sys
import numpy as np
from PIL import Image
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'web', 'data')
img = json.load(open(os.path.join(DATA, 'imagery.json')))
keep = {f'L{n}_{i}_{j}.webp' for n, lv in img['levels'].items() for i, j in lv['tiles']}
removed = []
for f in sorted(os.listdir(os.path.join(DATA, 'tiles'))):
    if f not in keep:
        os.remove(os.path.join(DATA, 'tiles', f)); removed.append('data/tiles/' + f)
print('tiles kept', len(keep), 'removed', len(removed))
# alignment: 'T3118' tag text box (PDF, canonical pt) must contain ink in the detail tile
ox, oy = img['tileOrigin']; size = img['tileSize'] / img['tileK']; K = img['tileK']
x0, y0, x1, y1 = 1274.4, 840.8, 1290.0, 850.1
i, j = int((x0 - ox) // size), int((y0 - oy) // size)
t = np.array(Image.open(os.path.join(DATA, 'tiles', f'L3_{i}_{j}.webp')).convert('L')).astype(float)
X0, Y0 = int((x0 - ox - i * size) * K), int((y0 - oy - j * size) * K)
box = t[Y0:Y0 + int((y1 - y0) * K), X0:X0 + int((x1 - x0) * K)]
above = t[Y0 - int(20 * K):Y0 - int(12 * K), X0:X0 + int((x1 - x0) * K)]
print(f'T3118 tag box ink {box.mean():.1f} vs 12-20 pt above {above.mean():.1f}  (box should be clearly higher)')
files = {os.path.relpath(os.path.join(dp, f), os.path.join(ROOT, 'web')): os.path.join(dp, f)
         for dp, _, fs in os.walk(DATA) for f in fs}
out = {k: os.path.relpath(v, os.getcwd()) for k, v in sorted(files.items())}
for r in removed:
    out[r] = None
json.dump(out, open(os.path.join(ROOT, 'dist', 'artifact', 'files_update.json'), 'w'))
print('file map entries', len(out))
