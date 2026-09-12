/**
 * Scale test, shaped from a real textbook: 741 sections nested four levels
 * deep. The first book this was built against had 43 sections and two levels,
 * which hid both the hardcoded NCX depth and the cost of the nav generator.
 *
 * Titles here are synthetic. Only the structural shape is taken from the real
 * book: entry count, maximum depth, and that nesting never jumps more than one
 * level at a time.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const ext = path.resolve(import.meta.dirname, '..', 'extension');
const ctx = {
  self: {}, console, TextEncoder, TextDecoder, Response, CompressionStream,
  Blob, DataView, Uint8Array, ArrayBuffer, Date, Math, crypto, JSON, String, Array, Object, Number,
};
vm.createContext(ctx);
for (const f of ['zip.js', 'xml.js', 'stylesheet.js', 'epub.js']) {
  vm.runInContext(fs.readFileSync(path.join(ext, 'lib', f), 'utf8'), ctx, { filename: f });
}

const TOTAL = 741;
const sections = [];
let depth = 0;
for (let i = 0; i < TOTAL; i++) {
  // Front matter flat, then a repeating Part / Chapter / Section / Subsection
  // cycle that never descends more than one level in a step.
  if (i < 12) depth = 0;
  else if (i % 61 === 0) depth = 0;
  else if (i % 17 === 0) depth = 1;
  else if (i % 5 === 0) depth = 2;
  else depth = Math.min(3, depth === 0 ? 1 : depth === 1 ? 2 : 3);

  const n = String(i + 1).padStart(4, '0');
  const page = i < 6 ? 'ivxlcdm'.slice(0, (i % 5) + 1) : String(i * 2);
  sections.push({
    id: `sec-${n}`,
    filename: `text/section-${n}.xhtml`,
    title: `Synthetic Section ${i + 1} with a reasonably long heading`,
    depth,
    pages: [{ id: 'y2e-page-1', label: page }],
    hasMathML: i % 40 === 0,
    hasSvg: false,
    body: `<div class="y2e-section"><h1>Synthetic Section ${i + 1}</h1>`
      + `<span class="y2e-pagebreak" id="y2e-page-1" epub:type="pagebreak" title="${page}"></span>`
      + `<p>Placeholder body.</p>`
      + (i % 40 === 0 ? '<p><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math></p>' : '')
      + `</div>`,
  });
}

const png = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'));

const t0 = Date.now();
const blob = await ctx.self.YuzuEpub.buildEpub({
  title: 'Scale Fixture', authors: ['A. Author'], language: 'en',
  isbn: '9790000000000', sections, images: [], cover: { data: png, mediaType: 'image/png' },
});
const ms = Date.now() - t0;

const out = path.resolve(import.meta.dirname, 'scale.epub');
fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));

let fail = 0;
const check = (n, c, d) => {
  console.log(`  ${c ? 'ok   ' : 'FAIL '} ${n}${c ? '' : '  <- ' + d}`);
  if (!c) fail++;
};
console.log('=== scale: 741 sections, 4 levels ===');
const tree = ctx.self.YuzuEpub.buildTree(sections);
const treeDepth = ctx.self.YuzuEpub.treeDepth(tree);
check('tree reaches 4 levels', treeDepth === 4, `got ${treeDepth}`);
check('every section is reachable in the tree', (function count(ns) {
  return ns.reduce((a, n) => a + 1 + count(n.children), 0);
})(tree) === TOTAL, 'sections lost while nesting');
check('build completed under 20s', ms < 20000, `${ms}ms`);
console.log(`  info  built in ${ms}ms, ${(blob.size / 1024).toFixed(0)} KB`);
process.exit(fail ? 1 : 0);
