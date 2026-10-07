#!/usr/bin/env python3
"""
ARENA COMMAND — BRAND GEOMETRY GENERATOR (single source of truth)
===============================================================
Emits every logo asset as SVG plus PNG previews from one shape model.

HARD RULES enforced by construction:
  - NO circles, NO ellipses, NO arcs, NO bezier/quadratic curves, NO rounded corners.
    Only rectangles, straight polylines, and filled grid blocks.
  - NO capital letter "K" glyph exists in the stroke alphabet; wordmarks cannot contain K.
  - Collapsed sidebar mark artboard  = 64u wide  (renders 48-64px in a collapsed sidebar)
  - Expanded sidebar lockup artboard = 240u wide (renders 220-260px in an expanded sidebar)
  - 8u design grid, 1u hairline strokes, 0u corner radius, 12u symbol-to-text gap.

Shape model: ("rect", x, y, w, h, mode, color, dash) | ("poly", [pts], stroke, color, dash)
  mode: "fill" | "stroke"
Run:  python3 tools/brand_gen.py
"""
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRAND = os.path.join(ROOT, "design", "brand")
PREV = os.path.join(BRAND, "previews")

# ---------------------------------------------------------------- tokens
BG        = "#0A0B0D"
GRID_DIM  = "#1A2228"
LABEL_DIM = "#6B7280"
WHITE_DIM = "#C9D1D9"

ACCENT = {
    "content":  "#3DD6F5",   # electric cyan   (core / canonical)
    "sales":    "#5C8FD6",   # blue steel
    "support":  "#34D399",   # green pulse
    "product":  "#A78BFA",   # purple node
    "finance":  "#F5C842",   # gold signal
    "research": "#E85DC8",   # magenta trace
    "recon":    "#F97316",   # signal orange   (derived vertical)
}
WARN    = "#EF4444"
NEUTRAL = "#6B7280"

WORDMARK = {
    "content":  "CONTENT COMMAND",
    "sales":    "SALES COMMAND",
    "support":  "SUPPORT COMMAND",
    "product":  "PRODUCT COMMAND",
    "finance":  "FINANCE COMMAND",
    "research": "RESEARCH COMMAND",
    "recon":    "RECON COMMAND",
}

# ---------------------------------------------------------------- stroke alphabet
# Monoline angular glyphs on an 8u x 16u cell (x:0..8, y:0..16). Straight segments only.
# There is intentionally NO "K" glyph. Punctuation/space have no geometry.
def _g(*polys):
    return list(polys)

