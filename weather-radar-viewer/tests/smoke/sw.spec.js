// Service-worker shell audit (pure Node, no browser):
//  1. sw.js's SHELL array must list exactly the on-disk app-shell files
//     (pwa/**/*.{html,css,js,webmanifest,png}, minus sw.js itself).
//  2. sw.js must route non-same-origin requests straight to the network and
//     never mention (let alone cache) api.* data domains.
"use strict";
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const PWA = path.resolve(__dirname, "..", "..", "pwa");
const SHELL_EXTS = new Set([".html", ".css", ".js", ".webmanifest", ".png"]);

function walk(dir, base) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(abs, base));
    else out.push(path.relative(base, abs).split(path.sep).join("/"));
  }
  return out;
}

function readSw() {
  return fs.readFileSync(path.join(PWA, "sw.js"), "utf8");
}

test("sw.js SHELL matches the on-disk app shell exactly", () => {
  const src = readSw();
  const m = src.match(/const\s+SHELL\s*=\s*\[([\s\S]*?)\]/);
  expect(m, "sw.js must declare a SHELL array").toBeTruthy();
  const shell = [...m[1].matchAll(/["']([^"']+)["']/g)]
    .map((x) => x[1])
    .filter((p) => p !== "./" && !/^https?:/.test(p));

  const files = walk(PWA, PWA)
    .filter((rel) => SHELL_EXTS.has(path.extname(rel).toLowerCase()))
    .filter((rel) => rel !== "sw.js")
    .map((rel) => "./" + rel);

  const shellSet = new Set(shell);
  const fileSet = new Set(files);
  const missingFromShell = files.filter((f) => !shellSet.has(f)).sort();
  const staleInShell = shell.filter((s) => !fileSet.has(s)).sort();

  expect(missingFromShell, "app-shell files on disk but absent from sw.js SHELL").toEqual([]);
  expect(staleInShell, "sw.js SHELL entries with no matching file on disk").toEqual([]);
});

test("sw.js sends cross-origin data requests to the network, never the cache", () => {
  const src = readSw();

  // there is a fetch handler and it discriminates on the request's origin
  expect(src).toMatch(/addEventListener\(\s*["']fetch["']/);
  expect(src).toMatch(/origin\s*[!=]==\s*self\.location\.origin/);

  // no api data domain is ever named in the worker — nothing api-shaped can
  // be matched into a cache bucket
  expect(src).not.toMatch(/api\.[a-z0-9-]+\.(com|gov|us|org|net)/i);

  // the non-same-origin / non-CDN branch bails out without respondWith,
  // i.e. an early `return` tied to the origin test exists in the handler
  const fetchBody = src.slice(src.search(/addEventListener\(\s*["']fetch["']/));
  expect(fetchBody).toMatch(/if\s*\([^)]*\)\s*return\s*;/);
});
