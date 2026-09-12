/**
 * background.js - the driver.
 *
 * Walks the book's table of contents, navigating the reader to each section and
 * extracting it once it has rendered, then fetches images and assembles the
 * EPUB here in the service worker.
 *
 * Division of labour, and why:
 *   - The service worker has fetch, CompressionStream and full chrome.* access,
 *     so extraction, image collection and zip assembly all live here.
 *   - Offscreen documents are limited to the chrome.runtime API. They have no
 *     chrome.storage and no chrome.downloads. The one thing they can do that a
 *     service worker cannot is URL.createObjectURL, so that is all ours does.
 *   - The finished blob reaches the offscreen document through the Cache API,
 *     because extension messaging is JSON-only and cannot carry binary.
 *
 * Why this drives the reader UI rather than calling Yuzu's content API: the
 * extension reads what the reader has already rendered in the user's own
 * authenticated session, the same access path as reading the book by hand. It
 * is slower, and it is the only version of this tool that is obviously just
 * format-shifting a book you bought.
 */

importScripts(
  'lib/zip.js',
  'lib/xml.js',
  'lib/stylesheet.js',
  'lib/epub.js',
  'lib/assemble.js',
  'injected/toc.js',
  'injected/fetch-image.js',
  'injected/extract.js',
);

const CACHE_NAME = 'y2e-output';
const CACHE_KEY = 'https://y2e.invalid/book.epub';

/**
 * Checkpoint storage.
 *
 * Sections are written in batches rather than as one growing blob. A textbook
 * can run to 700+ sections, and rewriting the whole job every few sections is
 * quadratic: it would move gigabytes over a single run. Each checkpoint now
 * writes one batch plus a small header record.
 */
const BATCH_SIZE = 25;
const jobKeyFor = (isbn) => `y2e_job_${isbn || 'unknown'}`;
const batchKeyFor = (isbn, n) => `y2e_sec_${isbn || 'unknown'}_${n}`;

async function saveHeader(isbn, header) {
  await chrome.storage.local.set({ [jobKeyFor(isbn)]: header });
}

async function saveBatch(isbn, batchIndex, sections) {
  const slice = sections.slice(batchIndex * BATCH_SIZE, (batchIndex + 1) * BATCH_SIZE);
  await chrome.storage.local.set({ [batchKeyFor(isbn, batchIndex)]: slice });
}

async function loadJob(isbn) {
  const headerKey = jobKeyFor(isbn);
  const got = await chrome.storage.local.get(headerKey);
  const header = got[headerKey];
  if (!header) return null;

  const batches = Math.ceil((header.count || 0) / BATCH_SIZE);
  const keys = [];
  for (let i = 0; i < batches; i++) keys.push(batchKeyFor(isbn, i));
  const stored = keys.length ? await chrome.storage.local.get(keys) : {};
  const sections = [];
  for (const k of keys) {
    const part = stored[k];
    if (Array.isArray(part)) sections.push(...part);
  }
  // A missing batch means the checkpoint is torn; fall back to what is
  // contiguous rather than assembling a book with holes in it.
  if (sections.length !== (header.count || 0)) {
    return { ...header, sections, torn: true };
  }
  return { ...header, sections };
}

async function clearJob(isbn) {
  const headerKey = jobKeyFor(isbn);
  const got = await chrome.storage.local.get(headerKey);
  const header = got[headerKey];
  const keys = [headerKey];
  const batches = header ? Math.ceil((header.count || 0) / BATCH_SIZE) : 0;
  for (let i = 0; i < batches; i++) keys.push(batchKeyFor(isbn, i));
  // Sweep any orphaned batches from an earlier, longer run.
  const all = await chrome.storage.local.get(null);
  for (const k of Object.keys(all)) {
    if (k.startsWith(`y2e_sec_${isbn || 'unknown'}_`)) keys.push(k);
  }
  await chrome.storage.local.remove([...new Set(keys)]);
}

