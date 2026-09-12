/**
 * Guards the API surface each execution context is actually allowed to use.
 *
 * This exists because of a real bug: offscreen.js called chrome.storage.local
 * and chrome.downloads, neither of which exists in an offscreen document. The
 * failure only showed up at the very end of a 20 minute run, as
 * "Cannot read properties of undefined (reading 'local')".
 */
import fs from 'node:fs';
import path from 'node:path';

const ext = path.resolve(import.meta.dirname, '..', 'extension');
let fail = 0;
const check = (n, c, d) => {
  console.log(`  ${c ? 'ok   ' : 'FAIL '} ${n}${c ? '' : '  <- ' + d}`);
  if (!c) fail++;
};

const namespaces = (file) => {
  const src = fs.readFileSync(path.join(ext, file), 'utf8');
  // Ignore comment lines so prose about an API is not mistaken for a call.
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  return [...new Set([...code.matchAll(/\bchrome\.([a-zA-Z]+)/g)].map((m) => m[1]))].sort();
};

console.log('=== execution context API surface ===');

// Offscreen documents get chrome.runtime and nothing else.
const off = namespaces('offscreen.js');
check('offscreen.js uses only chrome.runtime', off.every((n) => n === 'runtime'),
  `found: ${off.join(', ')}`);

// Content scripts are serialised by chrome.scripting and run in the page,
// where the chrome.* namespace is not available at all.
for (const f of ['injected/toc.js', 'injected/extract.js']) {
  const ns = namespaces(f);
  check(`${f} uses no chrome.* APIs`, ns.length === 0, `found: ${ns.join(', ')}`);
}

// chrome.scripting serialises only the named function. A top-level helper in
// the same file is invisible in the page, so an entry point that calls one
// fails at runtime with "not defined".
for (const f of ['injected/toc.js', 'injected/extract.js', 'injected/fetch-image.js']) {
  const src = fs.readFileSync(path.join(ext, f), 'utf8');
  const topLevel = [...src.matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
  for (const name of topLevel) {
    const start = src.search(new RegExp(`^(?:async\\s+)?function\\s+${name}\\b`, 'm'));
    const rest = src.slice(start);
    // Body ends where the next top-level declaration begins.
    const nextIdx = rest.slice(1).search(/^(?:async\s+)?function\s+/m);
    const body = nextIdx === -1 ? rest : rest.slice(0, nextIdx + 1);
    const siblings = topLevel.filter((n) => n !== name);
    const used = siblings.filter((n) => new RegExp(`\\b${n}\\s*\\(`).test(body));
    check(`${f}: ${name} is self-contained`, used.length === 0,
      `calls sibling(s) that will not be injected: ${used.join(', ')}`);
  }
}

// Everything the service worker touches must be declared in the manifest.
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
const granted = new Set([...manifest.permissions, 'runtime', 'action', 'i18n']);
const swNs = new Set([...namespaces('background.js'), ...namespaces('lib/assemble.js')]);
const undeclared = [...swNs].filter((n) => !granted.has(n));
check('service worker permissions all declared', undeclared.length === 0,
  `undeclared: ${undeclared.join(', ')}`);

// The popup runs as an extension page and may use anything declared.
const popupUndeclared = namespaces('popup.js').filter((n) => !granted.has(n));
check('popup permissions all declared', popupUndeclared.length === 0,
  `undeclared: ${popupUndeclared.join(', ')}`);

// Service workers have no DOM. These are the APIs that silently do not exist.
const swSrc = ['background.js', 'lib/assemble.js', 'lib/epub.js', 'lib/zip.js', 'lib/xml.js']
  .map((f) => fs.readFileSync(path.join(ext, f), 'utf8')).join('\n');
for (const api of ['URL.createObjectURL', 'new FileReader', 'document.', 'new DOMParser', 'new XMLSerializer']) {
  const hits = swSrc.split('\n').filter(
    (l) => l.includes(api) && !/^\s*(\/\/|\*|\/\*)/.test(l));
  check(`service worker avoids ${api}`, hits.length === 0, hits[0] && hits[0].trim().slice(0, 90));
}

console.log(fail ? `\n  ${fail} failed` : '\n  all context checks passed');
process.exit(fail ? 1 : 0);
