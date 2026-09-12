#!/usr/bin/env python3
"""Generate the project's header artwork.

One set of components, three layouts:
  header.png         1280x640  README banner, text beside the graphic
  social-preview.png 1280x640  GitHub social preview, centred and larger type
  twitter-card.png   1600x900  16:9 for an in-post image

All artwork here is original geometry: scattered source fragments resolving
into one bound book whose table of contents is visibly nested.

    python3 docs/make-header.py
"""
import cairosvg

INK = "#0d0f16"
PAPER = "#f6f2e9"
ACCENT = "#f2c14e"
MUTED = "#6e7689"
BODY = "#b9bfcd"
CHIP_BG = "#171b26"
CHIP_LINE = "#2b3243"
MONO = "DejaVu Sans Mono, monospace"
SANS = "Liberation Sans, DejaVu Sans, sans-serif"

# The graphic is drawn in a local 467x366 box, then translated and scaled.
GW, GH = 467, 366

DEFS = f"""
  <defs>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="{ACCENT}" stop-opacity="0.15"/>
      <stop offset="55%" stop-color="{ACCENT}" stop-opacity="0.05"/>
      <stop offset="100%" stop-color="{ACCENT}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="paper" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fcf9f2"/>
      <stop offset="100%" stop-color="#e9e3d4"/>
    </linearGradient>
    <g id="frag">
      <rect width="86" height="114" rx="5" fill="{CHIP_BG}" stroke="{CHIP_LINE}" stroke-width="1.5"/>
      <rect x="13" y="19" width="56" height="4" rx="2" fill="#39415a"/>
      <rect x="13" y="33" width="62" height="4" rx="2" fill="#333b52"/>
      <rect x="13" y="47" width="42" height="4" rx="2" fill="#2e3549"/>
      <rect x="13" y="68" width="60" height="4" rx="2" fill="#2c3348"/>
      <rect x="13" y="82" width="36" height="4" rx="2" fill="#262d40"/>
    </g>
    <g id="chev">
      <path d="M0,-11 L11,0 L0,11" fill="none" stroke="{ACCENT}" stroke-width="3.5"
            stroke-linecap="round" stroke-linejoin="round"/>
    </g>
  </defs>"""


def graphic(tx, ty, scale=1.0):
    """Fragments, chevrons and the assembled book, in one transformable group."""
    bx, by = 262, 33          # book origin inside the local box
    return f"""
  <g transform="translate({tx},{ty}) scale({scale})">
    <use href="#frag" transform="translate(0,0) rotate(-10,43,57)"/>
    <use href="#frag" transform="translate(62,58) rotate(5,43,57)"/>
    <use href="#frag" transform="translate(4,124) rotate(-3,43,57)"/>
    <use href="#frag" transform="translate(60,184) rotate(8,43,57)"/>
    <use href="#frag" transform="translate(6,252) rotate(-6,43,57)"/>

    <g transform="translate(0,183)">
      <use href="#chev" transform="translate(180,0)" opacity="0.3"/>
      <use href="#chev" transform="translate(203,0)" opacity="0.62"/>
      <use href="#chev" transform="translate(226,0)"/>
    </g>

    <rect x="{bx}" y="{by}" width="205" height="300" rx="7" fill="url(#paper)"/>
    <rect x="{bx}" y="{by}" width="14" height="300" rx="7" fill="{ACCENT}"/>
    <rect x="{bx + 9}" y="{by}" width="6" height="300" fill="{ACCENT}"/>

    <rect x="{bx + 32}" y="{by + 40}"  width="120" height="8" rx="4" fill="#262b38"/>
    <rect x="{bx + 48}" y="{by + 63}"  width="88"  height="5" rx="2.5" fill="#6f7486"/>
    <rect x="{bx + 62}" y="{by + 79}"  width="68"  height="4" rx="2" fill="#a3a7b4"/>
    <rect x="{bx + 62}" y="{by + 93}"  width="56"  height="4" rx="2" fill="#a3a7b4"/>
    <rect x="{bx + 32}" y="{by + 120}" width="132" height="8" rx="4" fill="#262b38"/>
    <rect x="{bx + 48}" y="{by + 143}" width="74"  height="5" rx="2.5" fill="#6f7486"/>
    <rect x="{bx + 62}" y="{by + 159}" width="62"  height="4" rx="2" fill="#a3a7b4"/>
    <rect x="{bx + 32}" y="{by + 186}" width="108" height="8" rx="4" fill="#262b38"/>
    <rect x="{bx + 48}" y="{by + 209}" width="92"  height="5" rx="2.5" fill="#6f7486"/>
    <rect x="{bx + 62}" y="{by + 225}" width="54"  height="4" rx="2" fill="#a3a7b4"/>
    <rect x="{bx + 62}" y="{by + 239}" width="70"  height="4" rx="2" fill="#a3a7b4"/>
    <text x="{bx + 32}" y="{by + 276}" font-family="{MONO}" font-size="15"
          letter-spacing="3" fill="#9a9384">EPUB</text>
  </g>"""


def chips(labels, x, y, fs=15, gap=12):
    """Pill row. Text is centred on each pill rather than left-padded."""
    out, cx = [], x
    for label in labels:
        w = round(len(label) * fs * 0.52) + 48
        h = round(fs * 2.4)
        out.append(
            f'    <rect x="{cx}" y="{y}" width="{w}" height="{h}" rx="{h/2}" '
            f'fill="{CHIP_BG}" stroke="{CHIP_LINE}"/>\n'
            f'    <text x="{cx + w/2}" y="{y + h/2}" text-anchor="middle" '
            f'dominant-baseline="central" font-family="{SANS}" font-size="{fs}" '
            f'fill="#cbd1dd">{label}</text>'
        )
        cx += w + gap
    return "\n".join(out), cx - gap - x


