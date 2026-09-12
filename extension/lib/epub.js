/**
 * epub.js - assemble an EPUB 3 package in memory.
 *
 * Derived in part from md2kindle (MIT), extended with:
 *   - a nested navigation tree, so Parts contain their Chapters in both
 *     nav.xhtml and toc.ncx instead of one flat list;
 *   - an EPUB page-list built from the printed page markers found in the
 *     source, so "go to page" on a Kindle matches the print edition;
 *   - Yuzu-specific metadata (ISBN as the package identifier).
 *
 * See ../../NOTICE for license notices.
 */

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

function extForMedia(mediaType) {
  switch (mediaType) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'image/svg+xml': return 'svg';
    default: return 'img';
  }
}

/**
 * Turn the flat, depth-annotated section list into a tree.
 * A section with depth N becomes a child of the most recent section of
 * depth N-1. Anything orphaned stays at the top level.
 */
function buildTree(sections) {
  const roots = [];
  const lastAtDepth = [];
  for (const s of sections) {
    const node = { section: s, children: [] };
    const d = Math.max(0, s.depth | 0);
    if (d === 0 || !lastAtDepth[d - 1]) {
      roots.push(node);
      lastAtDepth[0] = node;
      lastAtDepth.length = 1;
    } else {
      lastAtDepth[d - 1].children.push(node);
      lastAtDepth[d] = node;
      lastAtDepth.length = d + 1;
    }
  }
  return roots;
}

function navList(nodes, indent, esc) {
  const pad = '  '.repeat(indent);
  let out = `${pad}<ol>\n`;
  for (const n of nodes) {
    const s = n.section;
    out += `${pad}  <li><a href="${s.filename}">${esc(s.title)}</a>`;
    if (n.children.length) {
      out += '\n' + navList(n.children, indent + 2, esc) + `${pad}  `;
    }
    out += '</li>\n';
  }
  out += `${pad}</ol>\n`;
  return out;
}

function navDoc(lang, tree, pageList, esc, hasCover) {
  const first = tree[0] ? tree[0].section.filename : 'text/section-0001.xhtml';
  let pages = '';
  if (pageList.length) {
    pages =
      '  <nav epub:type="page-list" hidden="hidden">\n    <ol>\n' +
      pageList
        .map((p) => `      <li><a href="${p.href}">${esc(p.label)}</a></li>`)
        .join('\n') +
      '\n    </ol>\n  </nav>\n';
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(lang)}" lang="${esc(lang)}">
<head>
  <meta charset="utf-8"/>
  <title>Contents</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
${navList(tree, 2, esc)}  </nav>
${pages}  <nav epub:type="landmarks" hidden="hidden">
    <ol>
${hasCover ? '      <li><a epub:type="cover" href="cover.xhtml">Cover</a></li>\n' : ''}      <li><a epub:type="toc" href="nav.xhtml">Table of Contents</a></li>
      <li><a epub:type="bodymatter" href="${first}">Begin Reading</a></li>
    </ol>
  </nav>
</body>
</html>`;
}

function ncxPoints(nodes, counter, esc) {
  let out = '';
  for (const n of nodes) {
    const i = ++counter.n;
    const s = n.section;
    out += `    <navPoint id="np-${i}" playOrder="${i}">
      <navLabel><text>${esc(s.title)}</text></navLabel>
      <content src="${s.filename}"/>
`;
    if (n.children.length) out += ncxPoints(n.children, counter, esc);
    out += '    </navPoint>\n';
  }
  return out;
}

function treeDepth(nodes, d = 1) {
  let max = d;
  for (const n of nodes) {
    if (n.children.length) max = Math.max(max, treeDepth(n.children, d + 1));
  }
  return max;
}

function ncxDoc(lang, uuid, title, tree, esc) {
  const depth = treeDepth(tree);
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${esc(lang)}">
  <head>
    <meta name="dtb:uid" content="${esc(uuid)}"/>
    <meta name="dtb:depth" content="${depth}"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${esc(title)}</text></docTitle>
  <navMap>
${ncxPoints(tree, { n: 0 }, esc)}  </navMap>
</ncx>`;
}

