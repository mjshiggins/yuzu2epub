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
import { loadInjected } from './inject.mjs';

const TOC_JS = path.resolve(import.meta.dirname, '..', 'extension', 'injected', 'toc.js');

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

// Injected exactly as chrome.scripting delivers it: this function's source
// alone, with nothing else from the file in scope.
const readToc = loadInjected(TOC_JS, 'yuzuReadToc', {
  window, document: doc, location: window.location,
  Object, Math, Date, Promise, setTimeout, console, Array, String, Map, Set, JSON, RegExp, Error,
});
const toc = await readToc.call();

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
const gotoGone = loadInjected(TOC_JS, 'yuzuGotoSection', {
  window: gone.window, document: gone.window.document, location: gone.window.location,
  Object, Math, Date, Promise, setTimeout, console, Array, String, Map, Set, JSON, RegExp, Error,
});
const navGone = await gotoGone.call({ uuid: 'tocIndex3', label: 'Go to 1 First Chapter, page 3', title: '1 First Chapter' }, 5);
check('navigation refuses on a non-reader page', !!navGone.error, JSON.stringify(navGone));


// ---------------------------------------------------------------------------
// Recovery: the TOC collapsed back to its top-level rows mid-run.
//
// This is the failure that cost a real run. The reader remounted the panel to
// its collapsed state (12 rows out of 741), the driver kept looking up the
// positional data-uuid it had captured hours earlier, found nothing, and raced
// through every remaining section reporting "not found".
// ---------------------------------------------------------------------------
function collapsedDom() {
  const dom = new JSDOM(`<!doctype html><html><head><title>Yuzu: Book</title></head><body>
    <div id="toc-panel">
      <button data-interaction-id="toc_expand_all" type="button">Expand all</button>
      <ul id="toc">
        <li><div><button data-uuid="tocIndex0" aria-current="false" aria-label="Go to Cover, page i"><span>Cover</span></button></div></li>
        <li>
          <div><button data-uuid="tocIndex1" aria-current="false" aria-label="Go to Part I, page 1"><span>Part I</span></button></div>
          <button id="toggle" aria-expanded="false" data-interaction-id="toc_expand">t</button>
          <ul id="kids" hidden></ul>
        </li>
      </ul>
    </div>
  </body></html>`, { url: 'https://reader.yuzu.com/reader/books/9780000000000/epubcfi/x' });
  const d = dom.window.document;
  const clicked = [];
  // Expanding reveals the two chapters, exactly as the real reader does.
  const reveal = () => {
    d.getElementById('toggle').setAttribute('aria-expanded', 'true');
    const kids = d.getElementById('kids');
    kids.hidden = false;
    kids.innerHTML = `
      <li><div><button data-uuid="tocIndex2" aria-current="false" aria-label="Go to 1 First Chapter, page 3"><span>1</span></button></div></li>
      <li><div><button data-uuid="tocIndex3" aria-current="false" aria-label="Go to 2 Second Chapter, page 39"><span>2</span></button></div></li>`;
    for (const b of kids.querySelectorAll('button')) {
      b.addEventListener('click', function () {
        clicked.push(this.getAttribute('aria-label'));
        this.setAttribute('aria-current', 'true');
      });
    }
  };
  d.getElementById('toggle').addEventListener('click', reveal);
  d.querySelector('[data-interaction-id="toc_expand_all"]').addEventListener('click', reveal);
  return { dom, d, clicked };
}

function gotoIn(d, win) {
  return loadInjected(TOC_JS, 'yuzuGotoSection', {
    window: win, document: d, location: win.location,
    Object, Math, Date, Promise, setTimeout, console, Array, String, Map, Set, JSON, RegExp, Error,
  });
}

{
  const { dom, d, clicked } = collapsedDom();
  const goto = gotoIn(d, dom.window);
  const res = await goto.call(
    { uuid: 'tocIndex3', label: 'Go to 2 Second Chapter, page 39', title: '2 Second Chapter' },
    4,
  );
  check('recovers from a collapsed TOC', res.ok === true, JSON.stringify(res));
  check('reports that it had to recover', res.recovered === true, JSON.stringify(res));
  check('clicked the right entry after re-expanding',
    clicked.length === 1 && clicked[0] === 'Go to 2 Second Chapter, page 39',
    JSON.stringify(clicked));
}

{
  // A stale positional uuid must never win over the label. Here tocIndex3 is
  // present but is a different row than the one captured.
  const { dom, d, clicked } = collapsedDom();
  d.getElementById('toggle').click();
  await new Promise((r) => setTimeout(r, 10));
  d.querySelector('button[data-uuid="tocIndex3"]').setAttribute('aria-label', 'Go to Something Else, page 99');
  const goto = gotoIn(d, dom.window);
  const res = await goto.call(
    { uuid: 'tocIndex3', label: 'Go to 1 First Chapter, page 3', title: '1 First Chapter' },
    4,
  );
  check('label beats a stale positional uuid',
    clicked.length === 1 && clicked[0] === 'Go to 1 First Chapter, page 3',
    `clicked ${JSON.stringify(clicked)} / ${JSON.stringify(res)}`);
}

{
  // Genuinely absent entry: report it, do not click something at random.
  const { dom, d, clicked } = collapsedDom();
  const goto = gotoIn(d, dom.window);
  const res = await goto.call(
    { uuid: 'tocIndex9', label: 'Go to Missing Chapter, page 999', title: 'Missing Chapter' },
    4,
  );
  check('missing entry reports an error', !!res.error, JSON.stringify(res));
  check('missing entry clicks nothing', clicked.length === 0, JSON.stringify(clicked));
  check('error names what was rendered', /rows rendered/.test(res.error || ''), res.error);
}

console.log(fail ? `\n  ${fail} failed` : '\n  all toc checks passed');
process.exit(fail ? 1 : 0);
