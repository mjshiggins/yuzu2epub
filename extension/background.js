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
const cacheKeyFor = (isbn) => `y2e_sections_${isbn || 'unknown'}`;

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
async function runInTop(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func,
    args,
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

async function extractBook(tabId, prior, key) {
  setState({ phase: 'Reading table of contents' });
  await assertReaderAlive(tabId);

  const toc = await runInTop(tabId, yuzuReadToc);
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
  let start = 0;
  if (prior && prior.entries && prior.entries.length === toc.entries.length
      && prior.meta && prior.meta.isbn === meta.isbn) {
    sections = prior.sections || [];
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

  const save = async (nextIndex, complete) => {
    try {
      await chrome.storage.local.set({
        [key]: { meta, entries: toc.entries, sections, nextIndex, complete: !!complete },
      });
    } catch (err) {
      warn(`Could not checkpoint progress: ${err.message}`);
    }
  };

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
    });

    const nav = await runInTop(tabId, yuzuGotoSection, [entry.uuid]);
    if (!nav || nav.error) {
      warn(`Could not open "${entry.title}": ${(nav && nav.error) || 'unknown error'}`);
      continue;
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

    const n = String(sections.length + 1).padStart(4, '0');
    sections.push({
      id: `sec-${n}`,
      filename: `text/section-${n}.xhtml`,
      title: entry.title,
      depth: entry.depth,
      page: entry.page,
      body: payload.xhtml,
      images: payload.images || [],
      pages: payload.pages || [],
      hasMathML: !!payload.hasMathML,
      hasSvg: !!payload.hasSvg,
    });

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

  await save(toc.entries.length, true);
  return { meta, entries: toc.entries, sections, nextIndex: toc.entries.length, complete: true };
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

  const isbn = await currentIsbn(tabId);
  const key = cacheKeyFor(isbn);

  if (fresh) await chrome.storage.local.remove(key);

  // Extraction is the expensive half. Reuse whatever a previous run banked:
  // a finished extraction skips straight to assembly, a partial one carries on
  // from the section it stopped at.
  let prior = null;
  if (!fresh) {
    const stored = await chrome.storage.local.get(key);
    if (stored[key] && stored[key].sections && stored[key].sections.length) {
      prior = stored[key];
    }
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
    job = await extractBook(tabId, prior, key);
  }

  setState({ status: 'assembling', phase: 'Fetching images' });

  const result = await self.YuzuAssemble.assembleEpub(job, tabId, (phase) => setState({ phase }));
  for (const w of result.warnings) warn(w);

  setState({ phase: 'Saving' });
  await downloadBlob(result.blob, result.filename);

  await chrome.storage.local.remove(key);
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
      `${(result.blob.size / 1048576).toFixed(1)} MB` +
      (result.failedImages ? `, ${result.failedImages} images unavailable` : ''),
  });
}

async function refreshResumable(tabId) {
  const isbn = await currentIsbn(tabId);
  const key = cacheKeyFor(isbn);
  const stored = await chrome.storage.local.get(key);
  const job = stored[key];
  const n = job && job.sections ? job.sections.length : 0;
  setState({
    resumable: n,
    resumableTotal: job && job.entries ? job.entries.length : 0,
    resumableComplete: !!(job && job.complete),
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
