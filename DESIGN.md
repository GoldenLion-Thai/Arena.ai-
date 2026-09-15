# Sovereign — design guide for privacy-first, minimal AI interfaces

A working reference for building a private-LLM product interface in the Venice-adjacent
"sovereign AI" register: dark, quiet, technically credible, slightly anti-corporate — without
positioning a professional product as ungoverned.

This guide is implemented, not just described. Every rule below has a corresponding file:

| Concern | Implementation |
| --- | --- |
| Tokens, layout, motion | `assets/css/sovereign.css` |
| Landing narrative + live theming | `index.html`, `assets/js/landing.js` |
| Chat-first workspace | `app.html`, `assets/js/app.js` |
| Model registry with data-handling metadata | `assets/js/models.js` |
| Client-side encryption of local history | `assets/js/vault.js` |
| Local-first conversation store | `assets/js/db.js` |
| On-device demo responder (offline default) | `assets/js/engine.js` |
| Real inference: Ollama ndjson + OpenAI SSE, probe, discovery | `assets/js/gateway.js` |
| Same-origin streaming proxy + static server | `server.js` |
| Brand constant, logo mark, titles, favicon | `assets/js/brand.js` |
| OCI/VPC deployment: systemd, compose, nginx, checklist | `deploy/` |
| Safe markdown rendering for streamed output | `assets/js/md.js` |
| Behaviour benchmark dashboard | `lab.html`, `assets/js/lab.js` |

Run it:

```bash
node server.js          # http://localhost:8080  (binds 0.0.0.0)
# or
python3 -m http.server 8080 --bind 0.0.0.0
```

---

## 1. Principles

1. **Privacy is a product state, not a policy sentence.** Show where the session runs, where files
   are stored, and whether any connector can reach outside the boundary. If the user has to open a
   settings page to learn where their prompt went, the design has failed.
2. **Conversation is primary.** One focused chat surface. Tools and settings are progressively
   disclosed, never arranged as a busy card grid around the input.
3. **Control over spectacle.** No avatars, no fake "thinking" theatrics, no engagement nudges, no
   anthropomorphic copy. Motion is used to communicate state (streaming, live, waiting).
4. **Proof over promises.** Encryption, retention, source citations, model identity, checkpoint and
   deployment region are inspectable controls, not adjectives.
5. **Minimal, not sparse.** Whitespace and a limited palette create hierarchy. Essential settings are
   never hidden behind vague icons.
6. **Claim only what the architecture substantiates.** "No training on your data" is a contractual and
   architectural fact you can point at, or it is nothing. The demo footer states this explicitly.

---

## 2. Positioning and voice

```
Your AI. Your server. Your data.
Private language models for sensitive work — without sending your documents,
prompts or IP into a public AI black box.
```

Sell **private, controlled, self-hosted, policy-configurable**. Do not sell "uncensored" as the
commercial proposition: it is harder to defend, harder to insure, and it repels exactly the legal,
finance, consulting and compliance buyers who have budget for this.

Copy rules:

| Avoid | Prefer |
| --- | --- |
| "Military-grade privacy" | "Chats are encrypted and stored in your selected workspace." |
| "Your data is safe" | "This request is processed in your UK private cloud workspace." |
| "Uncensored AI" | "Research model profile: reduced refusal controls." |
| "Powered by AI" | "Qwen 14B Instruct · Private VPC · Knowledge retrieval on." |
| "We respect privacy" | "Telemetry is off. Nothing is sent externally without permission." |

Short declarative statements beat hedged marketing: *No prompt retention.* *Run it where you control
it.* *Built for confidential work.*

---

## 3. Layout blueprint

### Desktop shell

