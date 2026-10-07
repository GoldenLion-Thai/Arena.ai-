# DECRYPTION & RECONSTRUCTION — APP DESIGN
### SFGa-OS authorized recovery console · Recon vertical (derived) · `#F97316`
Status: UI/UX CONCEPT + SPEC ONLY — **no credential extraction or decryption logic is included or planned for this repository** (see §0)

---

## 0. SCOPE BOUNDARY (read first)

This design is an **interface concept for an authorization-gated forensic recovery console**, to be used only on systems the operator owns or is contractually authorized to audit. It deliberately ships with:

- ✅ UX flows, pipeline visualization, audit-log schema, export format, architecture diagram
- ✅ Authorization gate, chain-of-custody UI, redaction-by-default previews
- ❌ **No working browser-credential extraction, cookie theft, DPAPI unrolling, or password decryption code** — custom tooling of that kind is indistinguishable from malware and will not be built here.

For real authorized recovery work, use established audited forensic tooling (e.g., Magnet AXIOM, or open-source recovery utilities) under written authorization — this console is the *oversight layer* around such tools, not a new stealer.

## 1. PRODUCT

A five-stage, chain-of-custody–logged recovery pipeline console: select authorized evidence sources → validate local key context → process through an external audited engine → reconstruct timelines/sessions → export an integrity-verified bundle.

## 2. FIVE-STAGE PIPELINE (UI simulation)

| Stage | Shows in UI | Real work (out of scope — external engine) |
|---|---|---|
| 1. Source select | Profile cards (browser/profile/OS), scope checkboxes | Evidence acquisition under authorization |
| 2. Key context check | Current-user/hostname/OS context, authorization gate status | Validates operator is on the authorized account/machine |
| 3. Process | Animated pipeline + live activity log, redacted output | Delegates to audited external forensic engine |
| 4. Reconstruct | Timeline, session map, domain index, masked records | Join + index exported records |
| 5. Export & audit | Encrypted bundle + SHA-256 manifest + audit log | Signed export, retention policy |

## 3. AUTHORIZATION GATE (cannot be bypassed in UI flow)

Two explicit confirmations, both required before Stage 1 unlocks:
1. “I own this system / hold written authorization to audit it.”
2. “I accept a tamper-evident audit log of every action in this session.”

Legal banner references CFAA, GDPR/DPA, and computer-misuse law in the operator’s jurisdiction. Session ID + hostname + OS stamped into the audit log on gate pass.

## 4. AUDIT LOG SCHEMA (append-only)

| Field | Type | Notes |
|---|---|---|
| `event_id` | uuid | |
| `ts_utc` | iso8601 | |
| `session_id` | uuid | set at gate pass |
| `actor` | string | OS user + operator label |
| `stage` | enum | `GATE,SELECT,KEYCHECK,PROCESS,RECONSTRUCT,EXPORT` |
| `action` | string | verb-object, e.g. `PROCESS_START` |
| `target` | string | source id / record class (never plaintext secrets) |
| `result` | enum | `OK, DENIED, ERROR` |
| `prev_hash` | sha256 | hash chain for tamper evidence |
| `entry_hash` | sha256 | over this row + `prev_hash` |

## 5. EXPORT FORMAT

- Container: `.sfgx` (age- or AES-256-GCM-encrypted tar) with `manifest.json`, `records/…`, `AUDIT_LOG.jsonl`, `CUSTODY.json`.
- `manifest.json`: schema version, tool versions, source list, record counts per class, SHA-256 per file, redaction policy applied.
- Passwords/secrets are **never** included in previews; default previews masked (`••••••••`); reveal requires a second gate confirm and is logged.

## 6. ARCHITECTURE (oversight console around external engines)

```
[OPERATOR UI: this console]
   │  authorization gate + audit log + redaction policy
   ▼
[ORCHESTRATOR] ──► [EXTERNAL AUDITED ENGINE(S)] (not in this repo)
   │                       │
   ▼                       ▼
[RECONSTRUCTOR]      [ENCRYPTED WORKSPACE]
   │
   ▼
[EXPORTER + MANIFEST] ──► [.sfgx bundle + hash chain]
```

## 7. UI LANGUAGE

Same terminal system as Content Command, Recon accent `#F97316`: sidebar with `verticals/lockup-recon.svg` (expanded) / `icon-recon.svg` (collapsed), dense hairline tables, masked data cells, stage rail on top, activity log docked bottom-right, chain-of-custody badge top-right.

Live mockup: `design/apps/decryption-reconstruction/ui-preview.html` (simulated data only).