const state = {
  status: 'idle', // idle | running | assembling | done | error
  phase: '',
  current: 0,
  total: 0,
  title: '',
  message: '',
  warnings: [],
  filename: '',
  resumable: 0,
  resumableTotal: 0,
  resumableComplete: false,
  etaMinutes: 0,
  cancelled: false,
};

function setState(patch) {
  Object.assign(state, patch);
  chrome.runtime.sendMessage({ type: 'y2e:state', state }).catch(() => {});
}

function warn(msg) {
  state.warnings.push(msg);
  console.warn('[yuzu2epub]', msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let runStartedAt = 0;
let sectionsThisRun = 0;

/** Minutes remaining, from the rate actually observed this run. */
function estimateRemaining(done, total) {
  if (!runStartedAt || sectionsThisRun < 3 || done >= total) return 0;
  const perSection = (Date.now() - runStartedAt) / sectionsThisRun;
  return Math.max(1, Math.round(((total - done) * perSection) / 60000));
}

function startKeepAlive() {
  chrome.alarms.create('y2e-keepalive', { periodInMinutes: 0.4 });
}
function stopKeepAlive() {
  chrome.alarms.clear('y2e-keepalive');
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'y2e-keepalive') chrome.runtime.getPlatformInfo(() => {});
});

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------
/**
 * @param {string} [world] 'MAIN' to run in the page's own JS world.
 *
 * Content scripts run in an isolated world by default. That world shares the
 * DOM but NOT properties the page's own scripts attached to DOM nodes, so
 * React's __reactFiber$ expandos are invisible from it. Reading the TOC needs
 * them, so that one call runs in MAIN. Everything else stays isolated.
 */
async function runInTop(tabId, func, args = [], world) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func,
    args,
    ...(world ? { world } : {}),
  });
  return res && res.result;
}

async function extractBestFrame(tabId, opts) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: yuzuExtractSection,
    args: [opts],
  });
  let best = null;
  for (const r of results) {
    const v = r && r.result;
    if (!v || v.skip || v.error) continue;
    if (!best || (v.score || 0) > (best.score || 0)) best = v;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Download, via a blob URL minted in the offscreen document
// ---------------------------------------------------------------------------
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Create a blob URL so the assembled EPUB can be downloaded.',
  });
}

async function closeOffscreen() {
  try {
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existing.length) await chrome.offscreen.closeDocument();
  } catch (_) {}
}

function waitForDownload(downloadId) {
  return new Promise((resolve) => {
    const done = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(done);
        resolve(delta.state.current);
      }
    };
    chrome.downloads.onChanged.addListener(done);
    // Never hang the job on a download that reports nothing back.
    setTimeout(() => {
      chrome.downloads.onChanged.removeListener(done);
      resolve('timeout');
    }, 15 * 60 * 1000);
  });
}

