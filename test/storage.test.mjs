/**
 * Exercises the checkpoint layer in background.js against a fake
 * chrome.storage.local.
 *
 * The previous version rewrote the entire job on every checkpoint. At 741
 * sections that is quadratic: roughly 250 writes of a blob growing to tens of
 * megabytes. This asserts each checkpoint touches one batch plus a header, and
 * that a resume reads every section back in order.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const ext = path.resolve(import.meta.dirname, '..', 'extension');

const store = new Map();
let writes = 0;
let bytesWritten = 0;

const chrome = {
  storage: {
    local: {
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) {
          writes++;
          bytesWritten += JSON.stringify(v).length;
          store.set(k, JSON.parse(JSON.stringify(v)));
        }
      },
      async get(keys) {
        if (keys === null) return Object.fromEntries(store);
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      async remove(keys) {
        for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k);
      },
    },
  },
  alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
  runtime: { sendMessage: async () => {}, onMessage: { addListener() {} }, getPlatformInfo() {} },
  downloads: { onChanged: { addListener() {}, removeListener() {} } },
  tabs: {}, scripting: {}, offscreen: {},
};

const ctx = {
  self: {}, console, chrome, setTimeout, clearTimeout, Date, Math, JSON, Object, Array,
  String, Number, Promise, Map, Set, RegExp, Error, URL, TextEncoder, TextDecoder,
  Response, CompressionStream, Blob, DataView, Uint8Array, ArrayBuffer, crypto, caches: {},
  importScripts(...files) {
    for (const f of files) {
      vm.runInContext(fs.readFileSync(path.join(ext, f), 'utf8'), ctx, { filename: f });
    }
  },
};
ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ext, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });

let fail = 0;
const check = (n, c, d) => {
  console.log(`  ${c ? 'ok   ' : 'FAIL '} ${n}${c ? '' : '  <- ' + d}`);
  if (!c) fail++;
};

console.log('=== checkpoint storage ===');

const ISBN = '9790000000001';
const BATCH = vm.runInContext('BATCH_SIZE', ctx);
check('batch size is sane', BATCH >= 10 && BATCH <= 100, `${BATCH}`);

// Simulate a 741 section run checkpointing every 3 sections.
const sections = [];
const sectionBody = 'x'.repeat(4000);
vm.runInContext('globalThis.__save = async (isbn, sections, nextIndex, complete, total) => {' +
  'const lastBatch = Math.max(0, Math.ceil(sections.length / BATCH_SIZE) - 1);' +
  'await saveBatch(isbn, lastBatch, sections);' +
  'await saveHeader(isbn, { meta: {title:"T"}, entries: [], nextIndex, complete, count: sections.length, total });' +
  '};', ctx);

for (let i = 0; i < 741; i++) {
  sections.push({ id: `sec-${i}`, body: sectionBody, title: `S${i}` });
  if ((i + 1) % 3 === 0) await ctx.__save(ISBN, sections, i + 1, false, 741);
}
for (let b = 0; b * BATCH < sections.length; b++) {
  await vm.runInContext('saveBatch', ctx)(ISBN, b, sections);
}
await ctx.__save(ISBN, sections, 741, true, 741);

const naiveBytes = 741 / 3 * 741 * sectionBody.length; // what the old design would move
console.log(`  info  ${writes} writes, ${(bytesWritten / 1048576).toFixed(1)} MB moved`);
console.log(`  info  whole-blob checkpointing would have moved ~${(naiveBytes / 1073741824).toFixed(1)} GB`);
check('checkpoint traffic stays under 100 MB', bytesWritten < 100 * 1048576,
  `${(bytesWritten / 1048576).toFixed(1)} MB`);

const loaded = await vm.runInContext('loadJob', ctx)(ISBN);
check('every section reads back', loaded.sections.length === 741, `got ${loaded.sections.length}`);
check('sections read back in order',
  loaded.sections.every((s, i) => s.id === `sec-${i}`), 'order scrambled');
check('header survives', loaded.complete === true && loaded.total === 741, JSON.stringify({c: loaded.complete, t: loaded.total}));
check('not reported torn', !loaded.torn, 'torn flag set on a complete job');

// A missing batch must be detected rather than silently producing a book with holes.
store.delete(`y2e_sec_${ISBN}_5`);
const torn = await vm.runInContext('loadJob', ctx)(ISBN);
check('missing batch flagged as torn', torn.torn === true, 'torn not detected');

await vm.runInContext('clearJob', ctx)(ISBN);
const leftovers = [...store.keys()].filter((k) => k.includes(ISBN));
check('clearJob removes every key', leftovers.length === 0, `left: ${leftovers.slice(0,3).join(', ')}`);

console.log(fail ? `\n  ${fail} failed` : '\n  all storage checks passed');
process.exit(fail ? 1 : 0);
