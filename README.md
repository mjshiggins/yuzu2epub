# yuzu2epub

A Chrome extension that turns a Yuzu textbook **you have purchased** into a
single, Kindle-ready EPUB: one file, cover art, images, and a nested Part and
Chapter table of contents you can actually navigate.

It replaces the current workflow of extracting one chapter at a time and ending
up with a pile of loose HTML files.

## What it does

Press one button. The extension:

1. Reads the book's table of contents, expanding every Part.
2. Walks each section in order, letting the reader render it in your own
   logged-in session, then extracts the rendered content.
3. Collects and deduplicates every image in the book.
4. Fetches the cover art.
5. Assembles an EPUB 3 package with a nested navigation tree, an NCX fallback
   for older readers and KDP, and a page-list mapped to the printed edition's
   page numbers.

Runtime depends entirely on how the publisher split the book, and the spread is
large. One textbook tested here has 43 sections across two levels and takes
minutes. Another has **741 sections across four levels** and takes well over an
hour. The popup shows an estimate based on the rate actually observed, and
progress is checkpointed continuously so a long run can be stopped and resumed.

The slow part is waiting for each section to render, which is unavoidable in
this design (see below).

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. Open a book at `reader.yuzu.com`, click the extension, press **Build EPUB**

Leave the tab open and on the book while it runs. You can use other tabs.

## How it works, and one thing it deliberately does not do

The extension reads what the Yuzu reader has **already rendered in your own
authenticated session**. It drives the reader's own table of contents, waits for
each section to paint, and reads the resulting DOM. That is the same access path
as reading the book by hand, just automated.

It does **not** call Yuzu's backend content API to pull raw book assets. That
would be far faster and it is where most tools of this kind go. It is also the
point where a personal format-shifting tool turns into a general-purpose
downloader that works just as well against an account that never bought
anything. The slower path is the one that stays honestly scoped to a book you
own, so that is the path this takes.

Use this on books you have paid for, for your own reading. Do not redistribute
what comes out of it.

### Architecture

```
popup.js            thin view; the job survives the popup being closed
  │
background.js       service worker. Drives the reader, then assembles.
  │                 Has fetch, CompressionStream and all chrome.* APIs.
  ├── injected/toc.js          runs in the top reader frame
  │                            reads the TOC tree, drives navigation
  ├── injected/extract.js      runs in every frame, best-scoring result wins
  │                            autoscrolls to force lazy render, cleans,
  │                            serialises to XHTML
  ├── injected/fetch-image.js  same-origin image fetch, used as a fallback
  │
  ├── lib/assemble.js   fetches images, rewrites tokens, builds the EPUB
  ├── lib/zip.js        minimal ZIP writer (CompressionStream + CRC32)
  ├── lib/epub.js       EPUB 3 package: OPF, nested nav.xhtml, NCX, page-list
  └── lib/stylesheet.js the reading stylesheet baked into every book

offscreen.js        mints a blob: URL. That is the whole job.
```

### Which APIs each context actually has

This tripped the project up once and is worth stating plainly.

| Context | Has | Does not have |
| --- | --- | --- |
| Service worker | `fetch`, `CompressionStream`, `caches`, all declared `chrome.*` | any DOM: no `URL.createObjectURL`, `FileReader`, `DOMParser`, `XMLSerializer` |
| Offscreen document | full DOM, `caches`, **`chrome.runtime` only** | `chrome.storage`, `chrome.downloads`, every other `chrome.*` |
| Injected scripts | the page's DOM | `chrome.*` entirely |

So the finished EPUB is built in the service worker, handed to the offscreen
document **through the Cache API** (extension messaging is JSON-only and cannot
carry binary), turned into a blob URL there, and downloaded by the service
worker. `test/context-apis.test.mjs` enforces all of this statically.

### Two tables of contents

There are two, and both have to be right.

The **generated navigation** is `nav.xhtml` plus a `toc.ncx` fallback, carrying
the Part and Chapter hierarchy. `nav.xhtml` is in the spine, not just the
manifest: EPUB 3 allows a nav document outside the reading order, but Kindle's
"Go to -> Table of Contents" is unreliable when the TOC is not a real page. The
deprecated EPUB 2 `<guide>` is emitted alongside `landmarks`, because Kindle's
older ingestion path and KDP still read it.

The **book's own printed Contents page** is extracted like any other section,
and its chapter links have to be made live. During extraction an in-book link
is replaced with a token recording its absolute target, because the section it
points at may not have been extracted yet. Once every section has a filename,
the assembler matches those targets against the document each section came from
and rewrites them, fragments included. Without this the Contents page of a
709 page textbook is a dead list of chapter names.

Two things that cost real content before they were caught: `<nav>` was being
stripped as reader chrome, which deletes the printed Contents page outright,
and `<header>` was being dropped wholesale, which takes chapter titles with it.
Neither is treated as chrome any more. Reader chrome is now identified by
explicit ARIA roles and class hints only.