GLYPH = {
    "A": _g([(0.5, 15.5), (4.0, 0.5), (7.5, 15.5)], [(1.9, 9.5), (6.1, 9.5)]),
    "B": _g([(0.5, 0.5), (6.5, 0.5), (7.5, 1.5), (7.5, 6.5), (6.5, 7.5), (0.5, 7.5)],
            [(6.5, 7.5), (7.5, 8.5), (7.5, 14.5), (6.5, 15.5), (0.5, 15.5), (0.5, 0.5)],
            [(0.5, 7.5), (6.5, 7.5)]),
    "C": _g([(7.5, 0.5), (0.5, 0.5), (0.5, 15.5), (7.5, 15.5)]),
    "D": _g([(0.5, 15.5), (0.5, 0.5), (4.5, 0.5), (7.5, 3.5), (7.5, 12.5), (4.5, 15.5), (0.5, 15.5)]),
    "E": _g([(7.5, 0.5), (0.5, 0.5), (0.5, 15.5), (7.5, 15.5)], [(0.5, 8.0), (6.5, 8.0)]),
    "F": _g([(7.5, 0.5), (0.5, 0.5), (0.5, 15.5)], [(0.5, 8.0), (6.5, 8.0)]),
    "G": _g([(7.5, 0.5), (0.5, 0.5), (0.5, 15.5), (7.5, 15.5), (7.5, 8.5), (4.0, 8.5)]),
    "H": _g([(0.5, 0.5), (0.5, 15.5)], [(7.5, 0.5), (7.5, 15.5)], [(0.5, 8.0), (7.5, 8.0)]),
    "I": _g([(0.5, 0.5), (7.5, 0.5)], [(4.0, 0.5), (4.0, 15.5)], [(0.5, 15.5), (7.5, 15.5)]),
    "J": _g([(7.5, 0.5), (7.5, 12.5), (5.5, 15.5), (0.5, 15.5), (0.5, 12.5)]),
    "L": _g([(0.5, 0.5), (0.5, 15.5), (7.5, 15.5)]),
    "M": _g([(0.5, 15.5), (0.5, 0.5), (4.0, 8.5), (7.5, 0.5), (7.5, 15.5)]),
    "N": _g([(0.5, 15.5), (0.5, 0.5), (7.5, 15.5), (7.5, 0.5)]),
    "O": _g([(0.5, 0.5), (7.5, 0.5), (7.5, 15.5), (0.5, 15.5), (0.5, 0.5)]),
    "P": _g([(0.5, 15.5), (0.5, 0.5), (7.5, 0.5), (7.5, 7.5), (0.5, 7.5)]),
    "Q": _g([(0.5, 0.5), (7.5, 0.5), (7.5, 15.5), (0.5, 15.5), (0.5, 0.5)], [(4.5, 10.5), (7.5, 15.5)]),
    "R": _g([(0.5, 15.5), (0.5, 0.5), (7.5, 0.5), (7.5, 7.5), (0.5, 7.5)], [(3.8, 7.5), (7.5, 15.5)]),
    "S": _g([(7.5, 0.5), (0.5, 0.5), (0.5, 7.5), (7.5, 7.5), (7.5, 15.5), (0.5, 15.5)]),
    "T": _g([(0.5, 0.5), (7.5, 0.5)], [(4.0, 0.5), (4.0, 15.5)]),
    "U": _g([(0.5, 0.5), (0.5, 15.5), (7.5, 15.5), (7.5, 0.5)]),
    "V": _g([(0.5, 0.5), (4.0, 15.5), (7.5, 0.5)]),
    "W": _g([(0.5, 0.5), (2.0, 15.5), (4.0, 6.5), (6.0, 15.5), (7.5, 0.5)]),
    "X": _g([(0.5, 0.5), (7.5, 15.5)], [(7.5, 0.5), (0.5, 15.5)]),
    "Y": _g([(0.5, 0.5), (4.0, 8.0), (7.5, 0.5)], [(4.0, 8.0), (4.0, 15.5)]),
    "Z": _g([(0.5, 0.5), (7.5, 0.5), (0.5, 15.5), (7.5, 15.5)]),
    "0": _g([(0.5, 0.5), (7.5, 0.5), (7.5, 15.5), (0.5, 15.5), (0.5, 0.5)], [(1.5, 14.0), (6.5, 2.0)]),
    "1": _g([(1.5, 3.0), (4.0, 0.5), (4.0, 15.5)], [(0.5, 15.5), (7.5, 15.5)]),
    "2": _g([(0.5, 0.5), (7.5, 0.5), (7.5, 7.5), (0.5, 7.5), (0.5, 15.5), (7.5, 15.5)]),
    "3": _g([(0.5, 0.5), (7.5, 0.5), (7.5, 15.5), (0.5, 15.5)], [(3.0, 8.0), (7.5, 8.0)]),
    "4": _g([(0.5, 0.5), (0.5, 8.0), (7.5, 8.0)], [(6.0, 0.5), (6.0, 15.5)]),
    "5": _g([(7.5, 0.5), (0.5, 0.5), (0.5, 7.5), (7.5, 7.5), (7.5, 15.5), (0.5, 15.5)]),
    "6": _g([(7.5, 0.5), (0.5, 0.5), (0.5, 15.5), (7.5, 15.5), (7.5, 7.5), (0.5, 7.5)]),
    "7": _g([(0.5, 0.5), (7.5, 0.5), (3.0, 15.5)]),
    "8": _g([(0.5, 0.5), (7.5, 0.5), (7.5, 15.5), (0.5, 15.5), (0.5, 0.5)], [(0.5, 7.5), (7.5, 7.5)]),
    "9": _g([(7.5, 8.0), (0.5, 8.0), (0.5, 0.5), (7.5, 0.5), (7.5, 15.5), (0.5, 15.5)]),
    "-": _g([(1.0, 8.0), (7.0, 8.0)]),
    "/": _g([(7.0, 0.5), (1.0, 15.5)]),
    ".": _g([(3.5, 14.5), (4.5, 14.5), (4.5, 15.5), (3.5, 15.5), (3.5, 14.5)]),
    ":": _g([(3.5, 3.5), (4.5, 3.5), (4.5, 4.5), (3.5, 4.5), (3.5, 3.5)],
            [(3.5, 11.5), (4.5, 11.5), (4.5, 12.5), (3.5, 12.5), (3.5, 11.5)]),
    " ": _g(),
}
GLYPH_W, GLYPH_H = 8.0, 16.0
PITCH, WORD_GAP = 10.0, 8.0    # tight tracking: 2u letter gap, 8u word advance (6u visual gap)


