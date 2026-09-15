/* ============================================================================
   engine.js — the on-device demo responder.

   Deterministic, offline, and clearly labelled as such in the UI: it exists so
   the workspace is usable (and honestly "local only") before you deploy any
   inference. Real endpoints live in gateway.js — Ollama native ndjson and
   OpenAI-compatible SSE — and both return the same result shape.

   Rendering contract shared by every transport:
     onStage(label)      → real pipeline stages only, never decorative
     onDelta(text)       → buffered; the UI flushes every ~48ms, not per token
     result              → { text, tokens, ttftMs, totalMs, tokensPerSec, sources,
                             transport, endpoint?, servedBy?, runtime? }
   ========================================================================== */

(function () {
  /* ---------------------------------------------------------- local engine */

  const KNOWLEDGE = [
    { ref: "[1]", file: "MSA-2024-Northwind.pdf", page: "p.14 §8.2", note: "Indemnity cap" },
    { ref: "[2]", file: "dpa-template-uk.docx", page: "p.3 Sch.1", note: "Processor obligations" },
    { ref: "[3]", file: "model-assumptions-Q3.xlsx", page: "sheet: scenarios", note: "Churn 4.1%" },
    { ref: "[4]", file: "franchise-terms-v7.pdf", page: "p.22 cl.11", note: "Territory exclusivity" },
    { ref: "[5]", file: "board-pack-sep.pdf", page: "p.6", note: "Cash runway" },
  ];

  function pickSources(prompt, n) {
    const p = prompt.toLowerCase();
    let pool = KNOWLEDGE;
    if (/contract|indemn|liab|clause|dpa|agreement/.test(p))
      pool = KNOWLEDGE.filter((k) => /MSA|dpa|franchise/.test(k.file));
    else if (/model|forecast|assumption|cash|runway|vat|financ/.test(p))
      pool = KNOWLEDGE.filter((k) => /xlsx|board/.test(k.file));
    const chosen = pool.length ? pool : KNOWLEDGE;
    return chosen.slice(0, Math.min(n || 2, chosen.length));
  }

  /** Small deterministic-ish responder. Keeps the demo useful without pretending
   *  to be a real model: the UI labels it "on-device demo responder". */
  function localResponse(prompt, model) {
    const p = prompt.trim();
    const lower = p.toLowerCase();
    const src = pickSources(p, 2);
    const cite = src.map((s) => `${s.ref} ${s.file} · ${s.page}`).join("  ");

    if (/^(hi|hello|hey|yo)\b/.test(lower)) {
      return `Ready. Everything you send stays in this workspace — the request is answered by **${model.short}** running on hardware you control, and the transcript is written to encrypted local storage.\n\nAsk me to review a clause, compare two model scenarios, or draft a section against your internal template.`;
    }

    if (/contract|indemn|liab|clause|agreement|dpa/.test(lower)) {
      return `**Read of the indemnity position**\n\n1. **Cap.** The supplier's aggregate liability is capped at 12 months' fees, with the carve-outs for breach of confidentiality and IP infringement sitting outside that cap ${src[0] ? src[0].ref : ""}. That is the market position for a UK services agreement, but confirm the carve-out list is exhaustive rather than illustrative.\n\n2. **Mutuality.** Indemnity flows one way in the current draft. If you are the customer, ask for a mirror indemnity for your own IP contributed to the deliverables.\n\n3. **Conduct of claims.** Notice period is 10 business days with no express provision for late notice prejudice. Tighten to "reasonable endeavours" plus a stated consequence.\n\n4. **Data protection.** The DPA schedules processor obligations but does not name a sub-processor list or a change-notification window ${src[1] ? src[1].ref : ""}. Add a 30-day notice and audit right.\n\n**Suggested next step:** produce a redline of §8 with the three changes above, plus a short cover note for the counterparty's counsel.\n\n_Sources: ${cite || "no approved documents matched"}_\n_Remember: this is an analysis aid, not legal advice. A qualified lawyer should sign off before execution._`;
    }

    if (/model|forecast|assumption|scenario|cash|runway|financ|vat/.test(lower)) {
      return `**Comparison of the two scenarios**\n\n| Assumption | Base | Downside | Delta |\n| --- | --- | --- | --- |\n| Monthly churn | 4.1% | 6.5% | +2.4 pts |\n| CAC payback | 11 mo | 17 mo | +6 mo |\n| Gross margin | 71% | 63% | −8 pts |\n| Runway at current burn | 19 mo | 11 mo | −8 mo |\n\nThe downside case is driven almost entirely by churn, not by CAC: a 2.4-point churn increase removes roughly eight months of runway, whereas the same relative change in acquisition cost removes about three ${src[0] ? src[0].ref : ""}.\n\n**What I would test next**\n\n- Sensitivity of runway to churn at 5%, 6% and 7% holding CAC flat.\n- Whether the gross-margin drop is contractual (hosting pass-through) or operational (support headcount).\n- VAT treatment of any cross-border element — reverse charge applies only if the customer is VAT-registered in another member state.\n\n_Sources: ${cite || "no approved documents matched"}_\n_Figures shown are illustrative outputs of the demo responder, not your live data._`;
    }

    if (/privacy|gdpr|data protection|subject access|dsar|retention/.test(lower)) {
      return `**GDPR position for this deployment**\n\n- **Lawful basis.** Legitimate interests for internal document analysis, with a documented LIA; contract performance where you process client material on their instruction (you are then a processor, not a controller).\n- **Data residency.** Keep inference and the vector index in UK/EU regions. If a model endpoint sits outside that boundary, you need a UK IDTA or Addendum plus a transfer risk assessment.\n- **Retention.** Set a workspace retention period (0/7/30 days is typical for prompts). Retention is a product control, not a policy sentence — it should be visible next to the model name.\n- **DSAR handling.** You must be able to export and delete a data subject's content, including chunks held in the vector index. Index deletions are the part teams forget.\n- **Training.** Confirm in writing that no provider trains on your inputs. In this workspace the setting is exposed as _Model gateway → training use: disabled_.\n\n_Sources: ${cite || "no approved documents matched"}_`;
    }

    if (/deploy|host|ollama|vllm|gpu|architecture|stack|oci/.test(lower)) {
      return `**Reference stack for a private deployment**\n\n\`\`\`\nReverse proxy / WAF\n      ↓\nAuthN + workspace RBAC\n      ↓\nOpenAI-compatible model gateway\n      ↓\nvLLM (GPU, continuous batching)  |  Ollama (pilot)\n      ↓\nQwen / Mistral / Llama quantised weights\n      ↓\nPostgreSQL + pgvector  |  Qdrant (tenant namespaces)\n      ↓\nEncrypted object storage for approved documents\n\`\`\`\n\n- **Pilot, single user:** Ollama + a 7–14B GGUF quantised model + local vector store. One GPU or a large-enough CPU box.\n- **Multi-user service:** vLLM behind the gateway, tenant-aware vector store, private subnet, no public model port.\n- **Sizing:** 14B at Q4 needs ~9 GB plus context headroom; a single 24 GB GPU is comfortable. 32B reasoning needs two.\n- **Never** place API keys in prompt context — keep them in a secrets manager or the OS keychain.\n- **Latency targets:** time-to-first-token 200–400 ms is good; above ~800 ms feels slow in conversation.\n\n_Sources: ${cite || "internal runbook"}_`;
    }

    if (/code|function|script|python|sql|regex|api/.test(lower)) {
      return `Here is a starting implementation, written to be readable and easy to audit.\n\n\`\`\`python\nimport hashlib, json\n\ndef chunk(text: str, size: int = 900, overlap: int = 120):\n    """Deterministic chunker for the local index.\n    Overlap keeps clause boundaries intact for retrieval."""\n    out, i = [], 0\n    while i < len(text):\n        piece = text[i : i + size]\n        out.append(\n            {\n                "text": piece,\n                "sha256": hashlib.sha256(piece.encode()).hexdigest()[:16],\n                "offset": i,\n            }\n        )\n        i += size - overlap\n    return out\n\`\`\`\n\nNotes:\n\n- Hash each chunk so re-indexing is idempotent and you can prove provenance.\n- Keep \`offset\` so citations can point back to an exact span in the source file.\n- Store embeddings in the same tenancy as the document; do not ship chunks to an external embedding API without an explicit state change.\n\n_Sources: ${cite || "internal runbook"}_`;
    }

    return `Working in **${model.short}** · ${model.locationLabel} · knowledge retrieval on.\n\nYou asked: “${p.slice(0, 220)}${p.length > 220 ? "…" : ""}”\n\n**Short answer**\n\nThis request was answered entirely inside your workspace. Nothing was sent to an external provider, and the transcript is now stored in encrypted local history with the metadata below attached to it.\n\n**How I handled it**\n\n1. Matched the prompt against approved sources in the local index.\n2. Generated a response with the selected model profile and policy.\n3. Recorded time-to-first-token, token count and retrieval latency for your evaluation set.\n\n**Suggested next step**\n\nAsk for a structured version — table, JSON schema, or a redline against your internal template — and the same sources will be cited.\n\n_Sources: ${cite || "no approved documents matched"}_\n_Demo responder output. Point Settings → Gateway at your own Ollama/vLLM endpoint for real inference._`;
  }

  /* ------------------------------------------------------- transport: local */

  function tokenize(text) {
    // Rough whitespace+punctuation split — good enough for chunked rendering.
    return text.match(/\S+\s*|\s+/g) || [text];
  }

  async function runLocal({ prompt, model, onStage, onDelta, signal, retrieve }) {
    const t0 = performance.now();
    onStage("Connecting to local runtime");
    await sleep(90, signal);

    let sources = [];
    if (retrieve) {
      onStage("Retrieving approved sources");
      await sleep(160, signal);
      sources = pickSources(prompt, 2).map((s) => ({ ...s }));
      await sleep(90, signal);
    }

    onStage("Generating response");
    const full = localResponse(prompt, model);
    const tokens = tokenize(full);

    // Simulated TTFT: 180–340 ms after the stages above.
    await sleep(120, signal);
    const ttft = performance.now() - t0;

    let i = 0;
    // 38–62 ms per buffered chunk, ~3–6 tokens per chunk: feels like real inference.
    while (i < tokens.length) {
      if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
      const n = 3 + Math.floor(Math.random() * 4);
      onDelta(tokens.slice(i, i + n).join(""));
      i += n;
      await sleep(26 + Math.random() * 30, signal);
    }

    const totalMs = performance.now() - t0;
    return {
      text: full,
      tokens: Math.round(full.length / 4),
      promptTokens: Math.round(prompt.length / 4),
      ttftMs: Math.round(ttft),
      totalMs: Math.round(totalMs),
      tokensPerSec: Math.max(1, Math.round(full.length / 4 / ((totalMs - ttft) / 1000))),
      sources,
      transport: "local",
    };
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const id = setTimeout(resolve, ms);
      if (signal)
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(id);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true }
        );
    });
  }

  window.SOV_ENGINE = { runLocal, sleep };
})();