function sectionDoc(lang, title, body, esc) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:m="http://www.w3.org/1998/Math/MathML" xml:lang="${esc(lang)}" lang="${esc(lang)}">
<head>
  <meta charset="utf-8"/>
  <title>${esc(title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${body}
</body>
</html>`;
}

function coverDoc(lang, coverHref, esc) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(lang)}">
<head>
  <meta charset="utf-8"/>
  <title>Cover</title>
  <style>html,body{margin:0;padding:0;height:100%;text-align:center;}img{max-width:100%;max-height:100%;}</style>
</head>
<body epub:type="cover">
  <div><img src="${coverHref}" alt="Cover"/></div>
</body>
</html>`;
}

function opfDoc(p, uuid, hasCover, coverHref, coverMediaType, esc, timestamp) {
  const manifest = [
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '    <item id="css" href="style.css" media-type="text/css"/>',
  ];
  if (hasCover) {
    manifest.push(
      `    <item id="cover-image" href="${coverHref}" media-type="${coverMediaType}" properties="cover-image"/>`,
      '    <item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>',
    );
  }
  for (const s of p.sections) {
    // EPUB 3 requires a content document to declare the foreign vocabularies
    // it uses. Kindle's ingester rejects books that use SVG or MathML without
    // saying so here.
    const declared = [];
    if (s.hasMathML) declared.push('mathml');
    if (s.hasSvg) declared.push('svg');
    const props = declared.length ? ` properties="${declared.join(' ')}"` : '';
    manifest.push(
      `    <item id="${s.id}" href="${s.filename}" media-type="application/xhtml+xml"${props}/>`,
    );
  }
  for (const a of p.images) {
    manifest.push(`    <item id="${a.id}" href="${a.href}" media-type="${a.mediaType}"/>`);
  }

  const spine = [];
  if (hasCover) spine.push('    <itemref idref="cover-page" linear="yes"/>');
  // The nav document belongs in the reading order. EPUB 3 permits it outside
  // the spine, but Kindle's "Go to -> Table of Contents" is unreliable when
  // the TOC is not a real page in the book.
  spine.push('    <itemref idref="nav" linear="yes"/>');
  for (const s of p.sections) spine.push(`    <itemref idref="${s.id}"/>`);

  const creators = (p.authors && p.authors.length ? p.authors : ['Unknown'])
    .map((a, i) => `    <dc:creator id="creator-${i + 1}">${esc(a)}</dc:creator>`)
    .join('\n');

  const isbnMeta = p.isbn
    ? `\n    <dc:identifier id="isbn">urn:isbn:${esc(p.isbn)}</dc:identifier>`
    : '';
  const coverMeta = hasCover ? '\n    <meta name="cover" content="cover-image"/>' : '';

  // Deprecated in EPUB 3 but still what Kindle's older ingestion path and KDP
  // read to find the TOC and cover.
  const guide = [];
  if (hasCover) {
    guide.push('    <reference type="cover" title="Cover" href="cover.xhtml"/>');
  }
  guide.push('    <reference type="toc" title="Table of Contents" href="nav.xhtml"/>');
  if (p.sections.length) {
    guide.push(`    <reference type="text" title="Begin Reading" href="${p.sections[0].filename}"/>`);
  }
  const publisher = p.publisher ? `\n    <dc:publisher>${esc(p.publisher)}</dc:publisher>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${esc(p.language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${esc(uuid)}</dc:identifier>${isbnMeta}
    <dc:title>${esc(p.title)}</dc:title>
${creators}
    <dc:language>${esc(p.language)}</dc:language>${publisher}
    <meta property="dcterms:modified">${timestamp}</meta>${coverMeta}
  </metadata>
  <manifest>
${manifest.join('\n')}
  </manifest>
  <spine toc="ncx">
${spine.join('\n')}
  </spine>
  <guide>
${guide.join('\n')}
  </guide>
</package>`;
}

/**
 * @param {object} p
 * @param {string} p.title
 * @param {string[]} p.authors
 * @param {string} p.language  BCP-47, e.g. "en"
 * @param {string} [p.isbn]
 * @param {string} [p.publisher]
 * @param {Array} p.sections  {id, title, filename, body, depth, hasMathML, pages[]}
 * @param {Array} p.images    {id, href, mediaType, data}
 * @param {{data: Uint8Array, mediaType: string}|null} [p.cover]
 * @returns {Promise<Blob>}
 */
async function buildEpub(p) {
  const { xmlEscape: esc, epubTimestamp, uuidv4 } = self.YuzuXml;
  const uuid = `urn:uuid:${uuidv4()}`;
  const hasCover = !!(p.cover && p.cover.data && p.cover.data.length);
  const coverMediaType = (p.cover && p.cover.mediaType) || 'image/jpeg';
  const coverHref = `cover.${extForMedia(coverMediaType)}`;

  const tree = buildTree(p.sections);

  // Flatten every printed page marker the extractor found, in reading order.
  const pageList = [];
  for (const s of p.sections) {
    for (const pg of s.pages || []) {
      pageList.push({ label: pg.label, href: `${s.filename}#${pg.id}` });
    }
  }

  const entries = [
    // Per OCF, "mimetype" must be the first entry and stored uncompressed.
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: CONTAINER_XML },
    {
      name: 'OEBPS/content.opf',
      data: opfDoc(p, uuid, hasCover, coverHref, coverMediaType, esc, epubTimestamp()),
    },
    { name: 'OEBPS/nav.xhtml', data: navDoc(p.language, tree, pageList, esc, hasCover) },
    { name: 'OEBPS/toc.ncx', data: ncxDoc(p.language, uuid, p.title, tree, esc) },
    { name: 'OEBPS/style.css', data: self.YuzuStylesheet },
  ];

  if (hasCover) {
    entries.push({ name: 'OEBPS/cover.xhtml', data: coverDoc(p.language, coverHref, esc) });
    entries.push({ name: `OEBPS/${coverHref}`, data: p.cover.data, store: true });
  }

  for (const s of p.sections) {
    entries.push({
      name: `OEBPS/${s.filename}`,
      data: sectionDoc(p.language, s.title, s.body, esc),
    });
  }
  // Images are already compressed formats; deflating them again just burns CPU.
  for (const a of p.images) {
    entries.push({ name: `OEBPS/${a.href}`, data: a.data, store: a.mediaType !== 'image/svg+xml' });
  }

  return self.YuzuZip.buildZip(entries, 'application/epub+zip');
}

self.YuzuEpub = { buildEpub, buildTree, treeDepth, extForMedia };
