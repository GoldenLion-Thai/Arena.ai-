# ARENA COMMAND — LOGO SYSTEM
### Top-left sidebar brand system · vertical-adaptive · terminal-grade
Version 1.0 · 2026-09-23 · Assets: `design/brand/` · Generator: `tools/brand_gen.py` · Lint: `tools/brand_lint.py`

---

## 1. HARD RULES (non-negotiable)

| Rule | Requirement | Enforcement |
|---|---|---|
| Shape | **Nothing round or oval.** No circles, ellipses, arcs, beziers, blobs | `brand_lint.py` bans `<circle>`, `<ellipse>`, `<path>`, `rx/ry`, curve commands |
| Geometry | Rectangles, bars, straight polylines, angles, grid blocks only | Generator emits only `rect` + `polyline` primitives |
| Width | Must fit the collapsible sidebar menu width: collapsed **64u** artboard (renders 48–64px), expanded **240u** artboard (renders 220–260px) | Lint asserts viewBox widths |
| Forbidden glyph | **No capital `K` anywhere** — marks, wordmarks, labels. The stroke alphabet has no `K` definition | Generator raises on `K`; lint scans titles + `data-text` |
| Typography | Custom angular monoline stroke alphabet, uppercase only, tight tracking (2u letter gap) | `GLYPH` table in `brand_gen.py` |
| Color | `#3DD6F5` electric cyan on `#0A0B0D` near-black (core). Vertical accents per matrix §4 | Tokens in `brand_gen.py` |
| Radius | `0px` corner radius everywhere | No `rx/ry` allowed |
| Stroke | 1u hairline (symbol + alphabet). Max 2u. Never round caps — square/segment rendering only | Lint warns `>2u` |
| Grid | 8u design grid on a 64u artboard (4u half-steps permitted for intra-symbol spacing) | Construction sheet |

## 2. FILE MANIFEST

| Asset | Path | Use |
|---|---|---|
| Collapsed mark (core) | `design/brand/core/mark-collapsed.svg` | Collapsed sidebar, favicon base, app icon |
| Collapsed mark — dense | `core/mark-collapsed-dense.svg` | High-density terminal views (signal lines only) |
| Expanded lockup (core) | `core/lockup-expanded.svg` | Expanded sidebar header, login, splash |
| State matrix | `core/mark-states.svg` | Active / warn / neutral reference |
| Vertical icons ×6 | `verticals/icon-{sales,support,product,finance,research,recon}.svg` | Collapsed sidebar per product |
| Vertical lockups ×6 | `verticals/lockup-*.svg` | Expanded sidebar per product |
| Construction sheet | `templates/construction-sheet.svg` | Anatomy + 8u grid |
| Vertical template | `templates/vertical-template.svg` | Shared-grid 2×3 vertical matrix |
| Module glyphs | `templates/module-icons.svg` | Sidebar nav glyphs (dashboard, library, radar, scorer, brief, agent) |

Regenerate everything: `python3 tools/brand_gen.py` · Verify rules: `python3 tools/brand_lint.py`

## 3. MARK ANATOMY (64u artboard)

The mark is **constant-base + one swapped motif**. Every product in the suite is recognizable at 48px because the base never changes.

**Shared base (never changes):**
1. **Three ascending signal bars** — filled grid blocks `8×8 / 8×16 / 8×24` at x = 8/20/32, sitting on the command line. Data, signal, intelligence.
2. **Command line** — 2u bar `x 8→56, y 52`. The prompt. It anchors the name *“Command”*.
3. **Command cursor** — 4×8 block at x 52 on the line. Direction, agency, the live loop.

**Swapped motif (top zone `y 6→22`, exactly ONE per vertical):**
Content = angular waveform · Sales = pipeline + nodes + beam · Support = ticket layers + resolution mark · Product = feature modules + journey line · Finance = metric bars + threshold line · Research = document modules + search beam · Recon = capture frame + scan line (derived).

## 4. VERTICAL MATRIX

| Vertical | Product name | Motif | Accent |
|---|---|---|---|
| Content (core) | `CONTENT COMMAND` | Signal waveform (angular zigzag) | `#3DD6F5` electric cyan |
| Sales | `SALES COMMAND` | Pipeline spine + stage nodes + beam | `#5C8FD6` blue steel |
| Support | `SUPPORT COMMAND` | Ticket layers + resolution mark | `#34D399` green pulse |
| Product | `PRODUCT COMMAND` | Feature modules + journey line | `#A78BFA` purple node |
| Finance | `FINANCE COMMAND` | Metric bars + threshold line | `#F5C842` gold signal |
| Research | `RESEARCH COMMAND` | Document modules + search beam | `#E85DC8` magenta trace |
| Recon *(derived)* | `RECON COMMAND` | Capture frame + scan line | `#F97316` signal orange |

System states override accent: active = `#3DD6F5`, warning = `#EF4444`, neutral = `#6B7280`.

**Name law:** every product name is `"X COMMAND"` and contains **no capital K** (verified: all seven names are K-free).

## 5. WORDMARK (angular monoline alphabet)

- 8u × 16u glyph cell, 1u stroke, straight segments only, uppercase only.
- Chamfered `D`, pointed `A`/`M`/`V`/`W`, rectangular `O` (never oval).
- Tracking: 2u between glyphs, 8u word advance.
- **There is no `K` glyph.** Requesting one raises a build error — the ban is structural, not editorial.
- Symbol-to-text gap: exactly **12u**.

