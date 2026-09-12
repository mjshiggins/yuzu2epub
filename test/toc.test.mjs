/**
 * Guards that TOC reading never clicks anything outside the TOC list.
 *
 * A previous version queried the whole document for collapsed expanders and
 * clicked all of them, which also reaches the reader's header menus. A run
 * ended on an SSO logout page. This fixture puts an account menu with a sign
 * out item next to the TOC and asserts nothing in the header is ever touched.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const src = fs.readFileSync(
  path.resolve(import.meta.dirname, '..', 'extension', 'injected', 'toc.js'), 'utf8');

const HTML = `<!doctype html><html lang="en"><head><title>Yuzu: Fixture Book</title></head>
<body>
  <!-- reader header: must never be clicked -->
  <header>
    <ul>
      <li><button id="danger-account" aria-expanded="false" aria-label="More Options">Account</button>
        <ul id="account-menu" hidden><li><button id="danger-signout">Sign out</button></li></ul>
      </li>
      <li><button id="danger-prefs" aria-expanded="false" aria-label="Reader Preferences">Prefs</button></li>
    </ul>
  </header>

  <div id="toc-panel">
    <button data-interaction-id="toc_expand_all" type="button">Expand all</button>
    <ul id="toc">
      <li><div><div><button aria-current="true" data-uuid="tocIndex0" aria-label="Go to Cover, page i"><span>Cover</span></button></div></div></li>
      <li><div><div><button aria-current="false" data-uuid="tocIndex1" aria-label="Go to Preface, page vii"><span>Preface</span></button></div></div></li>
      <li>
        <div><div><button aria-current="false" data-uuid="tocIndex2" aria-label="Go to Part I The Contexts, page 1"><span>Part I</span></button></div></div>
        <button id="part1-toggle" aria-expanded="false" data-interaction-id="toc_expand">toggle</button>
        <ul id="part1-kids" hidden></ul>
      </li>
    </ul>
  </div>
</body></html>`;

const dom = new JSDOM(HTML, { url: 'https://reader.yuzu.com/reader/books/9780000000000/epubcfi/x' });
const { window } = dom;
const doc = window.document;

const clicked = [];
for (const id of ['danger-account', 'danger-signout', 'danger-prefs']) {
  doc.getElementById(id).addEventListener('click', () => clicked.push(id));
}

// Expanding Part I reveals its chapters, as the real reader does.
doc.getElementById('part1-toggle').addEventListener('click', function () {
  this.setAttribute('aria-expanded', 'true');
  const kids = doc.getElementById('part1-kids');
  kids.hidden = false;
  kids.innerHTML = `
    <li><div><div><button aria-current="false" data-uuid="tocIndex3" aria-label="Go to 1 First Chapter, page 3"><span>1 First</span></button></div></div></li>
    <li><div><div><button aria-current="false" data-uuid="tocIndex4" aria-label="Go to 2 Second Chapter, page 39"><span>2 Second</span></button></div></div></li>`;
});
// Expand-all is a no-op here, so the per-node pass has real work to do.
doc.querySelector('[data-interaction-id="toc_expand_all"]').addEventListener('click', () => {});

const ctx = {
  window, document: doc, location: window.location,
  Object, Math, Date, Promise, setTimeout, console, Array, String, Map, Set, JSON, RegExp, Error,
};
vm.createContext(ctx);
vm.runInContext(src, ctx, { filename: 'toc.js' });
const toc = await vm.runInContext('yuzuReadToc()', ctx);

let fail = 0;
const check = (n, c, d) => {
  console.log(`  ${c ? 'ok   ' : 'FAIL '} ${n}${c ? '' : '  <- ' + d}`);
  if (!c) fail++;
};

console.log('=== toc.js ===');
if (toc.error) { console.log('  ERROR:', toc.error); process.exit(1); }

check('no header control was clicked', clicked.length === 0, `clicked: ${clicked.join(', ')}`);
check('sign out was never clicked', !clicked.includes('danger-signout'));
check('collapsed Part inside the TOC was expanded',
  doc.getElementById('part1-toggle').getAttribute('aria-expanded') === 'true');
check('all 5 entries found after expansion', toc.entries.length === 5, `got ${toc.entries.length}`);
check('title parsed from document.title', toc.title === 'Fixture Book', toc.title);
check('isbn parsed from url', toc.isbn === '9780000000000', toc.isbn);
check('page numbers parsed', toc.entries.map((e) => e.page).join(',') === 'i,vii,1,3,39',
  toc.entries.map((e) => e.page).join(','));
check('titles stripped of the "Go to" prefix and page suffix',
  toc.entries[2].title === 'Part I The Contexts', toc.entries[2].title);
check('front matter and Parts at depth 0',
  [0, 1, 2].every((i) => toc.entries[i].depth === 0),
  toc.entries.map((e) => e.depth).join(','));
check('chapters nested at depth 1',
  toc.entries[3].depth === 1 && toc.entries[4].depth === 1,
  toc.entries.map((e) => e.depth).join(','));
check('Part flagged as a parent', toc.entries[2].isPart === true);

// Navigation must refuse to click once the reader has left the book.
const gone = new JSDOM('<!doctype html><html><body><p>Whitelabel Error Page</p></body></html>',
  { url: 'https://sso.bncollege.com/bes-idp/logout?pub=x' });
const ctx2 = {
  window: gone.window, document: gone.window.document, location: gone.window.location,
  Object, Math, Date, Promise, setTimeout, console, Array, String, Map, Set, JSON, RegExp, Error,
};
vm.createContext(ctx2);
vm.runInContext(src, ctx2, { filename: 'toc.js' });
const navGone = await vm.runInContext('yuzuGotoSection("tocIndex3")', ctx2);
check('navigation refuses on a non-reader page', !!navGone.error, JSON.stringify(navGone));

console.log(fail ? `\n  ${fail} failed` : '\n  all toc checks passed');
process.exit(fail ? 1 : 0);
