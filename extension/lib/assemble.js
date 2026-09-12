/**
 * assemble.js - image collection and EPUB assembly.
 *
 * Runs in the service worker, which has fetch, CompressionStream and full
 * chrome.* access. It does NOT run in the offscreen document: offscreen
 * documents are limited to the chrome.runtime API, with no chrome.storage and
 * no chrome.downloads. The offscreen document exists for exactly one reason,
 * which is minting a blob: URL, because service workers have no
 * URL.createObjectURL.
 */

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', tif: 'image/tiff',
  tiff: 'image/tiff',
};

function extOf(url) {
  try {
    return (new URL(url).pathname.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
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

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function fetchDirect(url) {
  const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (!buf.byteLength) throw new Error('empty response');
  return { data: new Uint8Array(buf), contentType: res.headers.get('content-type') };
}

/** Direct fetch first, then a same-origin fetch from inside the reader tab. */
async function fetchImage(url, tabId) {
  try {
    return await fetchDirect(url);
  } catch (err) {
    if (tabId == null) throw err;
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: yuzuFetchImageInPage,
      args: [url],
    });
    for (const r of results) {
      const v = r && r.result;
      if (v && v.ok && typeof v.dataUrl === 'string') {
        const comma = v.dataUrl.indexOf(',');
        const header = v.dataUrl.slice(0, comma);
        return {
          data: b64ToBytes(v.dataUrl.slice(comma + 1)),
          contentType: (header.match(/^data:([^;]+)/) || [])[1] || v.type,
        };
      }
    }
    throw err;
  }
}

/**
 * @param {object} job     {meta, sections} as produced by the driver
 * @param {number|null} tabId  reader tab, for the in-page image fallback
 * @param {(phase: string) => void} onProgress
 * @returns {Promise<{blob: Blob, filename: string, imageCount: number,
 *                    failedImages: number, warnings: string[]}>}
 */
async function assembleEpub(job, tabId, onProgress) {
  const warnings = [];
  const { meta, sections } = job;
  const report = onProgress || (() => {});

  const allUrls = [];
  for (const s of sections) {
    for (const img of s.images || []) {
      if (!allUrls.includes(img.url)) allUrls.push(img.url);
    }
  }

  const byUrl = new Map();
  const failed = new Set();
  let done = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < allUrls.length) {
      const url = allUrls[cursor++];
      try {
        const { data, contentType } = await fetchImage(url, tabId);
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
        report(`Fetching images: ${done} of ${allUrls.length}`);
      }
    }
  }

  report(`Fetching images: 0 of ${allUrls.length}`);
  await Promise.all(
    Array.from({ length: Math.min(6, allUrls.length) }, worker),
  );

  // Rewrite each section's placeholder tokens to in-EPUB paths.
  for (const s of sections) {
    for (const img of s.images || []) {
      const asset = byUrl.get(img.url);
      const tok = escapeRe(img.token);
      if (asset) {
        s.body = s.body.replace(new RegExp(tok, 'g'), `../${asset.href}`);
      } else {
        s.body = s.body
          .replace(new RegExp(`<img[^>]*src="${tok}"[^>]*/>`, 'g'),
            '<span class="y2e-missing">[image unavailable]</span>')
          .replace(new RegExp(`<img[^>]*src="${tok}"[^>]*>`, 'g'),
            '<span class="y2e-missing">[image unavailable]</span>');
      }
    }
    delete s.images;
  }

  let cover = null;
  if (meta.coverUrl) {
    report('Fetching cover art');
    try {
      const { data, contentType } = await fetchImage(meta.coverUrl, tabId);
      cover = { data, mediaType: mediaTypeFor(meta.coverUrl, contentType) };
    } catch (err) {
      warnings.push(`Cover art unavailable: ${err.message}`);
    }
  }

  report('Compressing EPUB');
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

  return {
    blob,
    filename: `${self.YuzuXml.slugify(meta.title || 'yuzu-book')}.epub`,
    imageCount: images.length,
    failedImages: failed.size,
    warnings,
  };
}

self.YuzuAssemble = { assembleEpub };