def wordmark_shapes(text, x, y, color, scale=1.0, stroke=1.0):
    """Return shape list for `text` with glyph-box top-left at (x, y)."""
    shapes, cx = [], x
    for ch in text.upper():
        if ch == "K":
            raise ValueError("FORBIDDEN: capital K is not allowed in any wordmark")
        if ch == " ":
            cx += WORD_GAP * scale
            continue
        if ch not in GLYPH:
            raise ValueError(f"Undefined glyph: {ch!r}")
        for poly in GLYPH[ch]:
            pts = [(cx + px * scale, y + py * scale) for px, py in poly]
            shapes.append(("poly", pts, stroke, color, None))
        cx += PITCH * scale
    return shapes


def wordmark_width(text, scale=1.0):
    if not text:
        return 0.0
    w = 0.0
    for ch in text:
        w += (WORD_GAP if ch == " " else PITCH) * scale
    return w - (PITCH - GLYPH_W) * scale


# ---------------------------------------------------------------- shared mark geometry
def mark_shapes(vkey, color, dense=False):
    """Core 64u mark: shared base (3 signal bars + command line + cursor) + vertical motif."""
    s = []
    # shared base — three ascending signal bars (filled grid blocks), sitting on the command line
    s += [
        ("rect", 8,  44, 8,  8, "fill", color, None),
        ("rect", 20, 36, 8, 16, "fill", color, None),
        ("rect", 32, 28, 8, 24, "fill", color, None),
        ("rect", 8,  52, 48, 2, "fill", color, None),   # command line (prompt base)
    ]
    if not dense:
        s.append(("rect", 52, 44, 4, 8, "fill", color, None))  # command cursor block
    if dense:
        return s  # dense mode: signal lines only
    s += MOTIF[vkey](color)
    return s


def _m_content(c):
    return [("poly", [(8, 18), (16, 8), (24, 18), (32, 8), (40, 18), (48, 8), (56, 18)], 1, c, None)]


def _m_sales(c):
    return [
        ("poly", [(8, 12), (56, 12)], 1, c, None),                       # pipeline spine
        ("rect", 8,  9, 6, 6, "fill", c, None),                          # stage nodes
        ("rect", 29, 9, 6, 6, "fill", c, None),
        ("rect", 50, 9, 6, 6, "fill", c, None),                          # deal node
        ("rect", 54, 5, 2, 14, "fill", c, None),                         # beam
    ]


def _m_support(c):
    return [
        ("rect", 8.5, 5.5, 22, 6, "stroke", c, None),                    # ticket layers
        ("rect", 8.5, 13.5, 22, 6, "stroke", c, None),
        ("poly", [(38, 13), (45, 20), (56, 6)], 1, c, None),             # resolution mark
    ]


def _m_product(c):
    return [
        ("poly", [(5, 20), (11, 17), (29, 11), (47, 14), (57, 10)], 1, c, None),  # journey line
        ("rect", 8,  14, 6, 6, "fill", c, None),                        # feature modules
        ("rect", 26, 8,  6, 6, "fill", c, None),
        ("rect", 44, 11, 6, 6, "fill", c, None),
    ]