```
┌───────────────────────────────────────────────────────────────────────────┐
│  ◉ SOVEREIGN   /  Workspace: Legal Ops ▾      ● LOCAL-ONLY   ⚿ Vault  ⚙  │
├───────────────┬───────────────────────────────────────────────────────────┤
│               │  [Model: Qwen 14B ▾ LOCAL] [Private knowledge: On ▾]      │
│ Conversations │                     AES-256 · RAG ENABLED · UK REGION     │
│               ├───────────────────────────────────────────────────────────┤
│ + New chat    │                                                           │
│ ⌕ search      │  Ask privately.                                           │
│ Today         │  [example prompts]                                        │
│  Contract risk│                                                           │
│  VAT scenario │  YOU   Compare the indemnity obligations…                 │
│ Pinned        │  QWEN  streaming output · sources · TTFT · tok/s          │
│ Knowledge base│                                                           │
│ ──────────────├───────────────────────────────────────────────────────────┤
│ 12.4 KB local │  + Attach  @knowledge  /commands        ~38 tokens  Send  │
│ TTFT p50/p95  │                                                           │
└───────────────┴───────────────────────────────────────────────────────────┘
```

Numbers that matter:

- Sidebar **240–280 px**, persistent on desktop, off-canvas below 900 px, opened by a labelled
  button (never an unlabelled hamburger as the only route to history).
- Conversation column **720–880 px** centred. Long-form legal and financial text needs measure
  discipline more than it needs width.
- Composer pinned to the bottom, `position: sticky`-free — it lives in a CSS grid row so it never
  overlaps the keyboard on mobile.

### Mobile shell

- Sidebar removed by default; conversation button is labelled.
- Composer fixed above the keyboard.
- Model, privacy state, attachment and knowledge controls sit in **one horizontal command bar
  immediately above the input**. No user should have to hunt through settings to discover whether an
  attachment is stored locally or sent to a remote model.

---

## 4. Colour

Use **one** primary accent, a small neutral scale, and semantic status colours. Excess accent makes a
privacy product feel like a trading terminal.

### Midnight Vault (default — legal, finance, enterprise private cloud)

| Token | Hex | Use |
| --- | --- | --- |
| `--canvas` | `#090B10` | App background |
| `--surface` | `#121722` | Panels, composer |
| `--surface-2` | `#1A2230` | Menus, hover cards |
| `--text` | `#F4F7FB` | Headings, main copy |
| `--text-2` | `#9CA9BA` | Metadata |
| `--accent` | `#C8FF3D` | **Reserved**: local-only state, active streaming, primary action |
| `--action` | `#78A6FF` | Secondary CTA, focus ring |
| `--verified` | `#70E0B5` | Privacy confirmation |
| `--warning` | `#FFC857` | External or shared-data state |
| `--danger` | `#FF6B72` | Delete, cloud-risk notices |
| `--research` | `#C39bff` | Labelled research configuration only |

### Obsidian + Acid Lime (Venice-adjacent, developer-led)

`#0A0A0A` canvas · `#151515` surface · `#2A2A2A` border · `#F5F5F0` text · `#929292` muted ·
`#C8FF3D` accent · `#57D9A3` verified · `#FFB84D` caution.

### Deep Navy + Cyan (credible security platform, more polish)

`#07111F` canvas · `#0E1B2D` surface · `#152942` surface-2 · `#E9F4FF` text · `#54D7FF` accent ·
`#69E6AF` privacy · `#91A5BC` muted · `#FFB45B` alert.

All three are live-switchable on the landing page (`landing.js → THEMES`): the switcher rewrites CSS
custom properties on `:root`, which is exactly how a design-token system should behave in production.

Typography: **Space Grotesk** (display) · **Inter** (body) · **JetBrains Mono** (technical metadata).
Mono is reserved for facts — model ids, latency, region, cipher, chunk counts. That reservation is
what makes the interface read as instrument panel rather than brochure.

---

## 5. Privacy-state component

Beside the workspace name, always visible, always clickable:

```
● LOCAL-ONLY          No cloud inference · chats encrypted on this device
◐ PRIVATE CLOUD       Inference: UK VPC · retention 0 days · provider cannot train
◑ EXTERNAL ENDPOINT   Prompts leave your boundary · confirm terms first
```

Opening it shows a **generated** data-flow list for the *current* model and mode — four numbered
steps describing where the prompt actually goes. It is generated from state
(`models.js → SOV_MODES`, `app.js → renderPrivacy`) rather than being a static graphic, so it cannot
drift from reality.

