/**
 * Runs the real injected/extract.js against a synthetic document shaped like a
 * Yuzu content frame: reader chrome to strip, publisher classes and inline
 * styles, a MathJax SVG container with a document-wide glyph cache, page-break
 * markers, custom elements, a print warning, and cross-section links.
 *
 * All content here is invented placeholder text.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { loadInjected } from './inject.mjs';

const EXTRACT_JS = path.resolve(
  import.meta.dirname, '..', 'extension', 'injected', 'extract.js');

const HTML = `<!doctype html><html><head><title>Chapter Fixture</title>
<style>.para { color: red }</style></head>
<body>
  <div class="Toolbar__wrap-xYz">reader toolbar that must not survive</div>
  <div role="dialog">a modal that must not survive</div>
  <div class="annotation-layer">highlight overlay</div>
  <p class="printWarn">To print, please use the print page range feature within the application.</p>

  <section class="chapter-body" style="width:720px;position:absolute">
    <h1 class="ChapterTitle-aBc" style="color:#09f">Sample Chapter Title</h1>

    <span epub:type="pagebreak" id="page_3" title="3"></span>
    <p class="para" style="text-indent:1em">First paragraph of invented body text.</p>

    <custom-publisher-widget data-x="1">
      <p>Text inside a custom element should survive when the wrapper is dropped.</p>
    </custom-publisher-widget>

    <figure class="fig">
      <img src="https://jigsaw.yuzu.com/books/x/images/fig1.png" class="lazy" data-src="ignored">
      <figcaption>Figure caption text.</figcaption>
    </figure>
    <p><img src="https://jigsaw.yuzu.com/books/x/images/fig1.png"> repeated image, same URL</p>

    <table class="tbl" style="width:700px">
      <caption>Table caption</caption>
      <thead><tr><th style="width:200px">Head A</th><th>Head B</th></tr></thead>
      <tbody><tr><td colspan="2">Cell spanning two columns</td></tr></tbody>
    </table>

    <span id="page_4" title="4"></span>
    <p>An <a href="#local-anchor">in-section link</a>, an
       <a href="https://example.com/x">external link</a>, and a
       <a href="../chapter9.xhtml#sec2">cross-section link</a>.</p>
    <p id="local-anchor">Anchor target.</p>

    <p>Inline math <mjx-container class="MathJax" jax="SVG"><svg viewBox="0 0 100 40" width="2ex"><g><use xlink:href="#MJX-GLYPH-A"></use><use xlink:href="#MJX-GLYPH-B"></use></g></svg><mjx-assistive-mml><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math></mjx-assistive-mml></mjx-container> in a sentence.</p>

    <mjx-container class="MathJax" jax="SVG" display="true"><svg viewBox="0 0 200 60"><g><use xlink:href="#MJX-GLYPH-A"></use></g></svg><mjx-assistive-mml><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>y</mi></math></mjx-assistive-mml></mjx-container>

    <p>MathML with no MathJax wrapper: <math><mi>z</mi></math></p>

    <p></p><div></div><span>   </span>
    <script>window.tracking = 1;</script>
  </section>

  <svg id="MJX-SVG-global-cache" style="display:none"><defs>
    <path id="MJX-GLYPH-A" d="M0 0 L10 10"></path>
    <path id="MJX-GLYPH-B" d="M5 5 L15 15"></path>
  </defs></svg>
</body></html>`;

const dom = new JSDOM(HTML, { url: 'https://jigsaw.yuzu.com/books/x/chapter1.xhtml' });
const { window } = dom;

// jsdom has no layout, so innerText is undefined. The extractor's scoring
// falls back through it; give it the standard alias.
Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
  get() { return this.textContent; },
});

// Injected the way chrome.scripting delivers it: this function's source alone.
const extract = loadInjected(EXTRACT_JS, 'yuzuExtractSection', {
  window, document: window.document, Node: window.Node,
  NodeFilter: window.NodeFilter, XMLSerializer: window.XMLSerializer,
  Event: window.Event, Object, Math, Date, Promise, setTimeout, console,
  Array, String, Map, Set, JSON, RegExp, Error, TypeError, URL,
});

const out = await extract.call(
  { settleMs: 60, maxSettleMs: 900, scrollStepMs: 1, imageTimeoutMs: 100 });

// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}

console.log('=== extract.js against synthetic Yuzu frame ===');
if (out.error) { console.log('EXTRACTOR ERROR:', out.error); process.exit(1); }
const x = out.xhtml;

check('returned XHTML', typeof x === 'string' && x.length > 200);
check('reader toolbar stripped', !/reader toolbar/.test(x));
check('modal stripped', !/must not survive/.test(x));
check('annotation layer stripped', !/highlight overlay/.test(x));
check('print warning stripped', !/print page range/.test(x));
check('script stripped', !/window\.tracking/.test(x));
check('heading kept', /<h1[^>]*>Sample Chapter Title<\/h1>/.test(x));
check('body text kept', /First paragraph of invented body text/.test(x));
check('custom element unwrapped, content kept',
  !/custom-publisher-widget/.test(x) && /Text inside a custom element/.test(x));
check('inline styles removed', !/style="/.test(x));
check('publisher classes removed', !/class="(para|fig|tbl|chapter-body)"/.test(x));
check('table structure kept', /<table>/.test(x) && /<th>Head A<\/th>/.test(x));
check('colspan preserved', /colspan="2"/.test(x));
check('figcaption kept', /<figcaption>Figure caption text\.<\/figcaption>/.test(x));

check('images tokenised', /__Y2E_IMG_1__/.test(x));
check('duplicate image URL deduped to one token',
  out.images.length === 1, `got ${out.images.length} image records`);
check('image token count in body is 2',
  (x.match(/__Y2E_IMG_1__/g) || []).length === 2);

check('page markers found', out.pages.length === 2, JSON.stringify(out.pages));
check('page labels parsed', out.pages.map(p => p.label).join(',') === '3,4',
  out.pages.map(p => p.label).join(','));
check('pagebreak has epub:type', /epub:type="pagebreak"/.test(x));

check('in-section anchor kept', /href="#local-anchor"/.test(x));
check('external link kept', /href="https:\/\/example\.com\/x"/.test(x));
check('cross-section link tokenised for later resolution',
  /href="__Y2E_LINK_1__"/.test(x) && /cross-section link/.test(x));
check('link token records the absolute target',
  out.links.length === 1
  && out.links[0].url === 'https://jigsaw.yuzu.com/books/chapter9.xhtml#sec2',
  JSON.stringify(out.links));

check('MathJax SVG used', /<svg/.test(x));
check('glyph defs inlined', /MJX-GLYPH-A/.test(x) && /<defs/.test(x));
check('hasSvg reported', out.hasSvg === true);
check('display math wrapped', /y2e-math-block/.test(x));
check('standalone MathML kept + namespaced',
  /<math[^>]*xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML"/.test(x));
check('hasMathML reported', out.hasMathML === true);

check('empty elements pruned', !/<p\/>|<p><\/p>|<div\/>|<div><\/div>/.test(x));

// The whole point: the result must be parseable as XML.
const parsed = new window.DOMParser().parseFromString(
  `<?xml version="1.0" encoding="UTF-8"?>
   <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>${x}</body></html>`,
  'application/xml',
);
const perr = parsed.querySelector('parsererror');
check('output is well-formed XML', !perr, perr && perr.textContent.slice(0, 200));


// --- document-swap wait ----------------------------------------------------
// The driver used to sleep a fixed interval after navigating and hope the
// frame had swapped. If it ran short, the section extracted the PREVIOUS
// document's content. The extractor now waits for the document it was told
// to expect.
function freshExtractor() {
  const d = new JSDOM(HTML, { url: 'https://jigsaw.yuzu.com/books/x/chapter1.xhtml' });
  Object.defineProperty(d.window.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; }, configurable: true,
  });
  return loadInjected(EXTRACT_JS, 'yuzuExtractSection', {
    window: d.window, document: d.window.document, Node: d.window.Node,
    NodeFilter: d.window.NodeFilter, XMLSerializer: d.window.XMLSerializer,
    Event: d.window.Event, Object, Math, Date, Promise, setTimeout, console,
    Array, String, Map, Set, JSON, RegExp, Error, TypeError, URL,
  });
}
const BASE_OPTS = { settleMs: 40, maxSettleMs: 600, scrollStepMs: 1, imageTimeoutMs: 60 };

// Compare against a run with no expectPath, so scroll and settle costs cancel
// out and only the swap wait is measured.
const tNone = Date.now();
await freshExtractor().call({ ...BASE_OPTS });
const noExpect = Date.now() - tNone;

const tMatch = Date.now();
const matched = await freshExtractor().call({
  ...BASE_OPTS, expectPath: '/EPUB/content/chapter1.xhtml', swapTimeoutMs: 5000,
});
const withExpect = Date.now() - tMatch;

check('a matching document does not burn the swap timeout',
  !matched.skip && (withExpect - noExpect) < 500,
  `no-expect ${noExpect}ms vs expect ${withExpect}ms (swap budget was 5000ms)`);

// A document that never arrives must give up, not hang forever.
const tGone = Date.now();
const wrong = await freshExtractor().call({
  ...BASE_OPTS, expectPath: '/EPUB/content/never-loads.xhtml', swapTimeoutMs: 700,
});
const goneMs = Date.now() - tGone;
check('a document that never arrives times out rather than hanging',
  !!wrong && goneMs < 5000, `${goneMs}ms`);

// --- the scroll sweep must be monotonic ------------------------------------
// Reported from a real run: the page "jumps up and down several times now
// instead of just scrolling once to the bottom". That was a two-pass verify
// loop where each pass restored the starting scroll position, so pass two
// swept from the top again. One sweep that extends as content grows reaches
// exactly the same content without the thrash.
{
  const tall = new JSDOM(HTML, { url: 'https://jigsaw.yuzu.com/books/x/chapter1.xhtml' });
  const w = tall.window;
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; }, configurable: true,
  });

  const scroller = w.document.documentElement;
  const positions = [];
  let top = 0;
  let contentHeight = 5000;
  Object.defineProperty(scroller, 'scrollTop', {
    get() { return top; },
    set(v) { top = v; positions.push(v); },
    configurable: true,
  });
  Object.defineProperty(scroller, 'scrollHeight', {
    // Grows once the sweep is underway, the way lazily rendered content does.
    get() { if (top > 2000) contentHeight = 8000; return contentHeight; },
    configurable: true,
  });
  Object.defineProperty(scroller, 'scrollWidth', { get() { return 1000; }, configurable: true });
  Object.defineProperty(w, 'innerHeight', { get() { return 800; }, configurable: true });
  Object.defineProperty(w, 'innerWidth', { get() { return 1000; }, configurable: true });

  const ex = loadInjected(EXTRACT_JS, 'yuzuExtractSection', {
    window: w, document: w.document, Node: w.Node, NodeFilter: w.NodeFilter,
    XMLSerializer: w.XMLSerializer, Event: w.Event,
    Object, Math, Date, Promise, setTimeout, console,
    Array, String, Map, Set, JSON, RegExp, Error, TypeError, URL,
  });
  await ex.call({ settleMs: 40, maxSettleMs: 600, scrollStepMs: 1, imageTimeoutMs: 60 });

  // Everything except the final restore must be non-decreasing.
  const sweep = positions.slice(0, -1);
  let descents = 0;
  for (let i = 1; i < sweep.length; i++) if (sweep[i] < sweep[i - 1]) descents++;

  check('the scroll sweep never goes backwards', descents === 0,
    `${descents} descent(s) in ${sweep.length} moves`);
  check('the sweep starts once, not once per pass',
    sweep.filter((v) => v === 0).length === 1,
    `returned to 0 ${sweep.filter((v) => v === 0).length} times`);
  check('the sweep follows content that grew mid-scroll',
    Math.max(...sweep) >= 7000, `reached ${Math.max(...sweep)} of 8000`);
  check('scroll position is restored at the end',
    positions[positions.length - 1] === 0, `left at ${positions[positions.length - 1]}`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n--- serialized output ---\n' + x.slice(0, 3000)); }
process.exit(fail ? 1 : 0);
