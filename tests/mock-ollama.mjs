/* ============================================================================
   tests/mock-ollama.mjs — a faithful stand-in for a real Ollama / vLLM host.

   Implements the four endpoints the workspace uses, with real incremental
   streaming (not one buffered write), so the integration test can prove that
   tokens arrive progressively through the proxy:

     GET  /api/tags               Ollama model list
     POST /api/chat               Ollama native ndjson stream + eval stats
     GET  /v1/models              OpenAI-compatible model list
     POST /v1/chat/completions    OpenAI-compatible SSE stream + usage

   Run standalone:  node tests/mock-ollama.mjs 11500
   ========================================================================== */

import http from "node:http";

export const OLLAMA_MARKER = "MOCK-OLLAMA-9F3C";
export const OPENAI_MARKER = "MOCK-OPENAI-7A21";

const MODELS = [
  {
    name: "qwen2.5:14b-instruct-q4_K_M",
    model: "qwen2.5:14b-instruct-q4_K_M",
    size: 9_100_000_000,
    details: { family: "qwen2", parameter_size: "14B", quantization_level: "Q4_K_M" },
  },
  {
    name: "qwen2.5:coder7b-q4_K_M",
    model: "qwen2.5:coder7b-q4_K_M",
    size: 4_700_000_000,
    details: { family: "qwen2", parameter_size: "7B", quantization_level: "Q4_K_M" },
  },
];

const CHUNKS = [
  "Read against the approved sources, ",
  "the indemnity cap is 12 months' fees ",
  "with confidentiality and IP carve-outs ",
  "sitting outside it. ",
  "The DPA omits a sub-processor notice window; ",
  "add 30 days plus an audit right. ",
  "Verification token: ",
];

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      try {
        resolve(JSON.parse(b || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startMock(port = 0) {
  const server = http.createServer(async (req, res) => {
    const url = (req.url || "").split("?")[0];

    if (url === "/api/tags" || url === "/v1/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ models: MODELS }));
    }

    if (url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ object: "list", data: MODELS.map((m) => ({ id: m.name, object: "model", owned_by: "library" })) })
      );
    }

    if (url === "/api/chat") {
      const body = await readBody(req);
      const userMsg = (body.messages || []).filter((m) => m.role === "user").pop();
      const echo = String(userMsg?.content || "").slice(0, 24);
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      });
      for (const c of CHUNKS) {
        res.write(
          JSON.stringify({
            model: body.model,
            created_at: new Date().toISOString(),
            message: { role: "assistant", content: c },
            done: false,
          }) + "\n"
        );
        await wait(18);
      }
      // marker + echo prove the request actually reached this endpoint
      res.write(
        JSON.stringify({
          model: body.model,
          message: { role: "assistant", content: `${OLLAMA_MARKER} prompt="${echo}"` },
          done: false,
        }) + "\n"
      );
      await wait(10);
      res.write(
        JSON.stringify({
          model: body.model,
          created_at: new Date().toISOString(),
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
          total_duration: 1_640_000_000,
          load_duration: 40_000_000,
          prompt_eval_count: 42,
          prompt_eval_duration: 260_000_000, // 260 ms prefill
          eval_count: 37,
          eval_duration: 1_200_000_000, // → 31 tok/s
        }) + "\n"
      );
      return res.end();
    }

    if (url === "/v1/chat/completions") {
      const body = await readBody(req);
      const userMsg = (body.messages || []).filter((m) => m.role === "user").pop();
      const echo = String(userMsg?.content || "").slice(0, 24);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const chunk = (content) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        })}\n\n`;
      for (const c of CHUNKS) {
        res.write(chunk(c));
        await wait(18);
      }
      res.write(chunk(`${OPENAI_MARKER} prompt="${echo}"`));
      await wait(10);
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 42, completion_tokens: 37, total_tokens: 79 },
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    if (url === "/__health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok");
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found: " + url } }));
  });

  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const address = server.address();
  return {
    server,
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

if (process.argv[1] && process.argv[1].endsWith("mock-ollama.mjs")) {
  const m = await startMock(Number(process.argv[2] || 11500));
  console.log(`mock ollama → ${m.baseUrl}  (tags, native chat, v1 models, v1 chat)`);
}