Rules:

- Never a generic green shield. Users need a readable answer to *"where did my prompt go?"*
- Moving to an external endpoint requires an explicit confirmation step each time
  (`app.js → confirmBox`). Selecting an external model overrides the session mode and the topbar says
  so: *"Model endpoint overrides workspace mode."*
- The state colour is semantic: lime = local, blue = your cloud, amber = outside your boundary.

---

## 6. Local-first storage

Default to local, gate cloud behind explicit permission, and keep credentials out of model context.

| Data | Default location | UX disclosure | User control |
| --- | --- | --- | --- |
| Conversations | Encrypted IndexedDB on device | "Stored on this device" | Delete chat, clear all, retention period |
| Uploaded files | Local workspace, metadata + chunks | "Indexed locally" | Per-file delete, re-index, exclude from retrieval |
| Embeddings / vector index | Local or tenant-isolated store | "Knowledge stays in: local workspace" | Local / private cloud / shared team vault |
| Model weights | Device or server model cache | "Model runs on: this device / UK VPC" | Download, remove, verify version + hash |
| API keys | Memory (tab) / OS keychain / secrets manager | "Never included in model context" | Rotate, revoke, scope |
| Telemetry | Off by default | "Diagnostics: off" | Opt in with an itemised payload preview |

Implementation notes from this repo:

- **IndexedDB over SQLite/WASM** here: no bundler, no OPFS permission prompt, works everywhere. The
  access pattern is append-heavy, small records, read per conversation — a keyed store with one index
  on `convId` is enough. Move to SQLite (wa-sqlite + OPFS) when you need full-text search across
  transcripts or SQL-shaped queries over metadata.
- **Titles are stored unencrypted** so the conversation list can render while the vault is locked;
  bodies are encrypted. The sidebar says this out loud instead of letting users assume everything is
  ciphertext.
- **API keys** are held in `sessionStorage` at most and sent only as an `Authorization` header — never
  interpolated into prompts, never written to `localStorage`.
- **Retention is enforced in code** (`app.js → Store`), not just offered in a dropdown. `0 days` routes
  writes to tab memory, labels those conversations `RAM` in the sidebar, and reports storage as
  "session only · 0 KB on disk". Any other window purges expired conversations at boot and on change.
  **Reads are never gated by retention** — switching to 0 must not hide or orphan history that already
  exists on disk, and erasing on-disk data stays an explicit action in Settings → Local data.
- **Transaction discipline** (`db.js → tx`): resolve on both the request result *and* the transaction's
  `complete` event. Resolving on `complete` alone races the result microtask and intermittently hands
  back `undefined` — a bug that looks like "my history vanished" and is miserable to diagnose.

### Client-side encryption (honest threat model)

```
passphrase ──PBKDF2-SHA256, per-device salt, 210k iterations──▶ AES-GCM 256 key
                                                                  │
message body ───────────────────────────────────────────────▶ ciphertext + 12-byte IV
```

What it protects: history **at rest** in the browser profile from anyone who reads the disk without
the passphrase. What it does **not** protect against: other scripts on the same origin while the vault
is unlocked, because the key is in JS memory. Say both sentences in the UI (`app.js → renderVault`).
There is no recovery path if the passphrase is lost — say that too.

---

## 7. Model-picker UX

Compact chip in the chat header → structured panel on open. **Not** a long list of model names.

```
Model: Qwen 2.5 14B Instruct ▾  LOCAL
────────────────────────────────────────────────────────
RECOMMENDED
● Qwen 2.5 14B Instruct    Fast · 128k · Writing/Analysis      local
  Mistral Small 12B        Fast · 32k  · Summarisation         local
  Llama 3.1 8B Instruct    Fast · 128k · Chat/RAG              local

SPECIALIST
  Qwen 2.5 Coder 14B       Balanced · Code/Technical review    local
  Qwen 2.5 VL 7B           Balanced · PDFs/Scans/Images        private vpc
  Phi-4 14B                Balanced · fits one 24 GB GPU       private vpc
  Qwen 3 32B Reasoning     Deliberate · Planning               private vpc

ADVANCED
  Qwen 14B — research      Fast · refusal-reduced              local  [research]
  Custom endpoint          Bring your own                      external
```

