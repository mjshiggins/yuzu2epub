/**
 * offscreen.js - mints a blob: URL and nothing else.
 *
 * Offscreen documents are limited to the chrome.runtime API. No
 * chrome.storage, no chrome.downloads. They exist here solely because MV3
 * service workers have no URL.createObjectURL, so the finished EPUB has to
 * cross into a document context to get a URL that chrome.downloads can read.
 *
 * The blob itself travels through the Cache API rather than through messaging,
 * which is JSON-only and cannot carry binary.
 */

const urls = new Set();

async function mintUrl(cacheName, key) {
  const cache = await caches.open(cacheName);
  const res = await cache.match(key);
  if (!res) throw new Error('assembled file not found in cache');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  urls.add(url);
  return { ok: true, url, size: blob.size };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'y2e-offscreen') return false;

  if (msg.type === 'y2e:mintUrl') {
    mintUrl(msg.cacheName, msg.key)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'y2e:revoke') {
    for (const u of urls) URL.revokeObjectURL(u);
    urls.clear();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