async function downloadBlob(blob, filename) {
  const cache = await caches.open(CACHE_NAME);
  await cache.put(CACHE_KEY, new Response(blob, {
    headers: { 'content-type': 'application/epub+zip' },
  }));

  await ensureOffscreen();
  const minted = await chrome.runtime.sendMessage({
    target: 'y2e-offscreen',
    type: 'y2e:mintUrl',
    cacheName: CACHE_NAME,
    key: CACHE_KEY,
  });
  if (!minted || !minted.ok) {
    throw new Error((minted && minted.error) || 'Could not prepare the file for download.');
  }

  const downloadId = await chrome.downloads.download({
    url: minted.url,
    filename,
    saveAs: true,
  });
  const outcome = await waitForDownload(downloadId);

  await chrome.runtime
    .sendMessage({ target: 'y2e-offscreen', type: 'y2e:revoke' })
    .catch(() => {});
  await closeOffscreen();
  await caches.delete(CACHE_NAME);

  if (outcome === 'interrupted') throw new Error('The download was interrupted.');
  return outcome;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------
const CHECKPOINT_EVERY = 3;
const MAX_CONSECUTIVE_NAV_FAILURES = 5;

async function extractBook(tabId, prior, isbn) {
  setState({ phase: 'Reading table of contents' });
  await assertReaderAlive(tabId);

  const toc = await runInTop(tabId, yuzuReadToc, [], 'MAIN');
  if (!toc || toc.error) {
    throw new Error((toc && toc.error) || 'Could not read the table of contents.');
  }
  if (!toc.entries || !toc.entries.length) throw new Error('The table of contents is empty.');

  const meta = {
    title: toc.title,
    authors: toc.authors && toc.authors.length ? toc.authors : [],
    language: toc.language || 'en',
    isbn: toc.isbn || '',
    coverUrl: toc.isbn ? `https://covers.vitalsource.com/vbid/${toc.isbn}/width/1400` : '',
  };

  // Resume only when the book still has the same shape. A different TOC length
  // means a different book or a changed edition, so start clean.
  let sections = [];
  let navEntries = [];
  let start = 0;
  if (prior && prior.entries && prior.entries.length === toc.entries.length
      && prior.meta && prior.meta.isbn === meta.isbn) {
    sections = prior.sections || [];
    navEntries = prior.navEntries || [];
    start = prior.nextIndex || 0;
  }

  setState({
    title: toc.title,
    total: toc.entries.length,
    current: start,
    phase: start
      ? `Resuming at section ${start + 1} of ${toc.entries.length}`
      : `Extracting ${toc.entries.length} sections`,
  });

  // Writes one batch plus a small header, never the whole book.
  const save = async (nextIndex, complete) => {
    try {
      const lastBatch = Math.max(0, Math.ceil(sections.length / BATCH_SIZE) - 1);
      await saveBatch(isbn, lastBatch, sections);
      await saveHeader(isbn, {
        meta,
        entries: toc.entries,
        navEntries,
        nextIndex,
        complete: !!complete,
        count: sections.length,
        total: toc.entries.length,
      });
    } catch (err) {
      warn(`Could not checkpoint progress: ${err.message}`);
    }
  };

  let consecutiveNavFailures = 0;

  // A TOC entry is not the same thing as a document. Some books give every
  // entry its own file; others point hundreds of entries at anchors inside a
  // handful of chapter files (one tested book: 658 entries, 31 documents).
  // Extract each document once and let the navigation tree carry the rest,
  // otherwise the same chapter is captured once per anchor.
  const docOf = (e) => (e.path ? e.path.split('#')[0] : '');
  const fragOf = (e) => {
    if (!e.path) return '';
    const i = e.path.indexOf('#');
    return i === -1 ? '' : e.path.slice(i + 1);
  };

  const docUrlOf = (u) => String(u || '').split('?')[0].split('#')[0];

  // Two indexes, deliberately.
  //   byDoc    keyed on the path the TOC declares. Lets us skip navigating
  //            entirely, but depends on reading the reader's React state.
  //   byDocUrl keyed on the URL the content frame actually loaded. Always
  //            available, costs a navigation to learn, and is what keeps the
  //            book correct when the TOC paths cannot be read.
  const byDoc = new Map();
  const byDocUrl = new Map();
  for (const sec of sections) {
    if (sec.docKey) byDoc.set(sec.docKey, sec);
    if (sec.sourceUrl) byDocUrl.set(docUrlOf(sec.sourceUrl), sec);
  }

  const withPath = toc.entries.filter((e) => e.path).length;
  const distinctDocs = new Set(toc.entries.map(docOf).filter(Boolean)).size;

  if (!withPath) {
    // Without paths every entry is treated as its own document. On a book
    // whose TOC points many entries into one chapter file, that means
    // extracting the same chapter repeatedly. Say so rather than silently
    // producing a book full of duplicates.
    warn('Could not read document paths from the reader, so entries that share '
      + 'a chapter file cannot be grouped. Duplicate sections are likely.');
  } else if (withPath < toc.entries.length) {
    warn(`${toc.entries.length - withPath} of ${toc.entries.length} entries have no `
      + 'document path; those cannot be grouped.');
  }

  if (distinctDocs && distinctDocs < toc.entries.length) {
    setState({
      phase: `${toc.entries.length} entries across ${distinctDocs} documents`,
    });
  }

  for (let i = start; i < toc.entries.length; i++) {
    if (state.cancelled) {
      await save(i, false);
      throw new Error('Cancelled. Press Finish EPUB to carry on from here.');
    }
    const entry = toc.entries[i];

    // Checkpoint before anything that can fail, so a session loss costs at
    // most a couple of sections rather than the whole run.
    try {
      await assertReaderAlive(tabId);
    } catch (err) {
      await save(i, false);
      throw err;
    }
    setState({
      current: i + 1,
      phase: `Section ${i + 1} of ${toc.entries.length}: ${entry.title}`,
      etaMinutes: estimateRemaining(i, toc.entries.length),
    });

    // Already have this document? Record the navigation target and move on
    // without touching the reader at all.
    const docKey = docOf(entry);
    if (docKey && byDoc.has(docKey)) {
      const existing = byDoc.get(docKey);
      navEntries.push({
        title: entry.title,
        depth: entry.depth,
        href: existing.filename + (fragOf(entry) ? `#${fragOf(entry)}` : ''),
      });
      if ((i + 1) % CHECKPOINT_EVERY === 0) await save(i + 1, false);
      continue;
    }

    const nav = await runInTop(tabId, yuzuGotoSection, [entry, toc.entries.length]);
    if (!nav || nav.error) {
      warn(`Could not open "${entry.title}": ${(nav && nav.error) || 'unknown error'}`);
      consecutiveNavFailures++;
      // A run that cannot reach the table of contents any more will fail on
      // every remaining entry. Racing through hundreds of them produces a
      // wall of identical warnings and a half a book, so stop and let the
      // checkpoint be resumed instead.
      if (consecutiveNavFailures >= MAX_CONSECUTIVE_NAV_FAILURES) {
        await save(i, false);
        throw new Error(
          `Navigation failed on ${consecutiveNavFailures} sections in a row, stopping at ` +
          `section ${i + 1} of ${toc.entries.length}. The reader's table of contents is no ` +
          `longer reachable, usually because the page reloaded or the session dropped. ` +
          `Reopen the book and press Resume.`,
        );
      }
      continue;
    }
    consecutiveNavFailures = 0;
    if (nav.recovered) {
      warn(`Table of contents had collapsed; re-expanded it to reach "${entry.title}".`);
    }
    await sleep(900);

    let payload = null;
    for (let attempt = 0; attempt < 3 && !payload; attempt++) {
      if (attempt) await sleep(1500 * attempt);
      try {
        payload = await extractBestFrame(tabId, {});
      } catch (err) {
        warn(`Extraction error on "${entry.title}" (attempt ${attempt + 1}): ${err.message}`);
      }
    }
    if (!payload) {
      warn(`No content extracted for "${entry.title}". It will be missing from the book.`);
      continue;
    }
    if (payload.textLength < 40 && !/cover|title page/i.test(entry.title)) {
      warn(`"${entry.title}" extracted almost no text (${payload.textLength} chars).`);
    }

    if (entry.path && payload.baseURI) {
      // The TOC told us which document this entry lives in. If the reader gave
      // us a different one, navigation raced and the content is wrong.
      const want = entry.path.split('#')[0].split('/').pop();
      const got = payload.baseURI.split('?')[0].split('#')[0].split('/').pop();
      if (want && got && want !== got) {
        warn(`"${entry.title}" expected ${want} but extracted ${got}.`);
      }
    }

    // The frame tells us which document we actually got. If it is one we have
    // already stored, this entry is another anchor into it, not a new section.
    // This is the backstop that works without any reader internals.
    const loadedUrl = docUrlOf(payload.baseURI);
    if (loadedUrl && byDocUrl.has(loadedUrl)) {
      const existing = byDocUrl.get(loadedUrl);
      navEntries.push({
        title: entry.title,
        depth: entry.depth,
        href: existing.filename + (fragOf(entry) ? `#${fragOf(entry)}` : ''),
      });
      // Remember the TOC path too, so later entries can skip navigating.
      if (docKey && !byDoc.has(docKey)) byDoc.set(docKey, existing);
      sectionsThisRun++;
      if ((i + 1) % CHECKPOINT_EVERY === 0) await save(i + 1, false);
      continue;
    }

    // Catch the same failure by content as well as by URL. An identical body
    // means the reader did not move, whatever the TOC claimed.
    if (sections.length) {
      const prev = sections[sections.length - 1];
      if (prev.body === payload.xhtml) {
        warn(`"${entry.title}" extracted content identical to "${prev.title}". `
          + `The reader may not have navigated.`);
      }
    }

    const n = String(sections.length + 1).padStart(4, '0');
    const section = {
      id: `sec-${n}`,
      filename: `text/section-${n}.xhtml`,
      docKey,
      title: entry.title,
      depth: entry.depth,
      page: entry.page,
      body: payload.xhtml,
      images: payload.images || [],
      links: payload.links || [],
      pages: payload.pages || [],
      // The document URL this section came from. The assembler matches link
      // targets against these to turn cross-section links into real ones.
      sourceUrl: payload.baseURI || '',
      hasMathML: !!payload.hasMathML,
      hasSvg: !!payload.hasSvg,
    };
    sections.push(section);
    if (docKey) byDoc.set(docKey, section);
    if (loadedUrl) byDocUrl.set(loadedUrl, section);

    navEntries.push({
      title: entry.title,
      depth: entry.depth,
      href: section.filename + (fragOf(entry) ? `#${fragOf(entry)}` : ''),
    });

    sectionsThisRun++;
    if ((i + 1) % CHECKPOINT_EVERY === 0) await save(i + 1, false);
  }

  if (!sections.length) throw new Error('Nothing could be extracted from this book.');

  // Where the content carried no page markers, fall back to the TOC's own
  // section-start page so the page-list still has an entry.
  for (const s of sections) {
    if (!s.pages.length && s.page) {
      s.pages = [{ id: 'y2e-page-start', label: s.page }];
      s.body = s.body.replace(
        /^(<div[^>]*class="y2e-section"[^>]*>)/,
        `$1<span class="y2e-pagebreak" id="y2e-page-start" epub:type="pagebreak" role="doc-pagebreak" title="${s.page}"></span>`,
      );
    }
  }

  // Flush every batch, not just the last, so a resume can read them all back.
  for (let b = 0; b * BATCH_SIZE < sections.length; b++) await saveBatch(isbn, b, sections);
  await save(toc.entries.length, true);
  return {
    meta, entries: toc.entries, sections, navEntries,
    nextIndex: toc.entries.length, complete: true,
  };
}

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------
/**
 * Yuzu sessions can end mid-run: an SSO timeout bounces the tab to a logout or
 * error page. Without this check the driver would keep clicking blind through
 * whatever replaced the reader for every remaining section.
 */
async function assertReaderAlive(tabId) {
  let url = '';
  try {
    url = (await chrome.tabs.get(tabId)).url || '';
  } catch (_) {
    throw new Error('The reader tab was closed. Reopen the book and press Finish EPUB to carry on.');
  }
  if (/^https?:\/\/reader\.yuzu\.com\/reader\/books\//.test(url)) return;

  if (/logout|signout|sso\.|\/login|signin|idp/i.test(url)) {
    throw new Error(
      'Your Yuzu session ended, so the reader signed out. Sign back in, reopen ' +
      'the book, then press Finish EPUB to carry on from where this stopped.',
    );
  }
  throw new Error(
    'The reader tab navigated away from the book. Reopen it and press Finish ' +
    'EPUB to carry on from where this stopped.',
  );
}

async function currentIsbn(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return (tab.url.match(/\/books\/([0-9Xx]+)/) || [])[1] || '';
  } catch (_) {
    return '';
  }
}

async function runJob(tabId, { fresh = false } = {}) {
  setState({
    status: 'running',
    phase: 'Starting',
    current: 0,
    total: 0,
    warnings: [],
    message: '',
    filename: '',
    cancelled: false,
  });
  startKeepAlive();
  runStartedAt = Date.now();
  sectionsThisRun = 0;

  const isbn = await currentIsbn(tabId);

  if (fresh) await clearJob(isbn);

  // Extraction is the expensive half. Reuse whatever a previous run banked:
  // a finished extraction skips straight to assembly, a partial one carries on
  // from the section it stopped at.
  let prior = null;
  if (!fresh) {
    prior = await loadJob(isbn);
    if (prior && prior.torn) {
      warn(`Checkpoint was incomplete; resuming from section ${prior.sections.length + 1}.`);
      prior.nextIndex = Math.min(prior.nextIndex || 0, prior.sections.length);
      prior.complete = false;
    }
    if (!prior || !prior.sections || !prior.sections.length) prior = null;
  }

  let job;
  if (prior && prior.complete) {
    job = prior;
    setState({
      title: job.meta.title,
      total: job.sections.length,
      current: job.sections.length,
      phase: `Reusing ${job.sections.length} sections extracted earlier`,
    });
  } else {
    job = await extractBook(tabId, prior, isbn);
  }

  setState({ status: 'assembling', phase: 'Fetching images' });

  const result = await self.YuzuAssemble.assembleEpub(job, tabId, (phase) => setState({ phase }));
  for (const w of result.warnings) warn(w);

  setState({ phase: 'Saving' });
  await downloadBlob(result.blob, result.filename);

  await clearJob(isbn);
  stopKeepAlive();

  setState({
    status: 'done',
    phase: 'Done',
    filename: result.filename,
    resumable: 0,
    resumableTotal: 0,
    resumableComplete: false,
    message:
      `${job.sections.length} sections, ${result.imageCount} images, ` +
      `${result.linksResolved} cross-references linked, ` +
      `${(result.blob.size / 1048576).toFixed(1)} MB` +
      (result.failedImages ? `, ${result.failedImages} images unavailable` : ''),
  });
}

async function refreshResumable(tabId) {
  const isbn = await currentIsbn(tabId);
  const headerKey = jobKeyFor(isbn);
  const got = await chrome.storage.local.get(headerKey);
  const header = got[headerKey];
  const n = header ? header.count || 0 : 0;
  setState({
    resumable: n,
    resumableTotal: header ? header.total || 0 : 0,
    resumableComplete: !!(header && header.complete),
  });
  return n;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === 'y2e:getState') {
    if (msg.tabId != null && state.status === 'idle') {
      refreshResumable(msg.tabId).then(() => sendResponse({ state }));
      return true;
    }
    sendResponse({ state });
    return false;
  }

  if (msg.type === 'y2e:cancel') {
    state.cancelled = true;
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'y2e:start') {
    if (state.status === 'running' || state.status === 'assembling') {
      sendResponse({ ok: false, error: 'A job is already running.' });
      return false;
    }
    runJob(msg.tabId, { fresh: !!msg.fresh }).catch(async (err) => {
      stopKeepAlive();
      await closeOffscreen();
      const n = await refreshResumable(msg.tabId).catch(() => 0);
      setState({
        status: 'error',
        phase: 'Failed',
        message: err.message,
        resumable: n,
      });
    });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
