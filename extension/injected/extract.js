/**
 * extract.js - injected into every frame of the reader tab.
 *
 * Frame-piercing strategy, Yuzu UI selectors and the lazy-render autoscroll are
 * derived from dipeshio/yuzu-textbook-extractor (ISC). See ../../NOTICE.
 *
 * The function runs in each frame; frames with no book content return a low
 * score and the service worker keeps the best-scoring result.
 *
 * Self-contained by necessity: chrome.scripting serialises the source.
 */

async function yuzuExtractSection(opts) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const O = Object.assign(
    { settleMs: 400, maxSettleMs: 25000, scrollStepMs: 90, imageTimeoutMs: 12000,
      expectPath: '', swapTimeoutMs: 15000 },
    opts || {},
  );

  // ── locate the document holding book content ──────────────────────────
  function candidateDocs() {
    const docs = [document];
    // mosaic-book exposes the content iframe through a shadow root.
    try {
      const mb = document.querySelector('mosaic-book');
      if (mb && mb.shadowRoot) {
        const f = mb.shadowRoot.querySelector('iframe.favre') || mb.shadowRoot.querySelector('iframe');
        if (f) {
          const d = f.contentDocument || (f.contentWindow && f.contentWindow.document);
          if (d) docs.push(d);
        }
      }
    } catch (_) {}
    try {
      for (const f of document.querySelectorAll('iframe')) {
        try {
          const d = f.contentDocument || (f.contentWindow && f.contentWindow.document);
          if (d && d.body) docs.push(d);
        } catch (_) {}
      }
    } catch (_) {}
    return docs;
  }

  function scoreDoc(d) {
    if (!d || !d.body) return 0;
    // Prefer documents that look like book content rather than reader chrome.
    const txt = (d.body.innerText || '').trim().length;
    const structural = d.querySelectorAll('p, section, figure, table, h1, h2').length;
    const imgs = d.querySelectorAll('img').length;
    const isReaderShell = d.querySelector('[data-uuid^="tocIndex"]') ? 1 : 0;
    // Images count heavily: a cover or plate page is almost all image and
    // almost no text, and must not be mistaken for an empty frame.
    return isReaderShell ? 0 : txt + structural * 40 + imgs * 80;
  }

  const baseName = (u) => {
    try {
      return String(u).split('?')[0].split('#')[0].split('/').pop();
    } catch (_) {
      return '';
    }
  };

  function pickDoc() {
    let picked = null;
    let top = 0;
    for (const d of candidateDocs()) {
      const sc = scoreDoc(d);
      if (sc > top) {
        top = sc;
        picked = d;
      }
    }
    return { doc: picked, score: top };
  }

  let { doc, score: best } = pickDoc();

  // The driver tells us which document this section should be. Poll until the
  // frame actually shows it rather than waiting a fixed interval and hoping.
  if (O.expectPath) {
    const want = baseName(O.expectPath);
    const deadline = Date.now() + O.swapTimeoutMs;
    while (Date.now() < deadline) {
      if (doc && baseName(doc.baseURI) === want) break;
      await sleep(150);
      const next = pickDoc();
      doc = next.doc;
      best = next.score;
    }
  }
  // Deliberately low. The reader shell already scores zero, so the only thing
  // this threshold has to reject is a genuinely blank frame. Front matter such
  // as a cover or a half-title legitimately carries very little.
  if (!doc || best < 50) {
    return { score: best || 0, skip: true };
  }

  // ── force lazily rendered content to materialise ──────────────────────
  // MathJax and the image loader both hang off IntersectionObserver, so
  // nothing below the fold exists until it has been scrolled past.
  /**
   * Is there anything that only materialises once scrolled into view?
   *
   * Skipping the scroll is a large speed win on a book split into hundreds of
   * small files, but guessing wrong drops content silently, which is worse
   * than being slow. So this errs heavily toward scrolling: it scrolls unless
   * it can see positive evidence that the whole document is already present
   * and fully loaded.
   */
  function needsScroll(d) {
    const win = d.defaultView || window;
    const probe = d.scrollingElement || d.documentElement || d.body;
    if (!probe) return true;

    const viewportH = win.innerHeight || 800;
    const viewportW = win.innerWidth || 1000;

    // Content below the fold.
    if (probe.scrollHeight > viewportH * 1.15) return true;
    // Content beside the fold. A paginated or column layout keeps scrollHeight
    // at viewport size while content extends sideways, which a height-only
    // check would miss.
    if (probe.scrollWidth > viewportW * 1.15) return true;

    // Anything that materialises on intersection.
    if (d.querySelector('mjx-container, math')) return true;
    if (d.querySelector('img[data-src], img[data-lazy], img[loading="lazy"], [data-lazy-src]')) return true;
    // An image with no src at all is waiting for something to set one.
    for (const img of d.querySelectorAll('img')) {
      if (!img.getAttribute('src')) return true;
    }
    // Deliberately NOT checking img.complete or naturalWidth here. A broken or
    // still-loading image is not evidence that scrolling would help, and
    // treating it as such made the scroll run on essentially every section.
    // waitForImages already handles waiting for loads.
    return false;
  }

  /**
   * One downward sweep, never a restart.
   *
   * Lazily rendered content appears as it intersects the viewport, and it can
   * make the document taller while the sweep is running. The loop re-reads the
   * height every step, so growth simply extends the same sweep. An earlier
   * version ran the whole thing twice and restored the scroll position between
   * passes, which visibly bounced the page up and down and doubled the cost
   * for no extra coverage.
   */
  async function autoScroll(d) {
    const win = d.defaultView || window;
    const scroller = d.scrollingElement || d.documentElement || d.body;
    if (!scroller) return;

    const startedAt = scroller.scrollTop;
    const viewport = win.innerHeight || 800;
    const step = Math.max(200, Math.floor(viewport * 0.9));
    const height = () => Math.max(scroller.scrollHeight, d.body ? d.body.scrollHeight : 0);

    let pos = 0;
    let guard = 0;
    while (guard++ < 600) {
      scroller.scrollTop = pos;
      try {
        win.dispatchEvent(new Event('scroll'));
      } catch (_) {}
      await sleep(O.scrollStepMs);
      // Re-read each step: if lazy content extended the document, keep going
      // rather than starting over.
      if (pos >= height() - viewport) break;
      pos += step;
    }

    // Settle at the bottom so anything triggered near the end can finish.
    scroller.scrollTop = height();
    await sleep(200);
    // Restore once, at the very end, so the reader's own position is not left
    // somewhere unexpected.
    scroller.scrollTop = startedAt;
  }

  async function waitUntilStable(d) {
    let last = -1;
    let stableSince = 0;
    const start = Date.now();
    while (Date.now() - start < O.maxSettleMs) {
      const size = d.body.innerHTML.length;
      if (size === last && size > 0) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= O.settleMs) return true;
      } else {
        stableSince = 0;
        last = size;
      }
      await sleep(200);
    }
    return false;
  }

  async function waitForImages(d) {
    const start = Date.now();
    while (Date.now() - start < O.imageTimeoutMs) {
      const imgs = Array.from(d.querySelectorAll('img'));
      if (!imgs.length) return;
      const pending = imgs.filter((i) => !i.complete && i.getAttribute('src'));
      if (!pending.length) return;
      await sleep(300);
    }
  }

  await waitUntilStable(doc);

  // A single sweep. It extends itself as lazy content appears, so there is
  // nothing a second pass would reach that the first did not.
  if (needsScroll(doc)) {
    await autoScroll(doc);
    await waitUntilStable(doc);
  }
  await waitForImages(doc);

  // ── MathJax SVG glyph resolution ──────────────────────────────────────
  // MathJax 3's SVG output references glyph paths in one document-wide
  // <defs> cache via <use xlink:href="#MJX-...">. Lifting an equation out of
  // the page without inlining those paths yields a blank box, so resolve
  // every reference into a local <defs>.
  function materialiseMathSvg(svg, d) {
    const clone = svg.cloneNode(true);
    const needed = new Map();
    const uses = clone.querySelectorAll('use');
    for (const u of uses) {
      const href =
        u.getAttribute('xlink:href') || u.getAttribute('href') || '';
      if (!href.startsWith('#')) continue;
      const id = href.slice(1);
      if (needed.has(id)) continue;
      const src = d.getElementById(id) || svg.ownerDocument.getElementById(id);
      if (src) needed.set(id, src.cloneNode(true));
    }
    if (needed.size) {
      const defs = d.createElementNS('http://www.w3.org/2000/svg', 'defs');
      for (const node of needed.values()) defs.appendChild(node);
      clone.insertBefore(defs, clone.firstChild);
    }
    // Declare xlink through a real namespace declaration so the serializer
    // reuses one prefix instead of minting ns1, ns2, ns3... per <use>.
    // xmlns itself is already carried by the element's namespaceURI; setting
    // it by hand produces a duplicate attribute and invalid XML.
    try {
      clone.setAttributeNS(
        'http://www.w3.org/2000/xmlns/', 'xmlns:xlink', 'http://www.w3.org/1999/xlink');
    } catch (_) {}
    return clone;
  }

  // ── clean ─────────────────────────────────────────────────────────────
  const DROP = new Set([
    'SCRIPT', 'STYLE', 'LINK', 'META', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED',
    'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'LABEL', 'CANVAS',
    'VIDEO', 'AUDIO', 'NOSCRIPT', 'TEMPLATE', 'DIALOG',
  ]);

  const KEEP_TAGS = new Set([
    'P', 'DIV', 'SPAN', 'SECTION', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'UL', 'OL', 'LI', 'DL', 'DT', 'DD',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION', 'COLGROUP', 'COL',
    'FIGURE', 'FIGCAPTION', 'IMG', 'A', 'BR', 'HR',
    'EM', 'STRONG', 'I', 'B', 'U', 'S', 'SUP', 'SUB', 'SMALL', 'CITE', 'Q',
    'PRE', 'CODE', 'KBD', 'SAMP', 'VAR', 'ABBR', 'TIME', 'MARK', 'ADDRESS',
    'ABBR', 'BDI', 'BDO', 'WBR', 'RUBY', 'RT', 'RP',
  ]);

  const KEEP_ATTRS = new Set(['href', 'src', 'alt', 'title', 'id', 'colspan', 'rowspan', 'dir', 'lang']);

  // Reader chrome only. Deliberately no bare 'nav', 'header' or 'footer':
  // those are ordinary book markup in a content document. Explicit ARIA roles
  // are kept because the reader sets them and publisher content rarely does.
  const UI_SELECTORS = [
    '[class*="toolbar"]', '[class*="Toolbar"]',
    '[class*="sidebar"]', '[class*="Sidebar"]',
    '[class*="toast"]', '[class*="Toast"]',
    '[class*="modal"]', '[class*="Modal"]',
    '[class*="overlay"]', '[class*="Overlay"]',
    '[class*="floating"]', '[class*="Floating"]',
    '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
    '[role="dialog"]', '[role="alertdialog"]', '[role="toolbar"]',
    'pwa-extension-ng-components', '.widget', '#staticloader', '#vstui__portal_root',
    '[data-testid*="toolbar"]', '[data-testid*="sidebar"]',
    '[class*="annotation"]', '[class*="highlight-"]',
    '[aria-hidden="true"][class*="mjx"]',
  ];

  const PRINT_WARNING = 'To print, please use the print page range feature within the application.';

  const images = [];
  const links = [];
  const pages = [];
  const seenImg = new Map();
  let hasMathML = false;
  let hasSvg = false;
  let droppedNodes = 0;

  const root = doc.body.cloneNode(true);

  // Reader chrome and annotation layers.
  for (const sel of UI_SELECTORS) {
    try {
      root.querySelectorAll(sel).forEach((el) => el.remove());
    } catch (_) {}
  }

  // Yuzu's "use the print page range feature" banner.
  try {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const kill = new Set();
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if ((n.nodeValue || '').includes(PRINT_WARNING)) {
        let el = n.parentElement;
        while (el && el !== root) {
          if ((el.textContent || '').includes(PRINT_WARNING)) kill.add(el);
          el = el.parentElement;
        }
      }
    }
    kill.forEach((el) => el.remove());
  } catch (_) {}

  // MathJax keeps every glyph path in one hidden <svg> cache. materialiseMathSvg
  // copies the ones each equation needs, so the cache itself is dead weight.
  root.querySelectorAll(
    'svg[id*="global-cache"], svg[id^="MJX-SVG"], mjx-assistive-mml',
  ).forEach((el) => el.remove());

  // Replace MathJax containers with portable math before the generic walk,
  // because mjx-* are unknown elements the walker would otherwise unwrap.
  root.querySelectorAll('mjx-container').forEach((c) => {
    const svg = c.querySelector('svg');
    const mml = c.querySelector('mjx-assistive-mml math, math');
    let replacement = null;
    if (svg) {
      try {
        replacement = materialiseMathSvg(svg, doc);
        hasSvg = true;
      } catch (_) {
        replacement = null;
      }
    }
    if (!replacement && mml) {
      replacement = mml.cloneNode(true);
      if (!replacement.namespaceURI) {
        replacement.setAttribute('xmlns', 'http://www.w3.org/1998/Math/MathML');
      }
      hasMathML = true;
    }
    if (!replacement) {
      replacement = doc.createElement('span');
      replacement.className = 'y2e-missing';
      replacement.textContent = (c.textContent || '').trim() || '[equation]';
    }
    const isBlock = (c.getAttribute('display') === 'true') || c.closest('mjx-block');
    if (isBlock) {
      const wrap = doc.createElement('div');
      wrap.className = 'y2e-math-block';
      wrap.appendChild(replacement);
      c.replaceWith(wrap);
    } else {
      c.replaceWith(replacement);
    }
  });

  // Standalone MathML not wrapped by MathJax.
  root.querySelectorAll('math').forEach((m) => {
    // Only declare the namespace when the element does not already carry one,
    // otherwise the serializer emits xmlns twice.
    if (!m.namespaceURI && !m.getAttribute('xmlns')) {
      m.setAttribute('xmlns', 'http://www.w3.org/1998/Math/MathML');
    }
    hasMathML = true;
  });

  // Printed page markers. Yuzu ships these in several shapes depending on the
  // publisher's source EPUB, so match generously and normalise to one form.
  function pageLabelOf(el) {
    const t = el.getAttribute('title') || el.getAttribute('aria-label') || el.getAttribute('data-page') || '';
    if (t.trim()) return t.trim();
    const id = el.getAttribute('id') || '';
    const m = id.match(/(?:page[-_]?)([ivxlcdm]+|\d+)/i);
    if (m) return m[1];
    const txt = (el.textContent || '').trim();
    return txt.length <= 8 ? txt : '';
  }

  const pageSel = [
    '[epub\\:type~="pagebreak"]', '[epubtype~="pagebreak"]',
    '[role="doc-pagebreak"]', '[data-page]',
    'a[id^="page"]', 'span[id^="page"]', 'a[id^="Page"]', 'span[id^="Page"]',
    '[class*="pagebreak"]', '[class*="pageBreak"]', '[class*="page-break"]',
  ].join(',');

  let pageN = 0;
  try {
    root.querySelectorAll(pageSel).forEach((el) => {
      const label = pageLabelOf(el);
      if (!label) return;
      const id = `y2e-page-${++pageN}`;
      const marker = doc.createElement('span');
      marker.className = 'y2e-pagebreak';
      marker.setAttribute('id', id);
      marker.setAttributeNS('http://www.idpf.org/2007/ops', 'epub:type', 'pagebreak');
      marker.setAttribute('title', label);
      marker.setAttribute('role', 'doc-pagebreak');
      el.replaceWith(marker);
      pages.push({ id, label });
    });
  } catch (_) {}

  // Generic walk: drop junk, unwrap unknown elements, scrub attributes.
  function walk(node) {
    const kids = Array.from(node.childNodes);
    for (const child of kids) {
      if (child.nodeType === Node.COMMENT_NODE) {
        child.remove();
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      const el = child;
      const ns = el.namespaceURI || '';
      // Foreign content keeps its structure (geometry attributes are load
      // bearing) but still loses publisher styling.
      if (ns.includes('MathML') || ns.includes('/svg')) {
        const scrubForeign = (n) => {
          if (n.nodeType === Node.ELEMENT_NODE) {
            n.removeAttribute('class');
            n.removeAttribute('style');
            for (const c of n.children) scrubForeign(c);
          }
        };
        scrubForeign(el);
        continue;
      }

      const tag = el.tagName.toUpperCase();

      if (DROP.has(tag)) {
        el.remove();
        droppedNodes++;
        continue;
      }

      if (!KEEP_TAGS.has(tag)) {
        // Unknown or custom element: keep its children, discard the wrapper.
        walk(el);
        const frag = doc.createDocumentFragment();
        while (el.firstChild) frag.appendChild(el.firstChild);
        el.replaceWith(frag);
        droppedNodes++;
        continue;
      }

      // Attribute scrub. Publisher styling is deliberately discarded here:
      // it is built for a paginated web viewer and renders badly on e-ink.
      const ourClass = (el.getAttribute('class') || '').split(/\s+/).filter((c) => c.startsWith('y2e-'));
      for (const a of Array.from(el.attributes)) {
        const n = a.name.toLowerCase();
        if (KEEP_ATTRS.has(n)) continue;
        if (n === 'epub:type' || n === 'role') continue;
        el.removeAttribute(a.name);
      }
      if (ourClass.length) el.setAttribute('class', ourClass.join(' '));

      if (tag === 'IMG') {
        const src = el.getAttribute('src') || '';
        if (!src || src.startsWith('data:')) {
          if (!src) {
            el.remove();
            continue;
          }
        }
        let rec = seenImg.get(src);
        if (!rec) {
          rec = { url: src, token: `__Y2E_IMG_${seenImg.size + 1}__` };
          seenImg.set(src, rec);
          images.push(rec);
        }
        el.setAttribute('src', rec.token);
        if (!el.getAttribute('alt')) el.setAttribute('alt', '');
      }

      if (tag === 'A') {
        const href = el.getAttribute('href') || '';
        // Same-section anchors and mail/tel links pass through untouched.
        if (href && !/^(#|mailto:|tel:|javascript:)/i.test(href)) {
          let abs = null;
          try {
            abs = new URL(href, doc.baseURI);
          } catch (_) {
            abs = null;
          }
          let base = null;
          try {
            base = new URL(doc.baseURI);
          } catch (_) {
            base = null;
          }
          if (!abs) {
            el.removeAttribute('href');
          } else if (base && abs.origin === base.origin) {
            // A link into another part of the book. It cannot be resolved to
            // an in-EPUB path yet, because the section it points at may not
            // have been extracted. Record the absolute target and let the
            // assembler rewrite it once every section has a filename. This is
            // what makes the book's own printed Contents page work.
            const token = `__Y2E_LINK_${links.length + 1}__`;
            links.push({ token, url: abs.href });
            el.setAttribute('href', token);
          } else {
            // Genuinely external: keep it absolute.
            el.setAttribute('href', abs.href);
          }
        }
      }

      walk(el);
    }
  }
  walk(root);

  // Drop elements that ended up empty and carry no meaning.
  const VOIDISH = new Set(['IMG', 'BR', 'HR', 'TD', 'TH', 'COL']);
  for (let pass = 0; pass < 3; pass++) {
    let removed = 0;
    root.querySelectorAll('p, div, span, section, li, figure').forEach((el) => {
      if (VOIDISH.has(el.tagName)) return;
      // Page markers are deliberately empty and are referenced by the
      // page-list. Elements with an id are anchor targets.
      if (el.classList && el.classList.contains('y2e-pagebreak')) return;
      if (el.hasAttribute('id')) return;
      if (el.querySelector('img, table, math, svg, .y2e-pagebreak')) return;
      if ((el.textContent || '').trim().length === 0 && el.children.length === 0) {
        el.remove();
        removed++;
      }
    });
    if (!removed) break;
  }

  // ── serialise to XHTML ────────────────────────────────────────────────
  const wrapper = doc.createElement('div');
  wrapper.setAttribute('class', 'y2e-section');
  // Declaring the prefix here makes the serializer emit epub:type on the page
  // markers instead of inventing ns1:, ns2: ... per element. Same meaning,
  // but it matches the markers the service worker injects for section starts.
  try {
    wrapper.setAttributeNS(
      'http://www.w3.org/2000/xmlns/', 'xmlns:epub', 'http://www.idpf.org/2007/ops');
  } catch (_) {}
  while (root.firstChild) wrapper.appendChild(root.firstChild);

  let xhtml;
  try {
    xhtml = new XMLSerializer().serializeToString(wrapper);
  } catch (err) {
    return { error: 'Serialisation failed: ' + err.message, score: best };
  }

  return {
    score: best,
    xhtml,
    images: images.map((i) => ({ url: i.url, token: i.token })),
    links,
    pages,
    hasMathML,
    hasSvg,
    droppedNodes,
    textLength: (wrapper.textContent || '').trim().length,
    docTitle: doc.title || '',
    baseURI: doc.baseURI || '',
  };
}
