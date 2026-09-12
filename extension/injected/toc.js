/**
 * toc.js - injected into the top reader frame (reader.yuzu.com).
 *
 * IMPORTANT: chrome.scripting.executeScript serialises ONLY the function it is
 * given. Nothing at module scope exists in the page. Every helper must be
 * nested inside the entry point that uses it, even where that means repeating
 * it across two functions. A previous version hoisted helpers here and failed
 * at runtime with "tocPanelContains is not defined".
 *
 * Selector policy: Yuzu's CSS class names are styled-components hashes that
 * change on every deploy, so nothing here may key off class. We use only
 * data-interaction-id, data-uuid, aria-label and aria-current, all of which are
 * semantic and have been stable.
 */

/**
 * Read the full table of contents, expanding every collapsed Part first.
 */
async function yuzuReadToc() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- nested by necessity: see the note at the top of this file ----------
  function tocListRoot() {
    const entry = document.querySelector('button[data-uuid^="tocIndex"]');
    let outermost = null;
    let node = entry;
    while (node) {
      if (node.tagName === 'UL') outermost = node;
      node = node.parentElement;
    }
    return outermost;
  }

  function nearTocPanel(control, tocRoot) {
    let box = tocRoot;
    for (let i = 0; i < 4 && box; i++) {
      if (box.contains(control)) return true;
      box = box.parentElement;
    }
    return false;
  }

  async function expandEverything() {
    const tocRoot = tocListRoot();
    if (!tocRoot) return false;
    const expandAll = document.querySelector('[data-interaction-id="toc_expand_all"]');
    if (expandAll && nearTocPanel(expandAll, tocRoot)) {
      expandAll.click();
      await sleep(1500);
    }
    // Only toggles inside the TOC list, and only on rows that hold an entry,
    // so no other disclosure widget on the page can be clicked by accident.
    for (let pass = 0; pass < 4; pass++) {
      const root = tocListRoot();
      if (!root) break;
      const collapsed = Array.from(root.querySelectorAll('button[aria-expanded="false"]'))
        .filter((b) => {
          const row = b.closest('li');
          return row && row.querySelector('button[data-uuid^="tocIndex"]');
        });
      if (!collapsed.length) break;
      collapsed.forEach((b) => b.click());
      await sleep(900);
    }
    return true;
  }

  function sourcePathOf(el) {
    // The reader keeps each entry's source document path on its React fiber.
    // React internals are fragile, so this is optional everywhere it is used.
    try {
      const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      if (!fk) return '';
      let f = el[fk];
      for (let i = 0; i < 14 && f; i++) {
        const mp = f.memoizedProps;
        if (mp && typeof mp === 'object') {
          for (const k of ['toc', 'tocItem', 'item', 'node']) {
            const o = mp[k];
            if (o && typeof o === 'object' && typeof o.path === 'string' && o.path) return o.path;
          }
        }
        f = f.return;
      }
    } catch (_) { /* React internals moved; carry on without it */ }
    return '';
  }

  try {
    // The TOC panel must be open for its list to exist in the DOM.
    if (!document.querySelector('button[data-uuid^="tocIndex"]')) {
      const btn = document.querySelector('button[aria-label="Table of Contents"]');
      if (btn) {
        btn.click();
        await sleep(1200);
      }
    }
    for (let i = 0; i < 30; i++) {
      if (document.querySelector('button[data-uuid^="tocIndex"]')) break;
      await sleep(500);
    }
    if (!document.querySelector('button[data-uuid^="tocIndex"]')) {
      return { error: 'Table of contents did not load. Open the book and try again.' };
    }

    if (!(await expandEverything())) {
      return { error: 'Could not locate the table of contents list.' };
    }

    const tocRoot = tocListRoot();
    const buttons = Array.from(tocRoot.querySelectorAll('button[data-uuid^="tocIndex"]'));

    const ulDepth = (el) => {
      let d = 0;
      let p = el;
      while (p) {
        if (p.tagName === 'UL') d++;
        p = p.parentElement;
      }
      return d;
    };
    const depths = buttons.map(ulDepth);
    const minDepth = depths.length ? Math.min.apply(null, depths) : 1;

    const entries = buttons.map((b, i) => {
      const label = b.getAttribute('aria-label') || '';
      // Format is "Go to <title>, page <page>". Anchor on the LAST ", page "
      // so titles containing that phrase do not split wrongly.
      let title = label.replace(/^Go to\s+/i, '');
      let page = '';
      const m = title.match(/^(.*),\s*page\s+([^,]*)$/i);
      if (m) {
        title = m[1];
        page = m[2].trim();
      }
      if (!title) {
        const span = b.querySelector('span');
        title = span ? (span.textContent || '').trim() : `Section ${i + 1}`;
      }
      return {
        uuid: b.getAttribute('data-uuid'),
        // aria-label is the identity used for navigation. data-uuid is
        // positional (tocIndexN by rendered order) and therefore only a hint.
        label,
        index: i,
        title: title.trim(),
        page,
        depth: depths[i] - minDepth,
        path: sourcePathOf(b),
        isPart: !!(b.closest('li') && b.closest('li').querySelector('ul')),
      };
    });

    const docTitle = (document.title || '').replace(/^\s*Yuzu:\s*/i, '').trim();
    const isbn = (location.pathname.match(/\/books\/([0-9Xx]+)/) || [])[1] || '';

    let authors = [];
    if (docTitle) {
      const cands = Array.from(document.querySelectorAll('h1,h2,h3,h4,p,span,div'))
        .filter((e) => e.children.length === 0 && (e.textContent || '').trim() === docTitle);
      // The byline sits next to the title element on some books and next to
      // its parent on others.
      for (const c of cands) {
        const siblings = [c.nextElementSibling, c.parentElement && c.parentElement.nextElementSibling];
        for (const sib of siblings) {
          const txt = sib ? (sib.textContent || '').trim() : '';
          if (txt && txt.length < 300 && txt !== docTitle && !/Table of Contents/i.test(txt)) {
            authors = txt.split(/;|·|•|,\s+(?=[A-Z])/).map((x) => x.trim()).filter(Boolean);
            break;
          }
        }
        if (authors.length) break;
      }
    }

    return {
      isbn,
      title: docTitle || 'Untitled',
      authors,
      language: document.documentElement.lang || 'en',
      entries,
    };
  } catch (err) {
    return { error: 'TOC read failed: ' + (err && err.message ? err.message : String(err)) };
  }
}

