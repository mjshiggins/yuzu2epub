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
import { loadInjected } from './inject.mjs';

const ext = path.resolve(import.meta.dirname, '..', 'extension');

function sectionHtml(n, withMath) {
  const contentsPage = n === 1 ? `
      <nav><p><a href="chapter2.xhtml">1 First Chapter</a></p>
      <p><a href="chapter3.xhtml#start">2 Second Chapter</a></p>
      <p><a href="chapter99.xhtml">A chapter that was never extracted</a></p></nav>` : '';
  return `<!doctype html><html><head><title>Section ${n}</title></head><body>
    <div class="Toolbar__x">chrome</div>
    <section>
      <h1>Section ${n} Heading</h1>
      <span epub:type="pagebreak" id="page_${n}0" title="${n}0"></span>
      <p>Invented paragraph for section ${n}.</p>
      ${contentsPage}
      <img src="https://jigsaw.yuzu.com/img/shared.png">
      <img src="https://jigsaw.yuzu.com/img/only-${n}.png">
      <span id="page_${n}1" title="${n}1"></span>
      ${withMath ? '<p><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>a</mi></math></p>' : ''}
      ${withMath ? '<mjx-container display="true"><svg viewBox="0 0 10 10"><use xlink:href="#G1"/></svg></mjx-container>' : ''}
    </section>
    <svg id="MJX-SVG-global-cache"><defs><path id="G1" d="M0 0 L1 1"/></defs></svg>
  </body></html>`;
}

const EXTRACT_JS = path.join(ext, 'injected', 'extract.js');

async function extractOne(html, url) {
  const dom = new JSDOM(html, { url });
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; }, configurable: true,
  });
  const injected = loadInjected(EXTRACT_JS, 'yuzuExtractSection', {
    window, document: window.document, Node: window.Node, NodeFilter: window.NodeFilter,
    XMLSerializer: window.XMLSerializer, Event: window.Event,
    Object, Math, Date, Promise, setTimeout, console, Array, String, Map, Set, JSON, RegExp, Error, TypeError, URL,
  });
  return injected.call({ settleMs: 40, maxSettleMs: 600, scrollStepMs: 1, imageTimeoutMs: 60 });
}

// --- extract three sections, shaped like Part -> two chapters --------------
const specs = [
  { title: 'Part I Placeholder', depth: 0, page: '1', math: false },
  { title: '1 First Chapter', depth: 1, page: '10', math: true },
  { title: '2 Second Chapter', depth: 1, page: '20', math: false },
];

const sections = [];
for (let i = 0; i < specs.length; i++) {
  const srcUrl = `https://jigsaw.yuzu.com/books/x/chapter${i + 1}.xhtml`;
  const out = await extractOne(sectionHtml(i + 1, specs[i].math), srcUrl);
  if (out.error || out.skip) throw new Error(`extraction ${i} failed: ${out.error || 'skipped'}`);
  const n = String(i + 1).padStart(4, '0');
  sections.push({
    id: `sec-${n}`, filename: `text/section-${n}.xhtml`,
    title: specs[i].title, depth: specs[i].depth, page: specs[i].page,
    body: out.xhtml, images: out.images, pages: out.pages,
    links: out.links, sourceUrl: srcUrl,
    hasMathML: out.hasMathML, hasSvg: out.hasSvg,
  });
}

// --- run the real assembler, with fetch and chrome.* stubbed --------------
const ctx = {
  self: {}, console, TextEncoder, TextDecoder, Response, CompressionStream,
  Blob, DataView, Uint8Array, ArrayBuffer, Date, Math, crypto, JSON, String,
  Array, Object, Number, Promise, Map, Set, RegExp, Error, URL, atob, setTimeout,
};
vm.createContext(ctx);
for (const f of ['zip.js', 'xml.js', 'stylesheet.js', 'epub.js', 'assemble.js']) {
  vm.runInContext(fs.readFileSync(path.join(ext, 'lib', f), 'utf8'), ctx, { filename: f });
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

// One URL always fails, to prove a missing image degrades instead of breaking
// the build with a dangling manifest reference.
const FAILING = 'https://jigsaw.yuzu.com/img/only-3.png';
let fetchCalls = 0;
ctx.fetch = async (url) => {
  fetchCalls++;
  if (url === FAILING) return { ok: false, status: 404, headers: { get: () => null } };
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => (h === 'content-type' ? 'image/png' : null) },
    arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
  };
};
// No reader tab in this harness, so the in-page fallback is unavailable.
ctx.chrome = { scripting: { executeScript: async () => [] } };

// assembleEpub closes over the VM's globals, so it can be called directly.
const asm = await ctx.self.YuzuAssemble.assembleEpub(
  {
    meta: {
      title: 'Pipeline Fixture', authors: ['A. Author'], language: 'en',
      isbn: '9780000000001',
      coverUrl: 'https://covers.vitalsource.com/vbid/9780000000001/width/1400',
    },
    sections,
  },
  null,        // no reader tab in this harness
  () => {},    // progress sink
);

const blob = asm.blob;
const out = path.resolve(import.meta.dirname, 'pipeline.epub');
fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));

// --- invariants the validator cannot see ----------------------------------
let fail = 0;
const check = (n, c, d) => { console.log(`  ${c ? 'ok   ' : 'FAIL '} ${n}${c ? '' : '  <- ' + d}`); if (!c) fail++; };
console.log('=== pipeline ===');
const totalPages = sections.reduce((a, s) => a + s.pages.length, 0);
check('page markers survived cleaning', totalPages === 6, `got ${totalPages}`);
check('shared image fetched once across sections', fetchCalls === 5, `fetches: ${fetchCalls}`);
check('assembler reported the failed image', asm.failedImages === 1, `got ${asm.failedImages}`);
check('contents page links to chapter 1', /href="section-0002\.xhtml"/.test(sections[0].body),
  'contents link not rewritten');
check('contents page link keeps its fragment',
  /href="section-0003\.xhtml#start"/.test(sections[0].body), 'fragment lost');
check('unmatched link unwrapped to plain text',
  !/chapter99/.test(sections[0].body)
  && /A chapter that was never extracted/.test(sections[0].body),
  'unresolved link not unwrapped');
check('no unresolved link tokens remain',
  !sections.some((s) => /__Y2E_LINK_/.test(s.body)), 'token left in body');
check('resolution counts reported',
  asm.linksResolved === 2 && asm.linksDropped === 1,
  `resolved ${asm.linksResolved}, dropped ${asm.linksDropped}`);
check('failed image degraded to a marker',
  sections.some((s) => s.body.includes('image unavailable')), 'no fallback marker');
for (const s of sections) {
  check(`${s.id}: no unrewritten tokens`, !/__Y2E_IMG_/.test(s.body));
  for (const p of s.pages) {
    check(`${s.id}: page-list id ${p.id} exists in body`,
      s.body.includes(`id="${p.id}"`), 'dangling page-list target');
  }
}
console.log(`  wrote ${out} (${blob.size} bytes)`);
process.exit(fail ? 1 : 0);