Every row exposes, before anything is sent:

1. **Name and version** — including quantisation in details, because that determines memory and quality.
2. **Location** — this device, your private UK/EU VPC, or an external provider. Colour-coded.
3. **Speed** — fast / balanced / deliberate. Do not show misleading token-per-second marketing figures
   in the picker; show measured TTFT per message instead.
4. **Capability tags** — writing, coding, vision, multilingual, reasoning, structured output.
5. **Context size and memory footprint** — in an expanded details view.
6. **Licence** — Apache-2.0, MIT, or "community licence — review terms". Llama's licence is not
   OSI-open; surfacing that in the picker prevents a procurement surprise later.
7. **Policy profile** — standard, organisation policy, or research mode. Never "uncensored" as a
   marketing default.
8. **Trains on your data** — No / Yes / Provider-defined. `null` renders as "Provider-defined",
   because pretending to know is worse than admitting you don't.

A refusal-reduced profile carries a visible `research` tag and its blurb states plainly that
abliteration is not a quality improvement and can degrade reliability.

---

## 8. Low-latency streaming chat

**Time to first token is the metric.** 200–400 ms feels immediate; above ~800 ms conversation feels
broken. Streaming exists to reduce *perceived* delay by letting downstream stages begin before
upstream work completes.

### Interaction states

```
1. Idle         composer enabled; model + privacy state visible
2. Sending      user message rendered locally and instantly; assistant container
                reserved with "Connecting securely…"
3. First token  placeholder replaced by streamed content; small pulsing caret,
                never a fake "thinking" animation
4. Streaming    chunks rendered into a stable text block; scroll follows only while
                the reader is near the bottom
5. Complete     final message persisted with citations, token count, TTFT, total time,
                throughput, transport, feedback controls, copy / regenerate / branch
6. Interrupted  partial output saved as "stopped" or "connection interrupted" with
                Retry and Continue — work is never silently discarded
```

### Implementation rules (all present in `app.js` / `engine.js`)

- **SSE for one-way token streaming.** WebSockets only when you genuinely need bidirectional,
  persistent events: tool progress, live collaboration, voice.
- **Buffer the deltas and flush every 30–80 ms** (`setInterval(48ms)` + `requestAnimationFrame`),
  rather than forcing a layout per token. Per-token DOM writes are the single most common cause of a
  janky "fast" model.
- **Keep a request id and an `AbortController`.** Stop generating must cancel server inference too,
  not just browser rendering — otherwise you pay for tokens nobody reads.
- **Show pipeline stages only when they are real**: *Retrieving approved sources*, *Generating
  response*. Decorative stage theatre is a trust liability in a privacy product.
- **Keep the composer active during generation**; queue a new query visibly rather than dropping it.
- **Preserve scroll position** when the user has scrolled up to read; show *Jump to latest* instead of
  snapping down (`updateJump()` uses a 120 px threshold).
- **Measure and display p50/p95** for request-start→TTFT, throughput, retrieval latency, tool time and
  total completion. The workspace sidebar keeps a rolling 40-run histogram and prints TTFT p50/p95 —
  per-message metadata is not enough to catch tail latency.
- **Persist partial output.** An aborted generation is still a message, tagged `stopped`.

Partial SSE parsing must tolerate keep-alive comments and frames split across reads: buffer the
decoder output, split on newlines, keep the trailing fragment for the next chunk (`engine.js →
runRemote`).

---

## 9. Behaviour lab: benchmarking standard vs "abliterated"

Abliteration modifies weights to suppress the direction associated with refusals. It is not a general
quality improvement, and it can alter reliability, formatting discipline and safeguards. Treat it as
an **explicitly labelled research configuration**, never a workspace default.

