/**
 * offscreen.js - fetches image bytes, assembles the EPUB, starts the download.
 *
 * This lives outside the service worker for one reason: MV3 service workers
 * have no URL.createObjectURL, so they cannot hand a Blob to chrome.downloads.
 * Keeping every byte on this side also avoids serialising binary data across
 * the messaging boundary, which only carries JSON.
 */

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', tif: 'image/tiff',
  tiff: 'image/tiff',
};

function extOf(url) {
  try {
    const p = new URL(url, location.href).pathname;
    const m = p.match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : '';
  } catch (_) {
    return '';
  }
}

function mediaTypeFor(url, contentType) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (ct.startsWith('image/')) return ct === 'image/jpg' ? 'image/jpeg' : ct;
  return MIME_BY_EXT[extOf(url)] || 'image/jpeg';
}

function extForMedia(m) {
  switch (m) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'image/svg+xml': return 'svg';
    default: return 'img';
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fetchBytes(url) {
  const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (!buf.byteLength) throw new Error('empty response');
  return { data: new Uint8Array(buf), contentType: res.headers.get('content-type') };
}

function progress(phase) {
  chrome.runtime.sendMessage({ type: 'y2e:progress', phase }).catch(() => {});
}

async function assemble(key) {
  const store = await chrome.storage.local.get(key);
  const job = store[key];
  if (!job) throw new Error('Job data missing.');

  const warnings = [];
  const { meta, sections } = job;

  // ── image assets, deduplicated across the whole book ──────────────────
  const byUrl = new Map(); // url -> {id, href, mediaType, data}
  const failed = new Set();
  const allUrls = [];
  for (const s of sections) {
    for (const img of s.images || []) {
      if (!allUrls.includes(img.url)) allUrls.push(img.url);
    }
  }

  let done = 0;
  const CONCURRENCY = 6;
  let cursor = 0;
  async function worker() {
    while (cursor < allUrls.length) {
      const url = allUrls[cursor++];
      try {
        const { data, contentType } = await fetchBytes(url);
        const mediaType = mediaTypeFor(url, contentType);
        const n = String(byUrl.size + 1).padStart(4, '0');
        byUrl.set(url, {
          id: `img-${n}`,
          href: `images/img-${n}.${extForMedia(mediaType)}`,
          mediaType,
          data,
        });
      } catch (err) {
        failed.add(url);
        warnings.push(`Image failed (${err.message}): ${url.slice(0, 110)}`);
      }
      done++;
      if (done % 10 === 0 || done === allUrls.length) {
        progress(`Fetching images: ${done} of ${allUrls.length}`);
      }
    }
  }
  progress(`Fetching images: 0 of ${allUrls.length}`);
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, allUrls.length) }, worker));

  // ── rewrite the per-section placeholder tokens to in-EPUB paths ────────
  for (const s of sections) {
    for (const img of s.images || []) {
      const asset = byUrl.get(img.url);
      const tok = escapeRe(img.token);
      if (asset) {
        // Section files live in text/, images in images/.
        s.body = s.body.replace(new RegExp(tok, 'g'), `../${asset.href}`);
      } else {
        // Drop the <img> entirely rather than ship a dangling reference.
        s.body = s.body
          .replace(new RegExp(`<img[^>]*src="${tok}"[^>]*/>`, 'g'),
                   '<span class="y2e-missing">[image unavailable]</span>')
          .replace(new RegExp(`<img[^>]*src="${tok}"[^>]*>`, 'g'),
                   '<span class="y2e-missing">[image unavailable]</span>');
      }
    }
    delete s.images;
  }

  // ── cover ─────────────────────────────────────────────────────────────
  let cover = null;
  if (meta.coverUrl) {
    progress('Fetching cover art');
    try {
      const { data, contentType } = await fetchBytes(meta.coverUrl);
      cover = { data, mediaType: mediaTypeFor(meta.coverUrl, contentType) };
    } catch (err) {
      warnings.push(`Cover art unavailable: ${err.message}`);
    }
  }

  // ── build ─────────────────────────────────────────────────────────────
  progress('Compressing EPUB');
  const images = Array.from(byUrl.values());
  const blob = await self.YuzuEpub.buildEpub({
    title: meta.title || 'Untitled',
    authors: meta.authors || [],
    language: meta.language || 'en',
    isbn: meta.isbn || '',
    publisher: '',
    sections,
    images,
    cover,
  });

  const filename = `${self.YuzuXml.slugify(meta.title || 'yuzu-book')}.epub`;
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename, saveAs: true });
  // The download reads from the blob URL asynchronously; revoking immediately
  // can truncate it on slower disks.
  setTimeout(() => URL.revokeObjectURL(url), 120000);

  return {
    ok: true,
    filename,
    bytes: blob.size,
    imageCount: images.length,
    failedImages: failed.size,
    warnings,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'y2e:assemble') return false;
  assemble(msg.key)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // async response
});
