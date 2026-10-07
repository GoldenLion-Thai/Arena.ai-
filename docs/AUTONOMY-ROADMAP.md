# PROJECT DIRECTION & STEPS TO AUTONOMY
### Arena Command suite — overall view and execution ladder
Version 1.0 · 2026-09-23 · Companion to `docs/PROJECT-AUDIT.md`

---

## 1. OVERALL VIEW

The program has three asset classes:

1. **Brand & design language** — now *locked* (logo system, terminal UI language, vertical matrix).
2. **Content Command core** — the flagship intelligence terminal (data ontology + scoring + briefs).
3. **SFGa-OS Recon tooling** — authorization-gated recovery/audit consoles (design-only; see red lines in audit).

**Where we are:** strong design foundation and product definition; engineering and operational maturity are the binding constraints. The system currently stops at *human closes the loop*. Every step below moves one more loop-closure decision from human → system.

**North star:** a closed content-intelligence loop — publish → measure → learn → re-score → recommend → (approve) → publish — running continuously with an oversight dashboard and human veto at defined gates.

## 2. THE FIVE PROGRAM STEPS

| Step | Objective | Status | Exit criteria |
|---|---|---|---|
| **1. Lock the brand system** | Sidebar logo system + verticals + decision tree | **DONE** (this cycle) | `brand_lint.py` PASS; 19 assets; vertical template approved |
| **2. Complete the core app shell** | Sidebar nav → Command Dashboard → Content Library → Competitor Radar → Idea Scorer → Brief Generator → Intelligence Agent | IN PROGRESS | Every shell route mounts real data; empty/loading/error states defined |
| **3. Operational maturity** | Sync status, API connection health, last-ingestion stamp, outlier confidence, tag review queue, enrichment error log | NOT STARTED | Every job observable + retryable; no silent failures |
| **4. Close the feedback loop** | Publish → metrics → outlier → enrichment → aggregates → scorer → brief → human approve → publish | NOT STARTED | One full loop cycle runs in production |
| **5. Move to autonomy** | Climb L1→L7 with human veto at named gates | ROADMAP | Sustained L5+ for 2 review cycles |

## 3. THE FEEDBACK LOOP (step 4 detail)

```
   [PUBLISH CONTENT]
          │
          ▼
   [PLATFORM METRICS SYNC]  ◄── error queue + retry (step 3)
          │
          ▼
   [OUTLIER SCORE CALCULATED]  ── confidence + baseline window
          │
          ▼
   [LLM ENRICHMENT RE-RUNS]  ── prompt version pinned
          │
          ▼
   [HOOK / FORMAT / TOPIC AGGREGATES UPDATE]
          │
          ▼
   [IDEA SCORER RE-TRAINS ON NEW SIGNALS]
          │
          ▼
   [NEXT BRIEF IS GENERATED]
          │
          ▼
   [HUMAN EDITOR APPROVES / ADJUSTS]   ◄── GATE A (human veto)
          │
          └────────────────────────► [PUBLISH CONTENT] …
```

## 4. AUTONOMY LADDER

| Level | Capability | Entry criteria | Human role |
|---|---|---|---|
| **L1** | Manual sync, manual scoring | — (current starting point) | Does everything |
| **L2** | Auto-ingestion + auto-outlier detection | Idempotent sync + retry + health checks (step 3) | Reviews exceptions |
| **L3** | Auto hook/topic/format tagging | Prompt versioning + confidence thresholds + tag review queue | Clears review queue |
| **L4** | Auto-brief generation from scored ideas | Scorer rubric + ICP context + comparable retrieval | Edits/approves briefs (GATE A) |
| **L5** | Auto-weekly report + recommended slate | Cron brief pipeline + roll-up metrics + fatigue tracking | Consumes + vetoes slate |
| **L6** | Auto-publish scheduling with human approval | Calendar API + score→schedule policy | Approves schedule (GATE B) |
| **L7** | Fully autonomous loop with oversight dashboard | Two clean review cycles at L6 + rollback tooling | Monitors oversight console (GATE C: kill-switch) |

**Current position: L1.5** — designs and engines are specified or prototyped, but ingestion and scoring are not yet continuous and there is no closed loop.

## 5. SEQUENCING (next 90 days)

**Days 0–30 — make it real (→ solid L2)**
1. Mount Content Command shell (sidebar + dashboard + library) on real data.
2. Ship sync engine hardening: retries, idempotency keys, incremental cursors, health badges.
3. Wire API connection cards to secret storage + last-ingestion stamps.

**Days 30–60 — make it smart (→ L3/L4)**
4. Prompt versioning + confidence thresholds + tag review queue (GATE: human clears queue).
5. Idea Scorer: rubric weighting, ICP context injection, comparable-video retrieval.
6. Weekly Brief: cron trigger + template + roll-up metrics.

**Days 60–90 — close the loop (→ L5)**
7. Publish→metrics→outlier→enrichment pipeline automation.
8. Scorer re-training on new signals; brief auto-assembly.
9. Oversight console v1: loop state, confidence, error queues, kill-switch (GATE C).

## 6. GUARDRAILS (non-optional)

- **Human veto at every publish-affecting action until L6 review gates have run clean for two cycles.**
- Every automated decision ships with confidence + source citations (Intelligence Agent rule).
- Recon/credential tooling: design + authorization gates only — no custom credential extraction or decryption implementation (see audit §3).
- Brand consistency is CI-enforced: `brand_lint.py` must PASS in the pipeline.

## 7. DECISION GATES

| Gate | Question | Owner | Failsafe |
|---|---|---|---|
| GATE A | Publish this content? | Human editor | Auto-hold, never auto-publish below L6 |
| GATE B | Schedule this slate? | Human editor | Revert to manual calendar |
| GATE C | Keep autonomy level? | Program lead | Kill-switch → drop one ladder level |
| GATE D | Ship new vertical logo? | Design owner | `brand_lint.py` + matrix §8 checklist |