```
MODEL BEHAVIOUR LAB                                    Run test suite
Base: Qwen 2.5 14B Instruct · Dataset: internal eval v1 · temp 0.4 · seed fixed
┌────────────────────────────┬────────────────────────────┐
│ STANDARD                   │ ABLITERATED / RESEARCH     │
│ Organisation safeguards    │ Refusal direction removed  │
├────────────────────────────┼────────────────────────────┤
│ Tone: Professional         │ Tone: Direct               │
│ Median length: 286 w       │ Median length: 241 w       │
│ Refusal rate: 3.1%         │ Refusal rate: 1.2%         │
│ Helpful completion: 91%    │ Helpful completion: 85%    │
│ Over-refusal: 3.1%         │ Over-refusal: 1.2%         │
│ Policy violations: 0.6%    │ Policy violations: 4.1%    │
│ Format compliance: 94%     │ Format compliance: 78%     │
│ TTFT p50/p95: 286/640 ms   │ TTFT p50/p95: 272/610 ms   │
└────────────────────────────┴────────────────────────────┘
Prompt sets: Safe work | Borderline | Disallowed | Internal policies
```

Design decisions worth copying:

- **Tabs by prompt category**, because a single blended score hides the only two numbers that matter.
  The same variant can look excellent on *Safe work* and unacceptable on *Disallowed*.
- **Refusal rate flips polarity by tab.** On the disallowed set, more refusals is better; the colour
  logic knows this (`lab.js → METRICS[].tabDir`). A dashboard that colours 96% refusal red on a
  prohibited-prompt set is actively misleading.
- **Never compare refusal rate alone.** One published abliterated model card reported refusals falling
  from 98% to 39% on its own 100-prompt harmful test set. Pair it with helpful completion, unsafe
  completion, over-refusal and format compliance.
- **Withhold raw samples for prohibited categories.** Aggregates plus a one-line evaluator rationale;
  the interface renders a redaction panel instead of text.
- **Blind rubric scoring**, three raters, 1–5 across: clarity and directness, professional tone,
  completeness, accuracy and groundedness, appropriate boundary-setting, freedom from harmful
  actionability, format adherence.
- **Show length spread (p10/p50/p90), not just the median.** A wide spread breaks templates and
  downstream parsers even when the average looks fine.
- **Version every run** with checkpoint hash, quantisation, dataset id, decoding parameters.
- **Label illustrative data as illustrative.** `lab.html` carries a permanent notice that the figures
  are a worked example of the format until you wire in your own harness output.

---

## 10. UI details that make it feel right

- Single-column chat shell with generous empty space; no busy card grid around the input.
- Technical proof points in small mono labels: `UK-EU-WEST`, `SELF-HOSTED`, `AES-256`, `RAG ENABLED`,
  `TTFT 286 ms · 41 tok/s`.
- Example prompts drawn from real work: *"Review this contract for liability exposure"*, *"Compare
  these two financial models for assumptions"*, *"What does GDPR require for this deployment?"*
- A privacy-mode control with clear states: **Local only · Private cloud · Team workspace**.
- Real interface, not cyberpunk stock imagery. The product carries the credibility — the hero on
  `index.html` is a live terminal transcript, not an illustration.
- Slash commands (`/model`, `/privacy`, `/export`, `/stats`, `/lock`) and `@`-mentions over the local
  index: power users get a keyboard path, everyone else gets buttons.
- Feedback (`Useful` / `Off-target`) is stored **locally against the message** and never uploaded;
  the diagnostics panel itemises exactly what would leave the device if the user opts in.
- No trackers, no analytics, no cookies, no third-party requests except web fonts. A privacy product
  whose own page phones home loses the argument before it starts.

---

## 11. Reference hosting stack

```
Reverse proxy / WAF
      ↓
AuthN + workspace RBAC
      ↓
OpenAI-compatible model gateway        (LiteLLM / your own router)
      ↓
vLLM (GPU, continuous batching)  |  Ollama (pilot)  |  TGI
      ↓
Quantised open weights: Qwen · Mistral · Llama · Gemma · Phi-4
      ↓
PostgreSQL + pgvector  |  Qdrant (tenant namespaces)
      ↓
Encrypted object storage for approved documents
```

