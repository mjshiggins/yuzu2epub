// Builds a synthetic EPUB using the extension's own lib code, so the zip
// writer and package builder can be validated outside Chrome.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', 'extension', 'lib');
const ctx = {
  self: {}, console, TextEncoder, TextDecoder, Response, CompressionStream,
  Blob, DataView, Uint8Array, ArrayBuffer, Date, Math, crypto, JSON, String, Array, Object, Number,
};
vm.createContext(ctx);
for (const f of ['zip.js', 'xml.js', 'stylesheet.js', 'epub.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
}

// Synthetic structure mirroring the real book's shape: front matter at depth 0,
// Parts at depth 0 with chapters nested at depth 1.
const spec = [
  ['Cover', 0, 'i'], ['Title Page', 0, 'iii'], ['Preface', 0, 'vii'],
  ['Part I Placeholder', 0, '1'],
  ['1 First Chapter', 1, '3'], ['2 Second Chapter', 1, '39'],
  ['Part II Placeholder', 0, '127'],
  ['3 Third Chapter', 1, '129'],
];
const sections = spec.map(([title, depth, page], i) => {
  const n = String(i + 1).padStart(4, '0');
  return {
    id: `sec-${n}`,
    title,
    filename: `text/section-${n}.xhtml`,
    depth,
    hasMathML: i === 4,
    pages: [{ id: `page-${page}`, label: page }],
    body: `<section class="y2e-chapter-title"><h1>${title}</h1>`
      + `<span class="y2e-pagebreak" id="page-${page}" epub:type="pagebreak" title="${page}"></span>`
      + `<p>Placeholder body text for structural validation.</p>`
      + (i === 4 ? '<p><m:math xmlns:m="http://www.w3.org/1998/Math/MathML"><m:mi>x</m:mi></m:math></p>' : '')
      + `<p><img src="../images/img-0001.png" alt="placeholder"/></p></section>`,
  };
});

// 1x1 PNG.
const png = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'));

const blob = await ctx.self.YuzuEpub.buildEpub({
  title: 'Structural Fixture',
  authors: ['Author One', 'Author Two'],
  language: 'en',
  isbn: '9780000000000',
  publisher: 'Test Publisher',
  sections,
  images: [{ id: 'img-0001', href: 'images/img-0001.png', mediaType: 'image/png', data: png }],
  cover: { data: png, mediaType: 'image/png' },
});

const out = path.resolve(import.meta.dirname, 'fixture.epub');
fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
console.log('wrote', out, fs.statSync(out).size, 'bytes');
