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

Expect **10 to 25 minutes** for a full textbook. The slow part is waiting for
each section to render, which is unavoidable in this design (see below).

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
background.js       driver: reads the TOC, navigates section by section,
  │                 holds extracted XHTML (text only)
  ├── injected/toc.js       runs in the top reader frame
  │                         reads the TOC tree, drives navigation
  ├── injected/extract.js   runs in every frame, best-scoring result wins
  │                         autoscrolls to force lazy render, cleans,
  │                         serialises to XHTML
  │
offscreen.js        fetches image bytes, assembles the zip, starts the
                    download. Exists because MV3 service workers have no
                    URL.createObjectURL and cannot hand a Blob to
                    chrome.downloads.
  └── lib/zip.js      minimal ZIP writer (CompressionStream + CRC32)
      lib/epub.js     EPUB 3 package: OPF, nested nav.xhtml, NCX, page-list
      lib/stylesheet.js  the reading stylesheet baked into every book
```

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

- **Cross-section links are unwrapped.** A link from Chapter 3 into Chapter 9
  becomes plain text. Yuzu's internal spine filenames do not map onto our
  section files. Links inside a single section still work.
- **Page-list granularity depends on the book.** Where the source EPUB carries
  page-break markers, "go to page" matches the print edition exactly. Where it
  does not, there is one entry per section.
- **One section per TOC entry.** A book whose TOC omits content will omit it
  here too.
- **Not run through epubcheck.** `test/validate_epub.py` checks OCF layout, XML
  well-formedness, manifest/spine/nav agreement and dangling references, which
  covers the realistic failure modes, but it is not a substitute.

## Development

```bash
node --check extension/background.js     # no build step; plain JS throughout
node test/build-fixture.mjs              # synthetic EPUB from the real lib code
python3 test/validate_epub.py test/fixture.epub
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