def _m_finance(c):
    return [
        ("rect", 8,  14, 5, 8,  "fill", c, None),                        # metric bars
        ("rect", 17, 10, 5, 12, "fill", c, None),
        ("rect", 26, 12, 5, 10, "fill", c, None),
        ("rect", 35, 6,  5, 16, "fill", c, None),
        ("poly", [(6, 12.5), (58, 12.5)], 1, c, "3 2"),                  # threshold line
    ]


def _m_research(c):
    return [
        ("rect", 8.5, 5.5, 12, 15, "stroke", c, None),                   # document modules
        ("rect", 15.5, 9.5, 12, 15, "stroke", c, None),
        ("poly", [(36, 23), (56, 6)], 1, c, None),                       # search beam
        ("poly", [(39, 23), (56, 13)], 1, c, None),
    ]


def _m_recon(c):
    return [
        ("poly", [(8, 13), (8, 6), (15, 6)], 1, c, None),                # capture frame
        ("poly", [(49, 6), (56, 6), (56, 13)], 1, c, None),
        ("poly", [(56, 15), (56, 22), (49, 22)], 1, c, None),
        ("poly", [(15, 22), (8, 22), (8, 15)], 1, c, None),
        ("poly", [(8, 14), (56, 14)], 1, c, "3 2"),                      # scan line
        ("rect", 30, 12, 4, 4, "fill", c, None),                         # scan cursor
    ]


MOTIF = {
    "content": _m_content, "sales": _m_sales, "support": _m_support,
    "product": _m_product, "finance": _m_finance, "research": _m_research,
    "recon": _m_recon,
}


def lockup_shapes(vkey, color, w=240, h=64):
    """Expanded-sidebar lockup: 64u mark + 12u gap + wordmark, left-aligned on 240u artboard."""
    s = [(sh[0], sh[1], sh[2], sh[3], sh[4], sh[5]) if False else sh for sh in mark_shapes(vkey, color)]
    text = WORDMARK[vkey]
    assert "K" not in text
    s += wordmark_shapes(text, 64 + 12, (h - GLYPH_H) / 2, color)
    return s


# ---------------------------------------------------------------- module (nav) icons 16u
def module_icon(name):
    c = WHITE_DIM
    if name == "dashboard":   # signal overview
        return [("rect", 2, 9, 2, 4, "fill", c, None), ("rect", 6, 6, 2, 7, "fill", c, None),
                ("rect", 10, 3, 2, 10, "fill", c, None), ("rect", 2, 14, 12, 1, "fill", c, None)]
    if name == "library":     # content library rows
        return [("rect", 2.5, 2.5, 11, 3, "stroke", c, None), ("rect", 2.5, 7.5, 11, 3, "stroke", c, None),
                ("rect", 2.5, 12.5, 8, 3, "stroke", c, None)]
    if name == "radar":       # competitor triangulation (3 nodes + links)
        return [("poly", [(8, 3), (13.5, 13), (2.5, 13), (8, 3)], 1, c, None),
                ("rect", 6.5, 2, 3, 3, "fill", c, None),
                ("rect", 1, 11.5, 3, 3, "fill", c, None),
                ("rect", 12, 11.5, 3, 3, "fill", c, None),
                ("rect", 6.5, 8.5, 3, 3, "fill", c, None)]
    if name == "scorer":      # idea scorer steps
        return [("rect", 2, 11, 3, 3, "fill", c, None), ("rect", 6, 8, 3, 6, "fill", c, None),
                ("rect", 10, 4, 3, 10, "fill", c, None), ("poly", [(2, 4), (6, 4)], 1, c, "2 2")]
    if name == "brief":       # brief generator
        return [("rect", 3.5, 1.5, 9, 13, "stroke", c, None),
                ("poly", [(5.5, 5), (10.5, 5)], 1, c, None), ("poly", [(5.5, 8), (10.5, 8)], 1, c, None),
                ("poly", [(5.5, 11), (8.5, 11)], 1, c, None)]
    if name == "agent":       # intelligence agent node graph
        return [("poly", [(4.5, 4.5), (7.5, 7.5)], 1, c, None),
                ("poly", [(11.5, 4.5), (8.5, 7.5)], 1, c, None),
                ("poly", [(4.5, 11.5), (7.5, 8.5)], 1, c, None),
                ("rect", 2, 2, 3, 3, "fill", c, None), ("rect", 11, 2, 3, 3, "fill", c, None),
                ("rect", 2, 11, 3, 3, "fill", c, None), ("rect", 6.5, 6.5, 3, 3, "fill", c, None)]
    raise KeyError(name)