- **Pilot / single user:** Ollama + a 7–14B GGUF quantised model + local vector store.
- **Multi-user GPU service:** vLLM behind the gateway, tenant-aware vector store, private subnet, no
  public model port.
- **Sensitive business data:** server-side encryption, RBAC, audit trail, separate tenant namespaces,
  deletion that removes vector-index chunks and not just records.
- **Sizing:** 14B at Q4 ≈ 9 GB plus context headroom — comfortable on one 24 GB GPU. 32B reasoning
  needs two. Phi-4 (~14B) is the pick when the whole model must fit on a single GPU.

### Open-weight shortlist

| Model | Best use | Deployment fit | Start at | Licence note |
| --- | --- | --- | --- | --- |
| Qwen 2.5 / Qwen 3 Instruct | General business, multilingual, structured output | Broad GGUF + runtime support | 7B–14B Q4 | Apache-2.0 |
| Mistral 7B / Small | Fast assistant, summarisation, doc chat | Efficient, mature ecosystem | 7B–12B Q4 | Check per release |
| Llama 3.x Instruct | General chat and RAG | Widest tooling | 8B Q4 | Community licence — review AUP/MAU |
| Gemma family | Compact local assistance | Small private deployments | 4B–12B Q4 | Gemma terms |
| Phi-4 class | Small-footprint structured tasks | Fits a single GPU | ~14B Q4 | MIT |
| Qwen Coder | Code, scripts, technical review | Specialist, not the default | 7B–14B Q4 | Apache-2.0 |

---

## 12. Naming

Shortlist considered: **Sovereign**, VaultLLM, Blackbox Private AI, IntraMind, PrivateStack,
ClosedCircuit AI, QuietCompute, Northstar Private AI.

`Sovereign` is used here because it signals control and jurisdiction — the two things a UK legal or
finance buyer is actually procuring — without implying the service is ungoverned. "Uncensored" as an
identity attracts the wrong evaluation criteria and the wrong counsel.

---

## 13. Connecting real inference

The demo responder is the honest default: no network, clearly labelled. Real deployments go through
`gateway.js`, which speaks two transports behind one interface:

| Transport | Endpoint | Why |
| --- | --- | --- |
| `ollama` | `POST /api/chat` (ndjson) | Reports its own `eval_count`, `eval_duration`, `prompt_eval_duration` — measured by the runtime, not estimated from characters |
| `openai` | `POST /v1/chat/completions` (SSE) | vLLM, TGI, LiteLLM, llama.cpp server, and Ollama's compat layer |

Rules that came out of building it:

- **Measure TTFT from request start**, not from the first byte of the response body. Measuring after
  the headers arrive reports 0 ms and hides exactly the latency you care about.
- **Prefer runtime-reported numbers.** When Ollama returns `eval_count`, use it; fall back to a
  character estimate only when the runtime reports nothing.
- **Parse streams defensively**: buffer decoder output, split on newlines, keep the trailing fragment,
  ignore SSE comments and keep-alives, tolerate JSON that arrives split across reads.
- **Route policy is explicit**: `external` (only external/discovered models), `cloud` (private-cloud
  models too), or `all` (replace the demo responder). Models discovered by probing always use the
  gateway — they exist nowhere else.
- **Discovery beats documentation.** Probing `/api/tags` or `/v1/models` and injecting the results into
  the picker means the user chooses from what the endpoint actually has, with real size, parameter
  count and quantisation, instead of a list that went stale at build time.
- **Same-origin proxy over CORS.** A browser cannot reach a private subnet and Ollama rejects
  cross-origin calls unless `OLLAMA_ORIGINS` allows them. Forwarding `/gateway/*` from the app origin
  removes CORS, works behind a preview host or LB, and keeps 11434 unpublished. In nginx the two
  settings that matter are `proxy_buffering off` and a long `proxy_read_timeout` — without them tokens
  arrive in one buffered flush at the end.
