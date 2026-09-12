/**
 * End-to-end: run the real extractor over synthetic sections, apply the same
 * token rewriting the offscreen assembler does, build the EPUB with the real
 * builder, and hand the result to the validator.
 *
 * This is the test that catches cross-stage mismatches: page-list entries
 * pointing at ids the cleaner removed, image tokens that never got rewritten,
 * manifest properties that disagree with the content.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const ext = path.resolve(import.meta.dirname, '..', 'extension');

function sectionHtml(n, withMath) {
  return `<!doctype html><html><head><title>Section ${n}</title></head><body>
    <div class="Toolbar__x">chrome</div>
    <section>
      <h1>Section ${n} Heading</h1>
      <span epub:type="pagebreak" id="page_${n}0" title="${n}0"></span>
      <p>Invented paragraph for section ${n}.</p>
      <img src="https://jigsaw.yuzu.com/img/shared.png">
      <img src="https://jigsaw.yuzu.com/img/only-${n}.png">
      <span id="page_${n}1" title="${n}1"></span>
      ${withMath ? '<p><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>a</mi></math></p>' : ''}
      ${withMath ? '<mjx-container display="true"><svg viewBox="0 0 10 10"><use xlink:href="#G1"/></svg></mjx-container>' : ''}
    </section>
    <svg id="MJX-SVG-global-cache"><defs><path id="G1" d="M0 0 L1 1"/></defs></svg>
  </body></html>`;
}

const extractSrc = fs.readFileSync(path.join(ext, 'injected', 'extract.js'), 'utf8');

async function extractOne(html) {
  const dom = new JSDOM(html, { url: 'https://jigsaw.yuzu.com/books/x/s.xhtml' });
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; }, configurable: true,
  });
  const ctx = {
    window, document: window.document, Node: window.Node, NodeFilter: window.NodeFilter,
    XMLSerializer: window.XMLSerializer, Event: window.Event,
    Object, Math, Date, Promise, setTimeout, console, Array, String, Map, Set, JSON, RegExp, Error, TypeError,
  };
  vm.createContext(ctx);
  vm.runInContext(extractSrc, ctx, { filename: 'extract.js' });
  return vm.runInContext(
    'yuzuExtractSection({settleMs:40,maxSettleMs:600,scrollStepMs:1,imageTimeoutMs:60})', ctx);
}

// --- extract three sections, shaped like Part -> two chapters --------------
const specs = [
  { title: 'Part I Placeholder', depth: 0, page: '1', math: false },
  { title: '1 First Chapter', depth: 1, page: '10', math: true },
  { title: '2 Second Chapter', depth: 1, page: '20', math: false },
];

const sections = [];
for (let i = 0; i < specs.length; i++) {
  const out = await extractOne(sectionHtml(i + 1, specs[i].math));
  if (out.error || out.skip) throw new Error(`extraction ${i} failed: ${out.error || 'skipped'}`);
  const n = String(i + 1).padStart(4, '0');
  sections.push({
    id: `sec-${n}`, filename: `text/section-${n}.xhtml`,
    title: specs[i].title, depth: specs[i].depth, page: specs[i].page,
    body: out.xhtml, images: out.images, pages: out.pages,
    hasMathML: out.hasMathML, hasSvg: out.hasSvg,
  });
}

// --- replicate the offscreen assembler's token rewriting -------------------
const byUrl = new Map();
for (const s of sections) {
  for (const img of s.images) {
    if (!byUrl.has(img.url)) {
      const n = String(byUrl.size + 1).padStart(4, '0');
      byUrl.set(img.url, { id: `img-${n}`, href: `images/img-${n}.png`, mediaType: 'image/png' });
    }
  }
}
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const s of sections) {
  for (const img of s.images) {
    s.body = s.body.replace(new RegExp(esc(img.token), 'g'), `../${byUrl.get(img.url).href}`);
  }
  delete s.images;
}

const png = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'));
const images = [...byUrl.values()].map((a) => ({ ...a, data: png }));

// --- build with the real builder ------------------------------------------
const ctx = {
  self: {}, console, TextEncoder, TextDecoder, Response, CompressionStream,
  Blob, DataView, Uint8Array, ArrayBuffer, Date, Math, crypto, JSON, String, Array, Object, Number,
};
vm.createContext(ctx);
for (const f of ['zip.js', 'xml.js', 'stylesheet.js', 'epub.js']) {
  vm.runInContext(fs.readFileSync(path.join(ext, 'lib', f), 'utf8'), ctx, { filename: f });
}
const blob = await ctx.self.YuzuEpub.buildEpub({
  title: 'Pipeline Fixture', authors: ['A. Author'], language: 'en',
  isbn: '9780000000001', sections, images,
  cover: { data: png, mediaType: 'image/png' },
});
const out = path.resolve(import.meta.dirname, 'pipeline.epub');
fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));

// --- invariants the validator cannot see ----------------------------------
let fail = 0;
const check = (n, c, d) => { console.log(`  ${c ? 'ok   ' : 'FAIL '} ${n}${c ? '' : '  <- ' + d}`); if (!c) fail++; };
console.log('=== pipeline ===');
const totalPages = sections.reduce((a, s) => a + s.pages.length, 0);
check('page markers survived cleaning', totalPages === 6, `got ${totalPages}`);
check('shared image deduped across sections', images.length === 4, `got ${images.length}`);
for (const s of sections) {
  check(`${s.id}: no unrewritten tokens`, !/__Y2E_IMG_/.test(s.body));
  for (const p of s.pages) {
    check(`${s.id}: page-list id ${p.id} exists in body`,
      s.body.includes(`id="${p.id}"`), 'dangling page-list target');
  }
}
console.log(`  wrote ${out} (${blob.size} bytes)`);
process.exit(fail ? 1 : 0);
