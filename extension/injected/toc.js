/**
 * toc.js - injected into the top reader frame (reader.yuzu.com).
 *
 * Every function here is serialised by chrome.scripting.executeScript and runs
 * in the page's own world, so it must be fully self-contained: no imports, no
 * closure over anything in the service worker.
 *
 * Selector policy: Yuzu's CSS class names are styled-components hashes that
 * change on every deploy, so nothing here may key off class. We use only
 * data-interaction-id, data-uuid, aria-label and aria-current, all of which are
 * semantic and have been stable.
 */

/**
 * Read the full table of contents, expanding every collapsed Part first.
 * @returns {Promise<{error?: string, isbn?: string, title?: string,
 *                    authors?: string[], entries?: Array}>}
 */
function tocPanelContains(control, tocRoot) {
  // Accept a control only if it and the TOC list share a near ancestor, which
  // keeps us inside the TOC panel and out of the reader's header menus.
  let box = tocRoot;
  for (let i = 0; i < 4 && box; i++) {
    if (box.contains(control)) return true;
    box = box.parentElement;
  }
  return false;
}

async function yuzuReadToc() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    // The TOC panel must be open for its list to exist in the DOM.
    const openToc = () =>
      document.querySelector('button[aria-label="Table of Contents"]');
    if (!document.querySelector('button[data-uuid^="tocIndex"]')) {
      const btn = openToc();
      if (btn) {
        btn.click();
        await sleep(1200);
      }
    }

    // Wait for the list to appear at all.
    for (let i = 0; i < 30; i++) {
      if (document.querySelector('button[data-uuid^="tocIndex"]')) break;
      await sleep(500);
    }
    if (!document.querySelector('button[data-uuid^="tocIndex"]')) {
      return { error: 'Table of contents did not load. Open the book and try again.' };
    }

    // Everything below is scoped to the table of contents list. An earlier
    // version queried the whole document for collapsed expanders and clicked
    // all of them, which also hits the account and options menus in the
    // reader's header. Never click anything outside this subtree.
    const tocRoot = (() => {
      const entry = document.querySelector('button[data-uuid^="tocIndex"]');
      let outermost = null;
      let node = entry;
      while (node) {
        if (node.tagName === 'UL') outermost = node;
        node = node.parentElement;
      }
      return outermost;
    })();
    if (!tocRoot) {
      return { error: 'Could not locate the table of contents list.' };
    }

    // Expand every Part so nested chapters are present in the DOM. The control
    // flips to toc_collapse_all once expanded, so this is a no-op second time.
    const expandAll = document.querySelector('[data-interaction-id="toc_expand_all"]');
    if (expandAll && tocPanelContains(expandAll, tocRoot)) {
      expandAll.click();
      await sleep(1500);
    }

    // Belt and braces: expand any individual node still collapsed. Restricted
    // to toggles that sit inside the TOC list AND belong to a row that holds a
    // TOC entry, so no other disclosure widget can be hit by accident.
    for (let pass = 0; pass < 3; pass++) {
      const collapsed = Array.from(
        tocRoot.querySelectorAll('button[aria-expanded="false"]'),
      ).filter((b) => {
        const row = b.closest('li');
        return row && row.querySelector('button[data-uuid^="tocIndex"]');
      });
      if (!collapsed.length) break;
      collapsed.forEach((b) => b.click());
      await sleep(900);
    }

    const buttons = Array.from(tocRoot.querySelectorAll('button[data-uuid^="tocIndex"]'));

    // Nesting depth is the count of ancestor <ul> elements. The outermost list
    // is depth 1, so we normalise to a 0-based depth.
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
        index: i,
        title: title.trim(),
        page,
        depth: depths[i] - minDepth,
        isPart: !!(b.closest('li') && b.closest('li').querySelector('ul')),
      };
    });

    // Book metadata. document.title is "Yuzu: <book title>".
    const docTitle = (document.title || '').replace(/^\s*Yuzu:\s*/i, '').trim();
    const isbn = (location.pathname.match(/\/books\/([0-9Xx]+)/) || [])[1] || '';

    // The TOC panel header carries title and the author line beneath it.
    // Find the element whose text equals the book title, then read its sibling.
    let authors = [];
    if (docTitle) {
      const cands = Array.from(document.querySelectorAll('h1,h2,h3,h4,p,span,div'))
        .filter((e) => e.children.length === 0 && (e.textContent || '').trim() === docTitle);
      for (const c of cands) {
        const sib = c.parentElement && c.parentElement.nextElementSibling;
        const txt = sib ? (sib.textContent || '').trim() : '';
        if (txt && txt.length < 300 && txt !== docTitle) {
          authors = txt.split(/;|·|•/).map((s) => s.trim()).filter(Boolean);
          break;
        }
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
 * Navigate the reader to one TOC entry and wait for the reader to acknowledge
 * it. Acknowledgement is aria-current flipping to "true" on that button, which
 * the reader sets once the section is the active one.
 */
async function yuzuGotoSection(uuid) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const btn = document.querySelector(`button[data-uuid="${uuid}"]`);
    if (!btn) return { error: `TOC entry ${uuid} not found` };
    // If the reader has navigated away (session loss, error page), the entry
    // is gone and clicking blind would hit whatever replaced it.
    if (!/\/reader\/books\//.test(location.pathname)) {
      return { error: 'The reader is no longer showing a book.' };
    }

    const already = btn.getAttribute('aria-current') === 'true';
    btn.click();

    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const now = document.querySelector(`button[data-uuid="${uuid}"]`);
      if (now && now.getAttribute('aria-current') === 'true') {
        return { ok: true, alreadyThere: already, href: location.href };
      }
    }
    // Some entries (a Part that maps to the same spine item as its first
    // chapter) never take aria-current. Treat that as soft success.
    return { ok: true, soft: true, href: location.href };
  } catch (err) {
    return { error: 'Navigation failed: ' + (err && err.message ? err.message : String(err)) };
  }
}
