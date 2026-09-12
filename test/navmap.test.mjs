/**
 * Navigation entries are not spine documents.
 *
 * One tested book has 658 TOC entries pointing at anchors inside just 31
 * chapter files, averaging 21 entries per document. The extractor assumed one
 * entry meant one document, navigated 658 times, and stored the same chapter
 * over and over: the counter climbed while the same page repeated.
 *
 * This asserts the two lists stay independent, so the spine holds one item per
 * document while the TOC keeps every entry, anchored into it.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import zlib from 'node:zlib';

const ext = path.resolve(import.meta.dirname, '..', 'extension');
const ctx = {
  self: {}, console, TextEncoder, TextDecoder, Response, CompressionStream,
  Blob, DataView, Uint8Array, ArrayBuffer, Date, Math, crypto, JSON, String, Array, Object, Number,
};
vm.createContext(ctx);
for (const f of ['zip.js', 'xml.js', 'stylesheet.js', 'epub.js']) {
  vm.runInContext(fs.readFileSync(path.join(ext, 'lib', f), 'utf8'), ctx, { filename: f });
}

// Three documents, ten TOC entries. Chapter 1 holds five of them.
const sections = [1, 2, 3].map((n) => {
  const id = String(n).padStart(4, '0');
  return {
    id: `sec-${id}`,
    filename: `text/section-${id}.xhtml`,
    title: `Chapter ${n}`,
    depth: 0,
    pages: [],
    body: `<div class="y2e-section"><h1>Chapter ${n}</h1>`
      + [1, 2, 3, 4, 5].map((k) => `<h2 id="s${n}_${k}">Subsection ${n}.${k}</h2><p>Placeholder.</p>`).join('')
      + `</div>`,
  };
});

const nav = [
  { title: 'Chapter 1', depth: 0, href: 'text/section-0001.xhtml' },
  { title: 'Subsection 1.1', depth: 1, href: 'text/section-0001.xhtml#s1_1' },
  { title: 'Subsection 1.2', depth: 1, href: 'text/section-0001.xhtml#s1_2' },
  { title: 'Subsection 1.3', depth: 1, href: 'text/section-0001.xhtml#s1_3' },
  { title: 'Chapter 2', depth: 0, href: 'text/section-0002.xhtml' },
  { title: 'Subsection 2.1', depth: 1, href: 'text/section-0002.xhtml#s2_1' },
  { title: 'Subsection 2.2', depth: 1, href: 'text/section-0002.xhtml#s2_2' },
  { title: 'Chapter 3', depth: 0, href: 'text/section-0003.xhtml' },
  { title: 'Subsection 3.1', depth: 1, href: 'text/section-0003.xhtml#s3_1' },
  { title: 'Subsection 3.2', depth: 1, href: 'text/section-0003.xhtml#s3_2' },
];

const blob = await ctx.self.YuzuEpub.buildEpub({
  title: 'Nav Map Fixture', authors: ['A. Author'], language: 'en',
  isbn: '9790000000002', sections, nav, images: [], cover: null,
});
const out = path.resolve(import.meta.dirname, 'navmap.epub');
fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));

// Read entries straight out of the archive.
const buf = fs.readFileSync(out);
function readEntry(name) {
  const target = Buffer.from(name);
  let at = 0;
  while ((at = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), at)) !== -1) {
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    const nm = buf.slice(at + 30, at + 30 + nameLen);
    const comp = buf.readUInt16LE(at + 8);
    const csize = buf.readUInt32LE(at + 18);
    const start = at + 30 + nameLen + extraLen;
    if (nm.equals(target)) {
      const raw = buf.slice(start, start + csize);
      return (comp === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
    }
    at = start + csize;
  }
  return null;
}

let fail = 0;
const check = (n, c, d) => {
  console.log(`  ${c ? 'ok   ' : 'FAIL '} ${n}${c ? '' : '  <- ' + d}`);
  if (!c) fail++;
};
console.log('=== nav entries vs spine documents ===');

const navXhtml = readEntry('OEBPS/nav.xhtml');
const opf = readEntry('OEBPS/content.opf');
const ncx = readEntry('OEBPS/toc.ncx');

const navLinks = (navXhtml.match(/<a href="text\/section-[^"]*"/g) || []).length;
check('every TOC entry appears in the nav', navLinks === 10, `got ${navLinks}`);

const fragLinks = (navXhtml.match(/href="text\/section-\d+\.xhtml#s\d_\d"/g) || []).length;
check('anchors into a shared document are preserved', fragLinks === 7, `got ${fragLinks}`);

const spine = (opf.match(/<itemref /g) || []).length;
// three documents plus the nav document itself
check('spine holds one item per document, not per entry', spine === 4, `got ${spine}`);

const xhtmlItems = (opf.match(/media-type="application\/xhtml\+xml"/g) || []).length;
check('manifest holds one file per document', xhtmlItems === 4, `got ${xhtmlItems}`);

const navPoints = (ncx.match(/<navPoint /g) || []).length;
check('ncx mirrors the entries', navPoints === 10, `got ${navPoints}`);

// Count lists inside the toc nav only; landmarks has its own <ol>.
const tocNav = navXhtml.slice(navXhtml.indexOf('epub:type="toc"'), navXhtml.indexOf('epub:type="landmarks"'));
const nestedLists = (tocNav.match(/<ol>/g) || []).length;
check('subsections nest under their chapter', nestedLists === 4,
  `${nestedLists} lists in the toc nav (1 top level + 1 per chapter)`);

console.log(fail ? `\n  ${fail} failed` : '\n  all nav map checks passed');
process.exit(fail ? 1 : 0);
