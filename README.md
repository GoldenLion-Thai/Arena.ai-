# ARENA COMMAND SUITE

Terminal-grade brand + product design foundation for the **X Command** vertical family
(Content · Sales · Support · Product · Finance · Research · Recon).

## Start here

| | |
|---|---|
| **Live dashboard** | `dashboard/index.html` — app portfolio, % completion, logo system, decision tree, autonomy ladder |
| **Logo system** | `design/brand/LOGO-SYSTEM.md` — hard rules, vertical matrix, workflow, decision tree, amend rules |
| **Project audit** | `docs/PROJECT-AUDIT.md` — file inventory + status report per app + what each needs |
| **Direction** | `docs/AUTONOMY-ROADMAP.md` — 5 program steps, feedback loop, L1–L7 ladder to autonomy |
| **Core app — LIVE** | `app/content-command/index.html` — working CONTENT COMMAND terminal (7 modules, mock data, real sidebar brand logos) |
| **Core app design** | `design/apps/content-command/DESIGN.md` |
| **Recon console design** | `design/apps/decryption-reconstruction/DESIGN.md` + `ui-preview.html` (simulation only) |

## Brand law (summary)

- Top-left logo fits the collapsible sidebar: **64u** collapsed mark (48–64px) · **240u** expanded lockup (220–260px).
- **Nothing round or oval** — rectangles, bars, straight lines, angles, grid blocks only.
- **No capital `K`** anywhere — the stroke alphabet has no K glyph; lint enforces it.
- 8u grid · 1u hairline · 0u radius · 12u symbol-to-text gap · uppercase angular monoline wordmarks.

## Tooling

```bash
python3 tools/brand_gen.py    # regenerate all 19 logo assets + previews from geometry source of truth
python3 tools/brand_lint.py   # enforce the hard rules (must PASS before any logo ships)
```

## Ground rules

Credential-recovery tooling (browser logins/cookies/history) is **design + oversight UI only** in this
repository — no extraction or decryption implementations. See `docs/PROJECT-AUDIT.md` §5.