/**
 * Navigate the reader to one TOC entry.
 *
 * The entry is identified by aria-label, not by data-uuid. tocIndexN is
 * assigned by rendered position, and the reader can remount the panel back to
 * its collapsed state (12 top-level rows on this book, out of 741). A run that
 * trusted the captured uuid lost every section after that point, because the
 * rows simply were not in the DOM any more. So this re-expands the tree
 * whenever the list looks short, then matches on a stable key.
 *
 * @param {{uuid: string, label: string, title: string, page: string, path: string}} entry
 * @param {number} expectedTotal how many entries the TOC had when it was read
 */
async function yuzuGotoSection(entry, expectedTotal) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- nested by necessity: see the note at the top of this file ----------
  function tocListRoot() {
    const e = document.querySelector('button[data-uuid^="tocIndex"]');
    let outermost = null;
    let node = e;
    while (node) {
      if (node.tagName === 'UL') outermost = node;
      node = node.parentElement;
    }
    return outermost;
  }

  function nearTocPanel(control, tocRoot) {
    let box = tocRoot;
    for (let i = 0; i < 4 && box; i++) {
      if (box.contains(control)) return true;
      box = box.parentElement;
    }
    return false;
  }

  async function expandEverything() {
    const tocRoot = tocListRoot();
    if (!tocRoot) return false;
    const expandAll = document.querySelector('[data-interaction-id="toc_expand_all"]');
    if (expandAll && nearTocPanel(expandAll, tocRoot)) {
      expandAll.click();
      await sleep(1500);
    }
    for (let pass = 0; pass < 4; pass++) {
      const root = tocListRoot();
      if (!root) break;
      const collapsed = Array.from(root.querySelectorAll('button[aria-expanded="false"]'))
        .filter((b) => {
          const row = b.closest('li');
          return row && row.querySelector('button[data-uuid^="tocIndex"]');
        });
      if (!collapsed.length) break;
      collapsed.forEach((b) => b.click());
      await sleep(900);
    }
    return true;
  }

  function findEntry() {
    // aria-label first: it is the entry's real identity and is effectively
    // unique (740 distinct labels across 741 rows on the book this was tested
    // against). data-uuid is only a positional hint.
    if (entry.label) {
      const byLabel = Array.from(
        document.querySelectorAll('button[data-uuid^="tocIndex"]'),
      ).filter((b) => b.getAttribute('aria-label') === entry.label);
      if (byLabel.length === 1) return byLabel[0];
      if (byLabel.length > 1 && entry.uuid) {
        const exact = byLabel.find((b) => b.getAttribute('data-uuid') === entry.uuid);
        if (exact) return exact;
        return byLabel[0];
      }
    }
    if (entry.uuid) {
      const byUuid = document.querySelector(`button[data-uuid="${entry.uuid}"]`);
      if (byUuid) {
        // Only trust the positional id when the label still agrees.
        const lbl = byUuid.getAttribute('aria-label') || '';
        if (!entry.label || lbl === entry.label) return byUuid;
      }
    }
    return null;
  }

  try {
    if (!/\/reader\/books\//.test(location.pathname)) {
      return { error: 'The reader is no longer showing a book.' };
    }

    // Reopen the panel if it went away entirely.
    if (!document.querySelector('button[data-uuid^="tocIndex"]')) {
      const open = document.querySelector('button[aria-label="Table of Contents"]');
      if (open) {
        open.click();
        await sleep(1500);
      }
    }

    let btn = findEntry();
    let recovered = false;

    // A short list means the tree collapsed back. Re-expand and look again.
    const rendered = document.querySelectorAll('button[data-uuid^="tocIndex"]').length;
    if (!btn || (expectedTotal && rendered < expectedTotal)) {
      await expandEverything();
      const found = findEntry();
      if (found) {
        recovered = !btn;
        btn = found;
      }
    }

    if (!btn) {
      const now = document.querySelectorAll('button[data-uuid^="tocIndex"]').length;
      return {
        error: `"${entry.title}" is not in the table of contents `
          + `(${now} of ${expectedTotal || '?'} rows rendered after re-expanding).`,
      };
    }

    const already = btn.getAttribute('aria-current') === 'true';
    const uuidNow = btn.getAttribute('data-uuid');
    btn.click();

    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const now = document.querySelector(`button[data-uuid="${uuidNow}"]`);
      if (now && now.getAttribute('aria-current') === 'true') {
        return { ok: true, alreadyThere: already, recovered, href: location.href };
      }
    }
    // Some entries (a Part sharing a spine item with its first chapter) never
    // take aria-current. Treat that as a soft success.
    return { ok: true, soft: true, recovered, href: location.href };
  } catch (err) {
    return { error: 'Navigation failed: ' + (err && err.message ? err.message : String(err)) };
  }
}