# ---------------------------------------------------------------- sheets
def construction_sheet():
    """Anatomy sheet: 2x mark with 8u grid, callouts, hairline legend. Artboard 336x168."""
    W, H, SC = 336, 168, 2
    s = []
    ox, oy = 16, 20
    # 8u grid over mark area
    for gx in range(0, 65, 8):
        s.append(("poly", [(ox + gx * SC, oy), (ox + gx * SC, oy + 64 * SC)], 1, GRID_DIM, None))
    for gy in range(0, 65, 8):
        s.append(("poly", [(ox, oy + gy * SC), (ox + 64 * SC, oy + gy * SC)], 1, GRID_DIM, None))
    s.append(("rect", ox, oy, 64 * SC, 64 * SC, "stroke", GRID_DIM, None))
    for sh in mark_shapes("content", ACCENT["content"]):
        s.append(_scale_shape(sh, SC, ox, oy))
    # callouts
    def label(txt, x, y, col=LABEL_DIM):
        return wordmark_shapes(txt, x, y, col, scale=0.5, stroke=1)
    s += label("64 ARTBOARD", 16, 4)
    s += label("GRID 8U", 200, 4)
    lines = [
        ("MOTIF ZONE", 200, 36), ("SIGNAL BARS", 200, 60), ("COMMAND LINE", 200, 84),
        ("CURSOR", 200, 108), ("HAIRLINE 1U", 200, 132), ("12U GAP TEXT", 200, 150),
    ]
    for txt, x, y in lines:
        s += label(txt, x, y)
    for y in (40, 64, 88, 112):
        s.append(("poly", [(176, y - 4), (196, y - 4)], 1, GRID_DIM, None))
    return W, H, s, "construction-sheet"


def state_sheet():
    """Three system states of the core mark. Artboard 240x64 (row of three 64u marks)."""
    s = []
    for i, (key, col) in enumerate((("ACTIVE", ACCENT["content"]), ("WARN", WARN), ("NEUTRAL", NEUTRAL))):
        for sh in mark_shapes("content", col):
            s.append(_shift_shape(sh, i * 88, 0))
    return 240, 64, s, "mark-states"


def vertical_template_sheet():
    """2x3 grid: six standard verticals (icon + wordmark), shared grid, accent rail."""
    W, H = 520, 336
    s = []
    keys = ["content", "sales", "support", "product", "finance", "research"]
    for i, k in enumerate(keys):
        col_i, row_i = i % 2, i // 2
        x0, y0 = 8 + col_i * 256, 8 + row_i * 108
        s.append(("rect", x0, y0, 248, 96, "stroke", GRID_DIM, None))
        s.append(("rect", x0, y0, 3, 96, "fill", ACCENT[k], None))       # accent rail
        for sh in lockup_shapes(k, ACCENT[k]):
            s.append(_scale_shape(sh, 0.75, x0 + 14, y0 + 22))
    return W, H, s, "vertical-template"


def module_sheet():
    """Sidebar module glyph sheet: six 16u nav glyphs, 2x scale."""
    s, W, H = [], 264, 72
    names = ["dashboard", "library", "radar", "scorer", "brief", "agent"]
    for i, n in enumerate(names):
        x0, y0 = 16 + i * 40, 20
        s.append(("rect", x0, y0, 32, 32, "stroke", GRID_DIM, None))
        for sh in module_icon(n):
            s.append(_scale_shape(sh, 2, x0, y0))
    return W, H, s, "module-icons"


