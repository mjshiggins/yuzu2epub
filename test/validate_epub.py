#!/usr/bin/env python3
"""Structural validator for the EPUBs this extension produces.

Checks the things that actually break Kindle ingestion, in order of how often
they bite: OCF layout, XML well-formedness, manifest/spine/nav agreement, and
dangling internal references. Not a substitute for epubcheck, but it runs
anywhere and catches the realistic failure modes.
"""
import sys, zipfile, posixpath
from xml.etree import ElementTree as ET

NS = {
    'opf':  'http://www.idpf.org/2007/opf',
    'dc':   'http://purl.org/dc/elements/1.1/',
    'xhtml':'http://www.w3.org/1999/xhtml',
    'epub': 'http://www.idpf.org/2007/ops',
    'ncx':  'http://www.daisy.org/z3986/2005/ncx/',
    'ocf':  'urn:oasis:names:tc:opendocument:xmlns:container',
}

def main(path):
    errors, warnings, notes = [], [], []
    z = zipfile.ZipFile(path)

    bad = z.testzip()
    if bad:
        errors.append(f'corrupt zip entry: {bad}')

    names = z.namelist()
    infos = z.infolist()

    # --- OCF requirements -------------------------------------------------
    if not names or names[0] != 'mimetype':
        errors.append(f'"mimetype" must be the first zip entry, got {names[0] if names else "<empty>"}')
    else:
        mi = infos[0]
        if mi.compress_type != zipfile.ZIP_STORED:
            errors.append('"mimetype" must be STORED, not compressed')
        if z.read('mimetype') != b'application/epub+zip':
            errors.append('"mimetype" content is wrong')
    if 'META-INF/container.xml' not in names:
        errors.append('missing META-INF/container.xml')

    container = ET.fromstring(z.read('META-INF/container.xml'))
    rootfile = container.find('.//ocf:rootfile', NS).get('full-path')
    if rootfile not in names:
        errors.append(f'container points at missing rootfile {rootfile}')
        return report(path, errors, warnings, notes)
    base = posixpath.dirname(rootfile)

    # --- every XML document must parse ------------------------------------
    for n in names:
        if n.endswith(('.xhtml', '.opf', '.ncx', '.xml')):
            try:
                ET.fromstring(z.read(n))
            except ET.ParseError as e:
                errors.append(f'XML not well-formed: {n}: {e}')

    opf = ET.fromstring(z.read(rootfile))

    # --- metadata ---------------------------------------------------------
    md = opf.find('opf:metadata', NS)
    uid_id = opf.get('unique-identifier')
    ids = {i.get('id'): (i.text or '') for i in md.findall('dc:identifier', NS)}
    if uid_id not in ids:
        errors.append(f'unique-identifier "{uid_id}" has no matching dc:identifier')
    if md.find('dc:title', NS) is None or not (md.find('dc:title', NS).text or '').strip():
        errors.append('missing or empty dc:title')
    if md.find('dc:language', NS) is None:
        errors.append('missing dc:language')
    if not any(m.get('property') == 'dcterms:modified' for m in md.findall('opf:meta', NS)):
        errors.append('missing dcterms:modified (required by EPUB 3)')
    notes.append(f'title: {md.find("dc:title", NS).text}')
    notes.append(f'creators: {len(md.findall("dc:creator", NS))}')

    # --- manifest vs spine vs archive -------------------------------------
    manifest = {}
    for it in opf.find('opf:manifest', NS).findall('opf:item', NS):
        manifest[it.get('id')] = it
        full = posixpath.normpath(posixpath.join(base, it.get('href')))
        if full not in names:
            errors.append(f'manifest item {it.get("id")} -> {it.get("href")} not present in archive')

    manifest_files = {posixpath.normpath(posixpath.join(base, it.get('href')))
                      for it in manifest.values()}
    for n in names:
        if n in ('mimetype', 'META-INF/container.xml', rootfile):
            continue
        if n.endswith('/'):
            continue
        if n not in manifest_files:
            errors.append(f'file in archive but not in manifest: {n}')

    nav_items = [i for i in manifest.values() if 'nav' in (i.get('properties') or '').split()]
    if len(nav_items) != 1:
        errors.append(f'expected exactly one nav document, found {len(nav_items)}')

    spine = opf.find('opf:spine', NS)
    spine_ids = [r.get('idref') for r in spine.findall('opf:itemref', NS)]
    for sid in spine_ids:
        if sid not in manifest:
            errors.append(f'spine references unknown manifest id: {sid}')
    if not spine_ids:
        errors.append('spine is empty')
    toc_attr = spine.get('toc')
    if toc_attr and toc_attr not in manifest:
        errors.append(f'spine@toc references unknown id: {toc_attr}')

    # cover
    covers = [i for i in manifest.values() if 'cover-image' in (i.get('properties') or '').split()]
    if len(covers) > 1:
        errors.append('more than one cover-image')
    notes.append(f'cover: {"yes" if covers else "no"}')

    # mathml property must be declared where MathML is used
    for i in manifest.values():
        if i.get('media-type') == 'application/xhtml+xml':
            full = posixpath.normpath(posixpath.join(base, i.get('href')))
            body = z.read(full)
            has_math = b'<math' in body or b'<m:math' in body
            declared = 'mathml' in (i.get('properties') or '').split()
            if has_math and not declared:
                errors.append(f'{i.get("href")} contains MathML but lacks properties="mathml"')
            if declared and not has_math:
                warnings.append(f'{i.get("href")} declares mathml but contains none')
            has_svg = b'<svg' in body
            declared_svg = 'svg' in (i.get('properties') or '').split()
            if has_svg and not declared_svg:
                errors.append(f'{i.get("href")} contains inline SVG but lacks properties="svg"')

    # --- nav document -----------------------------------------------------
    nav_href = nav_items[0].get('href') if nav_items else None
    if nav_href:
        nav_full = posixpath.normpath(posixpath.join(base, nav_href))
        nav = ET.fromstring(z.read(nav_full))
        navs = {n.get('{%s}type' % NS['epub']): n for n in nav.iter('{%s}nav' % NS['xhtml'])}
        if 'toc' not in navs:
            errors.append('nav document has no epub:type="toc"')
        else:
            toc = navs['toc']
            # nesting depth
            def depth(el, d=0):
                subs = [depth(o, d + 1) for o in el.findall('.//{%s}ol' % NS['xhtml'])]
                return max(subs) if subs else d
            top_ol = toc.find('{%s}ol' % NS['xhtml'])
            nested = top_ol.findall('.//{%s}ol' % NS['xhtml']) if top_ol is not None else []
            links = toc.findall('.//{%s}a' % NS['xhtml'])
            notes.append(f'toc links: {len(links)}, nested sublists: {len(nested)}')
            if not nested:
                warnings.append('toc is flat: no nested Part/Chapter hierarchy found')
            for a in links:
                tgt = a.get('href', '').split('#')[0]
                if tgt:
                    full = posixpath.normpath(posixpath.join(posixpath.dirname(nav_full), tgt))
                    if full not in names:
                        errors.append(f'toc link target missing: {tgt}')
        if 'page-list' in navs:
            pl = navs['page-list'].findall('.//{%s}a' % NS['xhtml'])
            notes.append(f'page-list entries: {len(pl)}')
        else:
            notes.append('page-list: none')

    # --- ncx --------------------------------------------------------------
    if toc_attr and toc_attr in manifest:
        ncx_full = posixpath.normpath(posixpath.join(base, manifest[toc_attr].get('href')))
        ncx = ET.fromstring(z.read(ncx_full))
        pts = ncx.findall('.//ncx:navPoint', NS)
        nested_pts = ncx.findall('.//ncx:navPoint/ncx:navPoint', NS)
        notes.append(f'ncx navPoints: {len(pts)}, nested: {len(nested_pts)}')
        uid_meta = ncx.find('.//ncx:head/ncx:meta[@name="dtb:uid"]', NS)
        if uid_meta is not None and uid_meta.get('content') != ids.get(uid_id, ''):
            warnings.append('ncx dtb:uid does not match the OPF unique identifier')
        orders = [int(p.get('playOrder')) for p in pts if p.get('playOrder')]
        if orders and sorted(orders) != list(range(1, len(orders) + 1)):
            warnings.append('ncx playOrder values are not a clean 1..N sequence')

    # --- internal references from content ---------------------------------
    missing_targets = set()
    for i in manifest.values():
        if i.get('media-type') != 'application/xhtml+xml':
            continue
        full = posixpath.normpath(posixpath.join(base, i.get('href')))
        d = posixpath.dirname(full)
        try:
            doc = ET.fromstring(z.read(full))
        except ET.ParseError:
            continue
        for tag, attr in (('img', 'src'), ('a', 'href'), ('image', '{http://www.w3.org/1999/xlink}href')):
            for el in doc.iter('{%s}%s' % (NS['xhtml'], tag)):
                v = el.get(attr)
                if not v or v.startswith(('http:', 'https:', 'data:', 'mailto:')):
                    continue
                tgt = v.split('#')[0]
                if not tgt:
                    continue
                res = posixpath.normpath(posixpath.join(d, tgt))
                if res not in names:
                    missing_targets.add(f'{i.get("href")} -> {v}')
    for m in sorted(missing_targets)[:20]:
        errors.append(f'broken internal reference: {m}')
    if len(missing_targets) > 20:
        errors.append(f'...and {len(missing_targets) - 20} more broken references')

    notes.append(f'spine items: {len(spine_ids)}, manifest items: {len(manifest)}, archive files: {len(names)}')
    return report(path, errors, warnings, notes)


def report(path, errors, warnings, notes):
    print(f'=== {path} ===')
    for n in notes:
        print(f'  info    {n}')
    for w in warnings:
        print(f'  WARN    {w}')
    for e in errors:
        print(f'  ERROR   {e}')
    print(f'  {len(errors)} error(s), {len(warnings)} warning(s)')
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
