/**
 * The reading stylesheet embedded in every generated EPUB.
 *
 * Written for e-ink textbook reading. Yuzu's own publisher CSS is discarded
 * during extraction: it is built for a paginated web viewer, carries fixed
 * pixel widths and absolute positioning, and renders badly on a Kindle.
 *
 * Rules of thumb encoded here:
 *  - Hyphenation off. Kindle's hyphenator mangles technical vocabulary.
 *  - No fixed widths anywhere, so tables and figures can reflow.
 *  - Avoid page breaks inside figures, tables and headings.
 *  - Neutral greys only. Colour is invisible on e-ink and muddy on tablets.
 */
const EPUB_STYLESHEET = `@charset "utf-8";

html {
  -webkit-hyphens: none;
  hyphens: none;
}

body {
  margin: 0 5%;
  line-height: 1.45;
  text-align: left;
  word-spacing: normal;
  hyphens: none;
  -webkit-hyphens: none;
  -moz-hyphens: none;
  -ms-hyphens: none;
  -epub-hyphens: none;
  adobe-hyphenate: none;
}

h1, h2, h3, h4, h5, h6 {
  line-height: 1.2;
  hyphens: none;
  -webkit-hyphens: none;
  page-break-after: avoid;
  break-after: avoid;
  font-weight: bold;
}
h1 { font-size: 1.6em; margin: 1em 0 0.7em; }
h2 { font-size: 1.35em; margin: 1.3em 0 0.5em; }
h3 { font-size: 1.15em; margin: 1.1em 0 0.4em; }
h4, h5, h6 { font-size: 1em; margin: 1em 0 0.3em; }

/* Part and chapter title pages. */
.y2e-part-title, .y2e-chapter-title {
  page-break-before: always;
  break-before: page;
}

p { margin: 0 0 0.7em; orphans: 2; widows: 2; text-indent: 0; }
a { color: inherit; text-decoration: underline; }

img {
  max-width: 100%;
  height: auto;
}

figure {
  margin: 1.2em 0;
  text-align: center;
  page-break-inside: avoid;
  break-inside: avoid;
}
figcaption {
  font-size: 0.85em;
  font-style: italic;
  margin-top: 0.4em;
  text-align: left;
}

/* Textbooks lean on boxed features heavily. Render them as quiet callouts
   rather than trying to reproduce the publisher's colour treatment. */
.y2e-box {
  border: 1px solid #999;
  padding: 0.7em 0.9em;
  margin: 1.2em 0;
  page-break-inside: avoid;
  break-inside: avoid;
}
.y2e-box > :first-child { margin-top: 0; }
.y2e-box > :last-child { margin-bottom: 0; }

blockquote {
  margin: 1em 0 1em 1em;
  padding-left: 0.8em;
  border-left: 3px solid #999;
}

table {
  border-collapse: collapse;
  margin: 1.2em 0;
  font-size: 0.85em;
  page-break-inside: avoid;
  break-inside: avoid;
}
th, td {
  border: 1px solid #999;
  padding: 0.35em 0.5em;
  text-align: left;
  vertical-align: top;
}
th { font-weight: bold; }
caption {
  font-size: 0.85em;
  font-style: italic;
  margin-bottom: 0.3em;
  text-align: left;
}

pre {
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-wrap: break-word;
  font-size: 0.85em;
  line-height: 1.35;
  margin: 1em 0;
}
code { font-family: monospace; }

hr { border: none; border-top: 1px solid #999; margin: 1.5em 0; }
ul, ol { margin: 0 0 0.7em 1.3em; padding: 0; }
li { margin: 0 0 0.3em; }

sup, sub { font-size: 0.75em; line-height: 0; }

/* Print page markers. Invisible, but they drive the page-list so that
   "go to page" on the Kindle matches the printed edition. */
.y2e-pagebreak {
  display: none;
}

math { font-size: 1em; }
.y2e-math-img { vertical-align: middle; max-width: 100%; }
.y2e-math-block { text-align: center; margin: 1em 0; page-break-inside: avoid; }

/* Marks content the extractor could not resolve, so problems are visible
   in the finished book instead of silently missing. */
.y2e-missing {
  color: #777;
  font-style: italic;
  font-size: 0.85em;
}
`;

self.YuzuStylesheet = EPUB_STYLESHEET;