def _scale_shape(sh, k, dx=0.0, dy=0.0):
    if sh[0] == "rect":
        _, x, y, w, h, m, c, d = sh
        return ("rect", x * k + dx, y * k + dy, w * k, h * k, m, c, d)
    _, pts, sw, c, d = sh
    return ("poly", [(x * k + dx, y * k + dy) for x, y in pts], max(sw * k, 1.0), c, d)


def _shift_shape(sh, dx, dy):
    return _scale_shape(sh, 1.0, dx, dy)


# ---------------------------------------------------------------- SVG emitter
def svg_doc(w, h, shapes, title, bg=BG, data_text=None):
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">',
           f'<title>{title}</title>',
           f'<rect x="0" y="0" width="{w}" height="{h}" fill="{bg}"/>']
    if data_text:
        out.append(f'<g data-text="{data_text}">')
    for sh in shapes:
        if sh[0] == "rect":
            _, x, y, bw, bh, m, c, d = sh
            if m == "fill":
                out.append(f'<rect x="{_n(x)}" y="{_n(y)}" width="{_n(bw)}" height="{_n(bh)}" fill="{c}"/>')
            else:
                dash = f' stroke-dasharray="{d}"' if d else ""
                out.append(f'<rect x="{_n(x)}" y="{_n(y)}" width="{_n(bw)}" height="{_n(bh)}" fill="none" '
                           f'stroke="{c}" stroke-width="1"{dash}/>')
        else:
            _, pts, sw, c, d = sh
            p = " ".join(f"{_n(x)},{_n(y)}" for x, y in pts)
            dash = f' stroke-dasharray="{d}"' if d else ""
            out.append(f'<polyline points="{p}" fill="none" stroke="{c}" stroke-width="{_n(sw)}"{dash}/>')
    if data_text:
        out.append("</g>")
    out.append("</svg>")
    return "\n".join(out) + "\n"


def _n(v):
    return f"{v:.2f}".rstrip("0").rstrip(".") if isinstance(v, float) else str(v)


# ---------------------------------------------------------------- PNG preview rasterizer
class Raster:
    def __init__(self, w, h, scale, bg):
        self.s, self.w, self.h = scale, w * scale, h * scale
        self.px = bytearray(self.w * self.h * 3)
        self._fill(0, 0, self.w, self.h, bg)

    def _rgb(self, hx):
        return tuple(int(hx[i:i + 2], 16) for i in (1, 3, 5))

    def _fill(self, x0, y0, x1, y1, hx):
        r, g, b = self._rgb(hx)
        x0, y0 = max(int(x0), 0), max(int(y0), 0)
        x1, y1 = min(int(x1), self.w), min(int(y1), self.h)
        row = bytes([r, g, b]) * max(x1 - x0, 0)
        for y in range(y0, y1):
            i = (y * self.w + x0) * 3
            self.px[i:i + len(row)] = row

    def rect(self, x, y, w, h, mode, hx, dash=None):
        S = self.s
        if mode == "fill":
            self._fill(x * S, y * S, (x + w) * S, (y + h) * S, hx)
        else:
            t = max(int(round(S)), 1)
            self.poly([(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)], t, hx, dash)

    def poly(self, pts, sw, hx, dash=None):
        S = self.s
        t = max(int(round(sw * S)), 1)
        P = [(x * S, y * S) for x, y in pts]
        segs = [(P[i], P[i + 1]) for i in range(len(P) - 1)]
        if dash:
            da, db = (float(v) for v in dash.split())
            segs = []
            for a, b in Pairs(P):
                segs += dashed_segments(a, b, da * S, db * S)
        for a, b in segs:
            self._stamp_line(a, b, t, hx)

    def _stamp_line(self, a, b, t, hx):
        import math
        x0, y0 = a
        x1, y1 = b
        dist = math.hypot(x1 - x0, y1 - y0)
        steps = max(int(dist / 0.4), 1)
        half = t / 2.0
        for i in range(steps + 1):
            u = i / steps
            cx, cy = x0 + (x1 - x0) * u, y0 + (y1 - y0) * u
            self._fill(cx - half, cy - half, cx + half + 0.999, cy + half + 0.999, hx)

    def save(self, path):
        raw = b"".join(b"\x00" + self.px[y * self.w * 3:(y + 1) * self.w * 3] for y in range(self.h))
        def chunk(tag, data):
            return (struct.pack(">I", len(data)) + tag + data
                    + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
        png = (b"\x89PNG\r\n\x1a\n"
               + chunk(b"IHDR", struct.pack(">IIBBBBB", self.w, self.h, 8, 2, 0, 0, 0))
               + chunk(b"IDAT", zlib.compress(raw, 9))
               + chunk(b"IEND", b""))
        with open(path, "wb") as f:
            f.write(png)


def Pairs(P):
    return [(P[i], P[i + 1]) for i in range(len(P) - 1)]


def dashed_segments(a, b, da, db):
    import math
    (x0, y0), (x1, y1) = a, b
    dist = math.hypot(x1 - x0, y1 - y0)
    if dist == 0:
        return []
    ux, uy = (x1 - x0) / dist, (y1 - y0) / dist
    out, pos, on = [], 0.0, True
    while pos < dist:
        step = da if on else db
        end = min(pos + step, dist)
        if on:
            out.append(((x0 + ux * pos, y0 + uy * pos), (x0 + ux * end, y0 + uy * end)))
        pos, on = end, not on
    return out


def rasterize(w, h, shapes, path, scale=4):
    R = Raster(w, h, scale, BG)
    for sh in shapes:
        if sh[0] == "rect":
            R.rect(*sh[1:])
        else:
            _, pts, sw, c, d = sh
            R.poly(pts, sw, c, d)
    R.save(path)


# ---------------------------------------------------------------- emit all
def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content)
    print("wrote", os.path.relpath(path, ROOT))