### Safety rule: never click outside the TOC

Section navigation works by clicking the reader's own controls, so the blast
radius of a bad selector is whatever else is on the page. An early version
queried the whole document for collapsed expanders and clicked every one,
which also hit the account and options menus in the header; a run ended on an
SSO logout page. Every interactive query is now scoped to the table of
contents list, and `test/toc.test.mjs` puts an account menu with a sign out
item beside the TOC and asserts nothing in the header is ever touched.

### Resilience

Extraction is the expensive half, roughly 20 minutes, and several things can
interrupt it: an assembly error, a closed tab, or a Yuzu session timing out and
bouncing the reader to an SSO logout page.

Sections are therefore checkpointed to `chrome.storage.local` every few
sections and again before assembly. The driver also checks before each section
that the tab is still on a book, and stops with a specific message rather than
clicking blind through an error page for the rest of the run.

Nothing is lost either way. The popup offers **Resume** to carry on from the
section that failed, or **Finish EPUB** when extraction had completed and only
assembly failed, alongside **Discard and re-extract**. After a sign-out, log
back in, reopen the book, and press Resume.

### Selector policy

Yuzu's CSS class names are styled-components hashes (`sc-eJwWfJ kDKZLz`) that
change on every deploy. **Nothing in this codebase may key off a class name.**
The reader is addressed only through semantic, stable hooks:

| Hook | Used for |
| --- | --- |
| `button[data-uuid^="tocIndex"]` | every TOC entry, in reading order |
| `[data-interaction-id="toc_expand_all"]` | expanding all Parts |
| `aria-current="true"` | confirming navigation landed |
| `aria-label="Go to <title>, page <n>"` | section title and printed page |
| ancestor `<ul>` count | Part vs Chapter nesting depth |

If a future Yuzu release breaks extraction, start here.

### Kindle formatting

The publisher's stylesheet is discarded. It is built for a paginated web viewer,
carries fixed pixel widths and absolute positioning, and renders badly on e-ink.
`lib/stylesheet.js` replaces it with a reading stylesheet that turns hyphenation
off (Kindle's hyphenator mangles technical vocabulary), keeps tables and figures
from splitting across pages, and uses no colour.

Math is preserved as MathJax's rendered SVG where available, with the glyph
definitions inlined per equation. MathJax keeps its glyph paths in one
document-wide cache and references them with `<use>`; lifting an equation out
without resolving those references yields a blank box. Where SVG is unavailable
the assistive MathML is used instead.

## Known limits

- **Cross-section links that point outside the TOC become plain text.** Links
  are matched against the document each section was extracted from, so anything
  the TOC did not cover has no section to point at. Matched links, which is the
  overwhelming majority, work normally.
- **Page-list granularity depends on the book.** Where the source EPUB carries
  page-break markers, "go to page" matches the print edition exactly. Where it
  does not, there is one entry per section.
- **One section per TOC entry.** A book whose TOC omits content will omit it
  here too. Entries that share a source document are extracted once.
- **Cover art is fetched by the service worker** using its `covers.vitalsource.com`
  host permission. That path could not be exercised outside the extension, so
  it is the least verified part of the pipeline. A failure is non-fatal: the
  book is built without a cover and the popup says so.
- **`toc.path` comes from the reader's React internals**, which is inherently
  fragile. It is only used to verify the driver landed on the document it asked
  for, and everything degrades quietly if React's shape changes.
- **Not run through epubcheck.** `test/validate_epub.py` checks OCF layout, XML
  well-formedness, manifest/spine/nav agreement and dangling references, which
  covers the realistic failure modes, but it is not a substitute.
- **Images that cannot be fetched degrade to a visible marker** rather than
  breaking the build. The popup lists each one.

## Development

```bash
npm install        # jsdom, for the tests only. The extension has no dependencies.
npm run check      # syntax check every source file
npm test           # extractor, pipeline, context-API guard, EPUB validation
```

`test/validate_epub.py` works on any EPUB, including real output:

```bash
python3 test/validate_epub.py ~/Downloads/your-book.epub
```

## Credits

Built on two open-source projects. Full license texts are in [NOTICE](NOTICE).

- **[yuzu-textbook-extractor](https://github.com/dipeshio/yuzu-textbook-extractor)**
  (ISC) — the frame-piercing strategy, Yuzu reader selectors, lazy-render
  autoscroll and MathML handling in `injected/extract.js` derive from its
  `injected.js`. Note that its `popup.js` and `background.js` ship obfuscated,
  so the orchestration layer here is new.
- **[md2kindle](https://github.com/ARahim3/md2kindle)** (MIT) — `lib/epub.js`
  derives from its `epub.ts`, extended here with nested navigation, a page-list
  and Yuzu metadata.
