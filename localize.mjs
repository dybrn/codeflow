/**
 * localize.mjs — Download all CDN dependencies for CodeFlow and produce:
 *
 *   vendor/              All JS, WASM, and font files
 *   index.local.html     Fully offline copy of the app
 *   index.html           Original file updated with SRI integrity hashes
 *
 * Usage:  node localize.mjs
 * Requires: Node 18+ (built-in fetch)
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE       = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = join(HERE, 'vendor');
const FONTS_DIR  = join(VENDOR_DIR, 'fonts');
const INDEX_HTML  = join(HERE, 'index.html');
const INDEX_LOCAL = join(HERE, 'index.local.html');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── CDN <script> tags ────────────────────────────────────────────────────────
const SCRIPTS = [
  ['https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js',         'react.production.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', 'react-dom.production.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.5/babel.min.js',             'babel.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js',                              'd3.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/d3-sankey/0.12.3/d3-sankey.min.js',               'd3-sankey.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/acorn/8.11.3/acorn.min.js',                       'acorn.min.js'],
  ['https://cdn.jsdelivr.net/npm/web-tree-sitter@0.25.10/tree-sitter.js',                     'tree-sitter.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/jsrsasign/11.1.0/jsrsasign-all-min.js',           'jsrsasign-all-min.js'],
];

// ── WASM blobs (referenced at runtime by JS, no SRI needed) ─────────────────
const WASM_FILES = [
  ['https://cdn.jsdelivr.net/npm/web-tree-sitter@0.25.10/tree-sitter.wasm',              'tree-sitter.wasm'],
  ['https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.13/out/tree-sitter-python.wasm', 'tree-sitter-python.wasm'],
];

const GOOGLE_FONTS_URL = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sriHash(filePath) {
  const buf = readFileSync(filePath);
  return 'sha384-' + createHash('sha384').update(buf).digest('base64');
}

async function download(url, dest, label) {
  label ??= url.split('/').pop();
  if (existsSync(dest)) {
    console.log(`  skip  ${label}`);
    return;
  }
  process.stdout.write(`  fetch ${label} … `);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const kb = (statSync(dest).size / 1024).toFixed(0);
  console.log(`${kb} KB`);
}

async function downloadFonts() {
  process.stdout.write('  fetch Google Fonts CSS … ');
  const res = await fetch(GOOGLE_FONTS_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching Google Fonts`);
  let css = await res.text();
  console.log('ok');

  const fontUrls = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)]
    .map(m => m[1]);

  mkdirSync(FONTS_DIR, { recursive: true });
  for (const url of fontUrls) {
    const filename = url.split('/').pop().split('?')[0];
    const dest = join(FONTS_DIR, filename);
    await download(url, dest, `fonts/${filename}`);
    // Path is relative to vendor/jetbrains-mono.css, so: fonts/<file>
    css = css.replaceAll(url, `fonts/${filename}`);
  }
  return css;
}

// ── Main ──────────────────────────────────────────────────────────────────────

mkdirSync(VENDOR_DIR, { recursive: true });
mkdirSync(FONTS_DIR,  { recursive: true });

// 1. JS scripts
console.log('\n[ JS scripts ]');
const sriMap = {};
for (const [url, filename] of SCRIPTS) {
  const dest = join(VENDOR_DIR, filename);
  await download(url, dest);
  sriMap[url] = sriHash(dest);
  console.log(`         ${sriMap[url]}`);
}

// 2. WASM blobs
console.log('\n[ WASM files ]');
for (const [url, filename] of WASM_FILES) {
  await download(url, join(VENDOR_DIR, filename));
}

// 3. Fonts
console.log('\n[ Google Fonts ]');
const fontCss = await downloadFonts();
writeFileSync(join(VENDOR_DIR, 'jetbrains-mono.css'), fontCss, 'utf8');
console.log('  wrote vendor/jetbrains-mono.css');

// Read source HTML once
const original = readFileSync(INDEX_HTML, 'utf8');

// 4. Apply SRI hashes → index.html
console.log('\n[ Applying SRI hashes → index.html ]');
let secured = original;
for (const [url, filename] of SCRIPTS) {
  const newTag = `<script src="${url}" integrity="${sriMap[url]}" crossorigin="anonymous"></script>`;
  // Match bare tag or tag that already has integrity/crossorigin attributes
  const re = new RegExp(`<script src="${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*></script>`);
  if (re.test(secured)) {
    secured = secured.replace(re, newTag);
    console.log(`  ok    ${filename}`);
  } else {
    console.log(`  WARN  tag not found for ${filename}`);
  }
}
writeFileSync(INDEX_HTML, secured, 'utf8');
console.log('  index.html saved.');

// 5. Build index.local.html
console.log('\n[ Building index.local.html ]');
let local = original;

for (const [url, filename] of SCRIPTS) {
  local = local.replaceAll(
    `<script src="${url}"></script>`,
    `<script src="vendor/${filename}"></script>`,
  );
  console.log(`  ok    vendor/${filename}`);
}

// Google Fonts link (HTML-encoded & in the href)
const oldFont = '<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&amp;display=swap" rel="stylesheet">';
const newFont = '<link href="vendor/jetbrains-mono.css" rel="stylesheet">';
if (local.includes(oldFont)) {
  local = local.replace(oldFont, newFont);
  console.log('  ok    vendor/jetbrains-mono.css');
} else {
  console.log('  WARN  Google Fonts <link> not found — font will fall back to monospace');
}

// tree-sitter.wasm locateFile
const oldLocate = "return 'https://cdn.jsdelivr.net/npm/web-tree-sitter@0.25.10/'+scriptName;";
const newLocate = "return 'vendor/'+scriptName;";
if (local.includes(oldLocate)) {
  local = local.replace(oldLocate, newLocate);
  console.log('  ok    tree-sitter locateFile → vendor/');
} else {
  console.log('  WARN  tree-sitter locateFile not found');
}

// Python WASM URL
const oldPyWasm = "'https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.13/out/tree-sitter-python.wasm'";
const newPyWasm = "'vendor/tree-sitter-python.wasm'";
if (local.includes(oldPyWasm)) {
  local = local.replace(oldPyWasm, newPyWasm);
  console.log('  ok    tree-sitter-python.wasm → vendor/');
} else {
  console.log('  WARN  tree-sitter-python.wasm URL not found');
}

writeFileSync(INDEX_LOCAL, local, 'utf8');
console.log('  index.local.html saved.');

// Summary
let totalBytes = 0;
function du(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) du(full);
    else totalBytes += statSync(full).size;
  }
}
du(VENDOR_DIR);
console.log(`\n[ Done ] vendor/ is ${(totalBytes / 1024 / 1024).toFixed(1)} MB total`);
console.log();
console.log('  index.html        — online version with SRI-protected CDN references');
console.log('  index.local.html  — fully offline, open directly in any browser');
console.log('  vendor/           — all JS, WASM, and font files');