## 6. UI BEHAVIOR (how the logo adapts)

| Condition | Logo behavior |
|---|---|
| Sidebar collapsed (48–64px) | `mark-collapsed.svg` only, 48px, vertically centered in 64px header slot |
| Sidebar expanded (220–260px) | `lockup-*.svg`, 100% width of sidebar content area (240u nominal) |
| High-density terminal view | `mark-collapsed-dense.svg` — motif + cursor removed, signal bars + line only |
| Third-party integration page | Reduce mark to 60% opacity inside partner API card context; no lockup |
| Warning/error shell state | Mark recolors to `#EF4444`; geometry unchanged |
| Inactive/ambient state | Mark recolors to `#6B7280`; geometry unchanged |
| Viewport < 360px | Collapsed mark 32px; never the lockup |

## 7. WORKFLOW — applying the system

1. **Identify surface** → sidebar / splash / card / document.
2. **Identify product** → find vertical in matrix §4 (or derive, §8).
3. **Identify state** → active / warn / neutral / dense.
4. **Pick asset** from manifest §2 — never redraw.
5. **Place**: top-left corner, aligned to sidebar edge + 16u inset. Collapsed = icon slot 64px. Expanded = lockup at full sidebar width.
6. **Verify** → `python3 tools/brand_lint.py` must PASS on every committed SVG.

## 8. DERIVING A NEW VERTICAL (amend rules)

Change **exactly one thing**: the top-zone motif. Everything else is frozen.

1. Name it `X COMMAND` — reject any name containing **K**.
2. Choose an accent distinct by hue (keep saturation/contrast on `#0A0B0D`).
3. Draw ONE motif in zone `y 6→22, x 8→56`, straight segments / rects only, max 5 elements.
4. Reuse the shared base untouched. Do not restyle bars, line, or cursor.
5. Register the motif in `brand_gen.py` (`MOTIF` dict) + wordmark in `WORDMARK` dict.
6. Regenerate + lint. Add a row to matrix §4 and to `vertical-template.svg` (or document it as derived).

**Amend table (what may change vs what is frozen):**

| Element | May amend? | Rule |
|---|---|---|
| Signal bars, command line, cursor | **Frozen** | Same geometry in all verticals |
| Top motif | Yes — 1 per vertical | Zone `y 6–22`, ≤5 straight elements, no curves |
| Accent color | Yes — 1 per vertical | Unique hue; legible on `#0A0B0D` |
| Product text | Yes | `X COMMAND`, uppercase, no `K` |
| Glyph alphabet | **Frozen** | New characters only via `GLYPH` table (never `K`) |
| 12u symbol-text gap | **Frozen** | Exactly 12u |
| 1u stroke / 0u radius / 8u grid | **Frozen** | Lint-enforced |
| Artboard widths 64u / 240u | **Frozen** | Sidebar-fit law |

## 9. DECISION TREE — which logo, what to amend

```
START — you need a brand mark
│
├─ Is this the top-left app corner (sidebar header)?
│  ├─ YES → Is the sidebar collapsed?
│  │        ├─ YES → collapsed mark (icon only). High-density view?
│  │        │        ├─ YES → mark-collapsed-dense.svg (signal lines only)
│  │        │        └─ NO  → mark-collapsed.svg (full symbol)
│  │        └─ NO  → expanded lockup (symbol + X COMMAND wordmark)
│  │                 → width = sidebar width (240u nominal, 220–260px band)
│  └─ NO → continue
│
├─ Which product surface is this?
│  ├─ Content Command (core)      → content motif (waveform) + cyan
│  ├─ X Command (registered v.)   → its motif + its accent (matrix §4)
│  ├─ NEW vertical requested      → DERIVE (workflow §8: swap motif only)
│  ├─ Module / topic badge        → module glyph set (16u nav glyphs),
│  │                                never the product logo
│  └─ Partner / integration page  → mark at 60% opacity, no lockup,
│                                    inside partner card context
│
├─ Which system state?
│  ├─ Active    → recolor accent (vertical hue, default cyan)
│  ├─ Warning   → recolor #EF4444, geometry unchanged
│  ├─ Neutral   → recolor #6B7280, geometry unchanged
│  └─ Dense UI  → dense mark, no motif, no cursor
│
└─ Before shipping:
   ├─ Any curve/round shape crept in?     → YES: amend to angles (FAIL lint)
   ├─ Any capital K anywhere?             → YES: remove (FAIL lint)
   ├─ Width matches sidebar mode?         → NO: resize artboard 64u/240u
   ├─ Base geometry altered per vertical? → YES: revert; only motif+accent vary
   └─ brand_lint.py PASS → ship
```

## 10. TOPIC & MODULE MARKS (16u nav glyphs)

Module surfaces get **glyphs, not logos** — same angular language, 1u stroke, 16u cell:
`dashboard` (bars) · `library` (rows) · `radar` (triangulation) · `scorer` (steps + threshold) · `brief` (document) · `agent` (node graph).
Rule: if it is a nav item, scorecard, tag, or topic chip — it is a glyph. If it is the top-left of a product shell — it is a mark. Never mix.