def main():
    os.makedirs(PREV, exist_ok=True)
    jobs = []  # (svg_path, png_path, w, h, shapes, title, data_text, scale)

    def add(rel, w, h, shapes, title, data_text=None, scale=4):
        jobs.append((os.path.join(BRAND, rel), os.path.join(PREV, os.path.basename(rel) + ".png"),
                     w, h, shapes, title, data_text, scale))

    # core (canonical content vertical)
    add("core/mark-collapsed.svg", 64, 64, mark_shapes("content", ACCENT["content"]),
        "mark-collapsed", WORDMARK["content"])
    add("core/mark-collapsed-dense.svg", 64, 64, mark_shapes("content", ACCENT["content"], dense=True),
        "mark-collapsed-dense", WORDMARK["content"])
    add("core/lockup-expanded.svg", 240, 64, lockup_shapes("content", ACCENT["content"]),
        "lockup-expanded", WORDMARK["content"], scale=3)
    add("core/mark-states.svg", *state_sheet()[:3], "mark-states", None, scale=3)

    # verticals
    for k in ["sales", "support", "product", "finance", "research", "recon"]:
        add(f"verticals/icon-{k}.svg", 64, 64, mark_shapes(k, ACCENT[k]), f"icon-{k}", WORDMARK[k])
        add(f"verticals/lockup-{k}.svg", 240, 64, lockup_shapes(k, ACCENT[k]), f"lockup-{k}", WORDMARK[k], scale=3)

    # sheets
    w, h, sh, name = construction_sheet()
    add(f"templates/{name}.svg", w, h, sh, name, None, scale=3)
    w, h, sh, name = vertical_template_sheet()
    add(f"templates/{name}.svg", w, h, sh, name, None, scale=2)
    w, h, sh, name = module_sheet()
    add(f"templates/{name}.svg", w, h, sh, name, None, scale=3)

    for svg_path, png_path, w, h, shapes, title, data_text, scale in jobs:
        write(svg_path, svg_doc(w, h, shapes, title, data_text=data_text))
        rasterize(w, h, shapes, png_path, scale=scale)
    print(f"\n{len(jobs)} assets generated.")


if __name__ == "__main__":
    main()
