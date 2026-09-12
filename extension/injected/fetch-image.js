/**
 * fetch-image.js - injected into the reader's frames.
 *
 * Serialised by chrome.scripting and run in the page, so it must be fully
 * self-contained and must not touch chrome.* APIs. FileReader is used here
 * deliberately: this runs in a document, not in the service worker.
 */

/**
 * Injected into the reader's frames as a fallback. Some asset hosts refuse a
 * request whose Origin is the extension; fetching from inside the frame that
 * already displayed the image is same-origin and carries the right headers.
 */
function yuzuFetchImageInPage(url) {
  return fetch(url, { credentials: 'include' })
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status))))
    .then((b) => new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve({ ok: true, dataUrl: fr.result, type: b.type });
      fr.onerror = () => reject(new Error('read failed'));
      fr.readAsDataURL(b);
    }))
    .catch((e) => ({ ok: false, error: e.message }));
}
