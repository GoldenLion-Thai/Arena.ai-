# CONTENT COMMAND — APP DESIGN
### Core product shell · Content vertical · `#3DD6F5`
Status: DESIGN DEFINED · see `docs/PROJECT-AUDIT.md` for completion ledger

---

## 1. PRODUCT

The flagship **content intelligence terminal**: ingests multi-platform performance data, detects outliers, enriches with LLM taxonomy, scores ideas against ICP, and generates weekly briefs — with a terminal-grade UI on the left, signal on the right.

## 2. SHELL LAYOUT

```
┌──────────┬───────────────────────────────────────────────┐
│ SIDEBAR  │  COMMAND DASHBOARD                            │
│ 220-260px│  ┌─────────┐ ┌─────────┐ ┌─────────┐         │
│ (48-64px │  │ SIGNALS │ │ OUTLIERS│ │ FATIGUE │         │
│ collapsed│  └─────────┘ └─────────┘ └─────────┘         │
│ )        │  CONTENT LIBRARY / RADAR / SCORER / BRIEFS    │
│ ▓ LOGO   │                                               │
│ dashboard│                                               │
│ library  │                                               │
│ radar    │                                               │
│ scorer   │                                               │
│ brief    │                                               │
│ agent    │                                               │
│ ──────── │                                               │
│ sources  │                                               │
└──────────┴───────────────────────────────────────────────┘
```

- **Logo**: `core/lockup-expanded.svg` in expanded header (full sidebar width); `core/mark-collapsed.svg` at 48px when collapsed. Dense mode swaps `mark-collapsed-dense.svg`.
- **Nav glyphs**: `templates/module-icons.svg` set (16u) — never the product mark.
- **Density rules**: comfortable = card grid 3-up; compact = 1px-hairline rows; dense = dense mark + table view.

## 3. MODULES (shell build order)

| # | Module | Purpose | Nav glyph |
|---|---|---|---|
| 1 | Command Dashboard | Signal overview, outliers, fatigue, ingestion health | dashboard |
| 2 | Content Library | All tracked content + tags + performance | library |
| 3 | Competitor Radar | Peer content triangulation + share of voice | radar |
| 4 | Idea Scorer | ICP-fit scoring of candidate ideas | scorer |
| 5 | Brief Generator | Weekly brief assembly + slate recommendation | brief |
| 6 | Intelligence Agent | Ontology-aware Q&A with cited source records | agent |
| 7 | Sources (admin) | API connection cards + secret management + health | (settings glyph) |

## 4. ENGINE SUBSYSTEMS (design baseline from program audit)

| Subsystem | Baseline % | Needs to reach 100% |
|---|---|---|
| Data architecture / schema | 100 | Confirm indexes, FKs, pgvector readiness for semantic search |
| Outlier compute engine | 95 | Account baseline windowing; small-sample bias handling |
| Platform ingestion / sync | 85 | Retry logic, idempotency keys, incremental sync cursors |
| LLM enrichment / taxonomy | 80 | Prompt versioning, confidence thresholds, tag review queue |
| Idea scoring engine | 80 | Rubric weighting, ICP context injection, comparable retrieval |
| Hook performance scoreboard | 85 | Fatigue status, format correlation, demand-signal sort |
| Weekly brief / reporting | 40 | Cron trigger, report template, roll-up metrics |
| API connection cards | 30 | Sources module, secret management UI, health indicators |
| Intelligence agent | 50 | Ontology query routing, source citations, safe SQL generation |
| Frontend terminal UI | 70 | Shell routes, signal cards, scoreboards, density rules |
| Logo / sidebar branding | 95 | UI integration of `design/brand/` + favicon export |
| End-to-end autonomy | 25 | Feedback loop closure — see `docs/AUTONOMY-ROADMAP.md` |

## 5. UI LANGUAGE

- Background `#0A0B0D`, surfaces `#111316`, hairlines `#1A2228`, text `#C9D1D9`.
- Type: monospace/tabular for data (system stack: `ui-monospace, "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace`).
- Signal states: active `#3DD6F5` · warning `#EF4444` · neutral `#6B7280` · positive `#34D399`.
- Radius `0`, borders `1px`, spacing on 8px grid. Cards = outlined rects, no shadows, no blur.
- Numbers right-aligned tabular; timestamps ISO-8601 compact.

## 6. AGENT SAFETY RULES (Intelligence Agent)

1. Every answer cites source record IDs from the ontology.
2. SQL generation is read-only against views; never raw DDL/DML.
3. Confidence surfaces next to every claim; low confidence → say so.
4. Refuse out-of-ontology questions with a routing suggestion.