CHIPS = ["nested TOC", "images + cover", "print page-list", "no build step"]


def banner(w=1280, h=640):
    rows, _ = chips(CHIPS, 72, 412)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
{DEFS}
  <rect width="{w}" height="{h}" fill="{INK}"/>
  <circle cx="1100" cy="322" r="255" fill="url(#glow)"/>
{graphic(738, 168, 1.0)}
  <text x="72" y="142" font-family="{MONO}" font-size="17" letter-spacing="4.5"
        fill="{MUTED}">CHROME EXTENSION · MANIFEST V3</text>
  <text x="72" y="240" font-family="{MONO}" font-size="88" font-weight="bold"
        fill="{PAPER}">yuzu2epub</text>
  <rect x="72" y="268" width="96" height="5" rx="2.5" fill="{ACCENT}"/>
  <text x="72" y="330" font-family="{SANS}" font-size="25" fill="{BODY}">One button. A textbook you own becomes a single,</text>
  <text x="72" y="364" font-family="{SANS}" font-size="25" fill="{BODY}">Kindle-ready EPUB with a table of contents that works.</text>
{rows}
  <text x="72" y="524" font-family="{MONO}" font-size="18" fill="#98a1b4">github.com/mjshiggins/yuzu2epub</text>
  <text x="72" y="552" font-family="{MONO}" font-size="15" fill="#5c6474">MIT · load unpacked · for books you have paid for</text>
</svg>"""


def social(w=1280, h=640):
    """GitHub social preview. Shown small in link unfurls, so this drops the
    detail that disappears at that size and leans on bigger type. Centring the
    graphic instead left dead space down both sides, so it keeps the two-column
    composition."""
    gx, gy = w - 80 - GW, (h - GH) / 2
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
{DEFS}
  <rect width="{w}" height="{h}" fill="{INK}"/>
  <circle cx="{gx + GW * 0.72}" cy="{h/2}" r="270" fill="url(#glow)"/>
{graphic(gx, gy, 1.0)}
  <text x="80" y="170" font-family="{MONO}" font-size="18" letter-spacing="5"
        fill="{MUTED}">CHROME EXTENSION · MANIFEST V3</text>
  <text x="80" y="280" font-family="{MONO}" font-size="96" font-weight="bold"
        fill="{PAPER}">yuzu2epub</text>
  <rect x="80" y="312" width="110" height="6" rx="3" fill="{ACCENT}"/>
  <text x="80" y="374" font-family="{SANS}" font-size="28" fill="{BODY}">A textbook you own, as one</text>
  <text x="80" y="414" font-family="{SANS}" font-size="28" fill="{BODY}">Kindle-ready EPUB.</text>
  <text x="80" y="492" font-family="{MONO}" font-size="19" fill="#98a1b4">github.com/mjshiggins/yuzu2epub</text>
</svg>"""


def twitter(w=1600, h=900):
    """16:9 for an in-post image, which is the ratio the timeline crops to."""
    fs = 18
    rows, _ = chips(CHIPS, 90, 542, fs=fs, gap=14)
    scale = 1.12
    gx = w - 90 - GW * scale
    gy = (h - GH * scale) / 2
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
{DEFS}
  <rect width="{w}" height="{h}" fill="{INK}"/>
  <circle cx="{gx + GW * scale * 0.72}" cy="{h/2}" r="320" fill="url(#glow)"/>
{graphic(gx, gy, scale)}
  <text x="90" y="230" font-family="{MONO}" font-size="21" letter-spacing="5.5"
        fill="{MUTED}">CHROME EXTENSION · MANIFEST V3</text>
  <text x="90" y="350" font-family="{MONO}" font-size="112" font-weight="bold"
        fill="{PAPER}">yuzu2epub</text>
  <rect x="90" y="386" width="120" height="6" rx="3" fill="{ACCENT}"/>
  <text x="90" y="454" font-family="{SANS}" font-size="31" fill="{BODY}">One button. A textbook you own becomes a</text>
  <text x="90" y="496" font-family="{SANS}" font-size="31" fill="{BODY}">single, Kindle-ready EPUB.</text>
{rows}
  <text x="90" y="650" font-family="{MONO}" font-size="23" fill="#98a1b4">github.com/mjshiggins/yuzu2epub</text>
  <text x="90" y="684" font-family="{MONO}" font-size="18" fill="#5c6474">MIT · load unpacked · for books you have paid for</text>
</svg>"""


TARGETS = [
    ("header", banner(), 1280, 640, True),
    ("social-preview", social(), 1280, 640, False),
    ("twitter-card", twitter(), 1600, 900, False),
]

if __name__ == "__main__":
    import os
    here = os.path.dirname(os.path.abspath(__file__))
    for name, svg, w, h, retina in TARGETS:
        svg_path = os.path.join(here, f"{name}.svg")
        with open(svg_path, "w", encoding="utf-8") as fh:
            fh.write(svg)
        cairosvg.svg2png(url=svg_path, write_to=os.path.join(here, f"{name}.png"),
                         output_width=w, output_height=h)
        if retina:
            cairosvg.svg2png(url=svg_path, write_to=os.path.join(here, f"{name}@2x.png"),
                             output_width=w * 2, output_height=h * 2)
        print(f"{name}: {w}x{h}")
