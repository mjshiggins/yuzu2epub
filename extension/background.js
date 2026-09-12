/**
 * background.js - the driver.
 *
 * Walks the book's table of contents, navigating the reader to each section
 * and extracting it once it has rendered. The service worker holds only text;
 * image bytes and the final zip live in the offscreen document, because MV3
 * service workers have no URL.createObjectURL and cannot hand a Blob to
 * chrome.downloads.
 *
 * Why this drives the reader UI rather than calling Yuzu's content API:
 * the extension reads what the reader has already rendered in the user's own
 * authenticated session, the same access path as reading the book by hand. It
 * is slower. It is also the only version of this tool that is obviously just
 * format-shifting a book you bought.
 */

importScripts(
  'lib/zip.js',
  'lib/xml.js',
  'lib/stylesheet.js',
  'lib/epub.js',
  'injected/toc.js',
  'injected/extract.js',
);

const STORE_KEY = 'y2e_job';

const state = {
  status: 'idle', // idle | running | assembling | done | error
  phase: '',
  current: 0,
  total: 0,
  title: '',
  message: '',
  warnings: [],
  filename: '',
  startedAt: 0,
  cancelled: false,
};

let sections = [];

function setState(patch) {
  Object.assign(state, patch);
  chrome.runtime.sendMessage({ type: 'y2e:state', state }).catch(() => {});
}

function warn(msg) {
  state.warnings.push(msg);
  console.warn('[yuzu2epub]', msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A 20 minute job outlives the 30s idle timeout on its own, but only while
// messages keep flowing. The alarm covers the quiet stretches.
function startKeepAlive() {
  chrome.alarms.create('y2e-keepalive', { periodInMinutes: 0.4 });
}
function stopKeepAlive() {
  chrome.alarms.clear('y2e-keepalive');
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'y2e-keepalive') {
    // Touching an extension API is enough to reset the idle timer.
    chrome.runtime.getPlatformInfo(() => {});
  }
});

// ---------------------------------------------------------------------------
// Offscreen document: owns image bytes, zip assembly and the download.
// ---------------------------------------------------------------------------
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Fetch book images and assemble the EPUB file for download.',
  });
}

async function closeOffscreen() {
  try {
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existing.length) await chrome.offscreen.closeDocument();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Injection helpers
// ---------------------------------------------------------------------------
async function runInTop(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func,
    args,
  });
  return res && res.result;
}

/**
 * Run the extractor in every frame and keep the best-scoring result. Frames
 * that hold reader chrome rather than book content score zero and are ignored.
 */
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
// Main job
// ---------------------------------------------------------------------------
async function runJob(tabId) {
  sections = [];
  setState({
    status: 'running',
    phase: 'Reading table of contents',
    current: 0,
    total: 0,
    warnings: [],
    message: '',
    filename: '',
    startedAt: Date.now(),
    cancelled: false,
  });
  startKeepAlive();

  const toc = await runInTop(tabId, yuzuReadToc);
  if (!toc || toc.error) {
    throw new Error((toc && toc.error) || 'Could not read the table of contents.');
  }
  if (!toc.entries || !toc.entries.length) {
    throw new Error('The table of contents is empty.');
  }

  setState({
    title: toc.title,
    total: toc.entries.length,
    phase: `Extracting ${toc.entries.length} sections`,
  });

  for (let i = 0; i < toc.entries.length; i++) {
    if (state.cancelled) throw new Error('Cancelled.');
    const entry = toc.entries[i];
    setState({
      current: i + 1,
      phase: `Section ${i + 1} of ${toc.entries.length}: ${entry.title}`,
    });

    const nav = await runInTop(tabId, yuzuGotoSection, [entry.uuid]);
    if (!nav || nav.error) {
      warn(`Could not open "${entry.title}": ${(nav && nav.error) || 'unknown error'}`);
      continue;
    }
    // Give the content frame a beat to swap documents before we look at it.
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
  }

  if (!sections.length) throw new Error('Nothing could be extracted from this book.');

  // Every section-start page from the TOC that the content itself did not
  // mark, so the page-list still has an entry for it.
  for (const s of sections) {
    if (!s.pages.length && s.page) {
      s.pages = [{ id: 'y2e-page-start', label: s.page, synthetic: true }];
      s.body = s.body.replace(
        /^(<div[^>]*class="y2e-section"[^>]*>)/,
        `$1<span class="y2e-pagebreak" id="y2e-page-start" epub:type="pagebreak" role="doc-pagebreak" title="${s.page}"></span>`,
      );
    }
  }

  setState({ status: 'assembling', phase: 'Fetching images and building the EPUB' });

  const job = {
    meta: {
      title: toc.title,
      authors: toc.authors && toc.authors.length ? toc.authors : [],
      language: toc.language || 'en',
      isbn: toc.isbn || '',
      coverUrl: toc.isbn ? `https://covers.vitalsource.com/vbid/${toc.isbn}/width/1400` : '',
    },
    sections,
  };
  await chrome.storage.local.set({ [STORE_KEY]: job });

  await ensureOffscreen();
  const result = await chrome.runtime.sendMessage({ type: 'y2e:assemble', key: STORE_KEY });
  if (!result || !result.ok) {
    throw new Error((result && result.error) || 'Assembly failed.');
  }

  for (const w of result.warnings || []) warn(w);
  await chrome.storage.local.remove(STORE_KEY);
  await closeOffscreen();
  stopKeepAlive();

  setState({
    status: 'done',
    phase: 'Done',
    filename: result.filename,
    message:
      `${sections.length} sections, ${result.imageCount} images, ` +
      `${(result.bytes / 1048576).toFixed(1)} MB`,
  });
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'y2e:getState') {
    sendResponse({ state });
    return false;
  }
  if (msg && msg.type === 'y2e:cancel') {
    state.cancelled = true;
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'y2e:progress') {
    // Relayed from the offscreen document during image fetching.
    setState({ phase: msg.phase });
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'y2e:start') {
    if (state.status === 'running' || state.status === 'assembling') {
      sendResponse({ ok: false, error: 'A job is already running.' });
      return false;
    }
    runJob(msg.tabId)
      .catch(async (err) => {
        stopKeepAlive();
        await closeOffscreen();
        setState({ status: 'error', phase: 'Failed', message: err.message });
      });
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