- **Secret hygiene**: non-secret config in `localStorage`, API key in `sessionStorage` for the tab,
  sent only as an `Authorization` header, never in prompt context, never on disk.
- **Failures surface in the transcript.** A dead endpoint produces a readable message naming the
  likely cause (unreachable host or blocked cross-origin request) and the fix, not a spinner.

## 14. Brand as a constant

`assets/js/brand.js` holds `NAME` and the SVG `MARK`. Legal name, slug, page titles, meta description,
wordmarks, aria labels and the favicon all derive from them, and `apply()` injects the mark into every
`.brand__mark` slot. Body copy stays in the pages — copy should be edited as copy — but nothing
*identifying* is hardcoded anywhere else. The smoke test patches that one constant to `QuietCompute`
and asserts no stale brand text survives in the rendered DOM, which is what makes "rename is one
constant" a verified claim rather than a hopeful one.

## 15. What the test suite verifies

`npm test` runs two suites in jsdom with a real IndexedDB and WebCrypto shim, driving the actual UI
rather than unit-testing helpers. 159 assertions:

| Area | Asserted behaviour |
| --- | --- |
| Landing | Terminal streams, 9 palette swatches, 8 architecture nodes, live theme switch rewrites `--canvas`, honesty notice present |
| Picker | Full registry listed in 3 groups, every row states a data location, research profile tagged, details expose licence/memory/training posture, search filters, selection updates the chip and closes |
| Privacy | 3 modes, data flow generated from state, external switch requires confirmation, cancelling keeps the session local |
| Streaming | User message renders before inference, assistant container reserved with a real stage, Send flips to Stop, caret removed on completion, sources cited, TTFT/throughput/transport reported per message |
| Interruption | Tokens streamed before the stop, Stop returns to Send, partial output persisted and labelled `stopped` |
| Encryption | Ciphertext contains no plaintext, cipher version + IV present, round-trip works, locked vault cannot read bodies, wrong passphrase rejected |
| Retention | `0 days` switches writes to memory, storage labelled session-only, existing history still readable, nothing new on disk, sidebar marks `RAM`, memory messages never reach IndexedDB |
| Commands | Slash menu opens, `/knowledge` toggles retrieval, `/stats` reports storage and vault state |
| Lab | 4 tabs, 2 variants, ≥18 metrics, samples + rationale for permitted sets, 7-criterion rubric, disallowed tab withholds raw samples, **96% refusal coloured good not bad**, re-run updates a second-precise timestamp |
| Brand | Wordmark/title/meta/favicon/mark injected; patching `NAME` alone renames every page with no stale text left |
| Gateway | Proxy streams incrementally with `X-Accel-Buffering: no`; 502 explains the fix; probe discovers and injects models; endpoint marker proves real serving; eval stats become the metrics; TTFT from request start; SSE `usage` honoured; dead endpoint surfaces in the transcript; demo mode works offline |

## 16. Pre-launch claim audit

Before publishing any of this externally, verify each claim against the deployed system:

- [ ] Provider contract or self-hosted configuration confirms **no training on inputs**, in writing.
- [ ] Data residency verified for **inference and embeddings**, including sub-processors.
- [ ] Retention windows actually delete records **and** vector-index chunks.
- [ ] DSAR export/delete path covers transcripts, uploads, chunks and embeddings.
- [ ] Transfer risk assessment / UK IDTA in place for anything crossing the UK–EU boundary.
- [ ] Audit log captures actor, workspace, model, checkpoint, timestamp and retention decision.
- [ ] Keys live in a secrets manager or OS keychain; rotation and revocation tested.
- [ ] Authentication sits in front of the UI (nginx `auth_request`, OIDC proxy, or an app tier) — the
      reference build ships none and must not be exposed without it.
- [ ] Latency targets measured under realistic concurrency, not a cold single-user box.
- [ ] Research/abliterated profiles are workspace-gated, tagged in the audit log, and never default.
- [ ] The page itself ships no trackers, analytics or third-party beacons.
