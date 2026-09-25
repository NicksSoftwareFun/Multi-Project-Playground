#!/usr/bin/env python3
"""Assemble the single-page artifact variant: inline CSS + JS, Google Fonts, no
service worker or manifest (the artifact host does not run them)."""
import os, re, json
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, 'web')
OUT = os.path.join(ROOT, 'dist', 'artifact')
html = open(os.path.join(WEB, 'index.html')).read()
css = open(os.path.join(WEB, 'app.css')).read()
js = open(os.path.join(WEB, 'app.js')).read()
body = html.split('<!--BODY-->')[1].split('<!--/BODY-->')[0]
page = ('<title>MIH Tower Explorer</title>\n'
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600'
        '&family=IBM+Plex+Sans+Condensed:wght@500;600;700&display=swap">\n'
        f'<style>\n{css}\n</style>\n{body}\n<script>\n{js}\n</script>\n')
os.makedirs(OUT, exist_ok=True)
open(os.path.join(OUT, 'index.html'), 'w').write(page)
files = {}
for dp, _, fs in os.walk(os.path.join(WEB, 'data')):
    for f in fs:
        full = os.path.join(dp, f)
        files[os.path.relpath(full, WEB)] = os.path.relpath(full, os.getcwd())
json.dump(files, open(os.path.join(OUT, 'files.json'), 'w'), indent=0)
print(len(files), 'data files;', os.path.getsize(os.path.join(OUT, 'index.html')) // 1024, 'KB page')
