// Builds dist/voidrunner.html - the whole game as one file you can double-click.
//
//   node tools/build-single.mjs
//
// Needs esbuild, which it fetches through npx if it is not already installed.
// The normal way to play is to serve the folder over HTTP; this build exists so
// the game can be handed to someone as a single attachment. It drops the PWA
// manifest (meaningless from file://) and inlines the stylesheet, the icon and
// every module - including three.js - into one document.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const TMP = join(DIST, '.bundle.js');

mkdirSync(DIST, { recursive: true });

function bundle() {
  const args = [
    join(ROOT, 'src', 'main.js'),
    '--bundle',
    '--format=iife',
    '--minify',
    '--target=es2020',
    '--legal-comments=none',
    `--outfile=${TMP}`,
  ];
  const local = join(ROOT, '..', 'node_modules', '.bin', 'esbuild');
  try {
    if (existsSync(local)) execFileSync(local, args, { stdio: 'inherit' });
    else execFileSync('npx', ['--yes', 'esbuild@0.28', ...args], { stdio: 'inherit' });
  } catch (err) {
    console.error('\nesbuild failed. Install it with `npm i -D esbuild` and retry.');
    throw err;
  }
  return readFileSync(TMP, 'utf8');
}

const js = bundle();
const css = readFileSync(join(ROOT, 'styles.css'), 'utf8');
const icon = readFileSync(join(ROOT, 'icons', 'favicon-64.png')).toString('base64');

let html = readFileSync(join(ROOT, 'index.html'), 'utf8');

const drop = [
  /^\s*<link rel="manifest"[^>]*>\s*$/m,
  /^\s*<link rel="apple-touch-icon"[^>]*>\s*$/m,
];
for (const re of drop) html = html.replace(re, '');

// Replacer FUNCTIONS, not strings: the minified bundle is full of `$`
// sequences, and String.replace would read `$&` and friends as backreferences
// and splice the original tag straight back into the output.
html = html.replace(
  /^\s*<link rel="icon"[^>]*>\s*$/m,
  () => `<link rel="icon" href="data:image/png;base64,${icon}">`,
);
html = html.replace(
  /^\s*<link rel="stylesheet" href="styles\.css">\s*$/m,
  () => `<style>\n${css}\n</style>`,
);
html = html.replace(
  /^\s*<script type="module" src="src\/main\.js"><\/script>\s*$/m,
  () => `<script>\n${js}\n</script>`,
);

for (const [what, needle] of [['stylesheet', '<style>'], ['script', '<script>']]) {
  if (!html.includes(needle)) throw new Error(`inline ${what} failed - index.html markup changed?`);
}
if (html.includes('src="src/main.js"')) throw new Error('module script was not replaced');

const out = join(DIST, 'voidrunner.html');
writeFileSync(out, html);
rmSync(TMP, { force: true });

console.log(`\nwrote dist/voidrunner.html  (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB)`);
