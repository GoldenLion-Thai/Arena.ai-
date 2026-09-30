/* ============================================================================
   landing.js — hero terminal, live theme switcher, scroll reveal.
   No trackers, no analytics, no third-party requests: the "privacy" claim on
   the page has to survive inspection of the page itself.
   ========================================================================== */

(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ------------------------------------------------------------- themes */

  const THEMES = {
    midnight: {
      note: "Midnight Vault — legal, finance, enterprise private cloud",
      tokens: {},
      swatches: [
        ["Canvas", "#090B10", "App background"],
        ["Surface", "#121722", "Panels, composer"],
        ["Elevated", "#1A2230", "Menus, hover cards"],
        ["Text", "#F4F7FB", "Headings, main copy"],
        ["Secondary", "#9CA9BA", "Metadata"],
        ["Action", "#78A6FF", "Primary CTA, focus"],
        ["Verified", "#70E0B5", "Local-only confirmation"],
        ["Warning", "#FFC857", "External / shared state"],
        ["Accent", "#C8FF3D", "Reserved: local, streaming"],
      ],
    },
    obsidian: {
      note: "Obsidian + Acid Lime — Venice-adjacent, developer-led, assertive",
      tokens: {
        "--canvas": "#0a0a0a",
        "--canvas-deep": "#050505",
        "--surface": "#151515",
        "--surface-2": "#1c1c1c",
        "--surface-3": "#242424",
        "--border": "#2a2a2a",
        "--border-strong": "#3b3b3b",
        "--text": "#f5f5f0",
        "--text-2": "#929292",
        "--text-3": "#6d6d6d",
        "--accent": "#c8ff3d",
        "--accent-dim": "#9dc92c",
        "--accent-ink": "#0a0f04",
        "--action": "#d9ff8f",
        "--verified": "#57d9a3",
        "--warning": "#ffb84d",
        "--danger": "#ff6b72",
      },
      swatches: [
        ["Canvas", "#0A0A0A", "Background"],
        ["Surface", "#151515", "UI containers"],
        ["Border", "#2A2A2A", "Dividers"],
        ["Text", "#F5F5F0", "Main content"],
        ["Muted", "#929292", "Supporting copy"],
        ["Accent", "#C8FF3D", "CTA, active model, cursor"],
        ["Verified", "#57D9A3", "Secure local state"],
        ["Caution", "#FFB84D", "External endpoint"],
        ["Danger", "#FF6B72", "Delete, cloud risk"],
      ],
    },
    navy: {
      note: "Deep Navy + Cyan — credible security platform, more polish",
      tokens: {
        "--canvas": "#07111f",
        "--canvas-deep": "#040a13",
        "--surface": "#0e1b2d",
        "--surface-2": "#152942",
        "--surface-3": "#1d3554",
        "--border": "#16283f",
        "--border-strong": "#25425f",
        "--text": "#e9f4ff",
        "--text-2": "#91a5bc",
        "--text-3": "#64798f",
        "--accent": "#54d7ff",
        "--accent-dim": "#3fa9cc",
        "--accent-ink": "#04121c",
        "--action": "#78a6ff",
        "--verified": "#69e6af",
        "--warning": "#ffb45b",
        "--danger": "#ff7a80",
      },
      swatches: [
        ["Canvas", "#07111F", "Background"],
        ["Surface", "#0E1B2D", "Cards and input"],
        ["Surface 2", "#152942", "Menus, selected rows"],
        ["Text", "#E9F4FF", "Main text"],
        ["Accent", "#54D7FF", "CTAs, selected items"],
        ["Privacy", "#69E6AF", "Local / verified"],
        ["Muted", "#91A5BC", "Supporting content"],
        ["Alert", "#FFB45B", "Data-boundary changes"],
        ["Action", "#78A6FF", "Focus, links"],
      ],
    },
  };

  function applyTheme(id) {
    const t = THEMES[id] || THEMES.midnight;
    const root = document.documentElement;
    // clear previously applied overrides
    Object.keys(THEMES).forEach((k) =>
      Object.keys(THEMES[k].tokens).forEach((p) => root.style.removeProperty(p))
    );
    Object.entries(t.tokens).forEach(([p, v]) => root.style.setProperty(p, v));
    $("#themeNote").textContent = t.note;
    $$("[data-theme]").forEach((b) => {
      const active = b.dataset.theme === id;
      b.classList.toggle("btn--ghost", !active);
    });
    renderSwatches(t.swatches);
    try {
      localStorage.setItem("grid:theme", id);
    } catch {}
  }

  function renderSwatches(list) {
    const host = $("#swatches");
    if (!host) return;
    host.innerHTML = list
      .map(
        ([name, hex, use]) => `<div class="card" style="padding:14px">
          <div style="height:52px;border-radius:8px;background:${hex};border:1px solid var(--border-strong);margin-bottom:12px"></div>
          <div class="row-between"><b style="font-size:13.5px">${name}</b><span class="mono" style="text-transform:none;letter-spacing:0.02em">${hex}</span></div>
          <div class="dim" style="font-size:12px;margin-top:4px">${use}</div>
        </div>`
      )
      .join("");
  }

  /* ------------------------------------------------------------ terminal */

  const CLI = (window.GRID_BRAND && window.GRID_BRAND.CLI) || "grid-os";

  const SCRIPT = [
    { t: "type", cls: "prompt", text: `$ ${CLI} status` },
    { t: "line", text: "◉ runtime    ollama 0.5.x · qwen2.5:14b-instruct-q4_K_M", cls: "ok" },
    { t: "line", text: "◉ location   this device · no egress · UK-EU-WEST" },
    { t: "line", text: "◉ vault      AES-GCM 256 · PBKDF2 210k · unlocked", cls: "ok" },
    { t: "line", text: "◉ index      412 chunks · pgvector (local) · 6 sources" },
    { t: "line", text: "" },
    { t: "type", cls: "prompt", text: `$ ${CLI} ask "compare the indemnity caps in MSA-2024 and the DPA"` },
    { t: "line", text: "⟳ retrieving approved sources … 2 matches", cls: "flag" },
    { t: "line", text: "⟳ generating … ttft 286 ms · 41 tok/s · 0 external calls", cls: "flag" },
    { t: "line", text: "› MSA-2024 caps aggregate liability at 12 months' fees, with" },
    { t: "line", text: "› confidentiality and IP carve-outs sitting outside the cap [1]." },
    { t: "line", text: "› The DPA schedules processor obligations but omits a" },
    { t: "line", text: "› sub-processor notice window — add 30 days plus audit right [2]." },
    { t: "line", text: "" },
    { t: "type", cls: "prompt", text: `$ ${CLI} egress --check --last 24h` },
    { t: "line", text: "✓ 0 external requests · 0 telemetry events · 0 training uploads", cls: "ok" },
  ];

  async function runTerminal() {
    const host = $("#term");
    if (!host) return;

    if (reduce) {
      host.innerHTML = SCRIPT.map((s) => `<div class="mock__line"><span class="${s.cls || ""}">${escapeHtml(s.text)}</span></div>`).join("");
      return;
    }

    while (true) {
      host.innerHTML = "";
      for (const step of SCRIPT) {
        const div = document.createElement("div");
        div.className = "mock__line";
        const span = document.createElement("span");
        if (step.cls) span.className = step.cls;
        div.appendChild(span);
        host.appendChild(div);

        if (step.t === "type") {
          for (let i = 0; i < step.text.length; i++) {
            span.textContent = step.text.slice(0, i + 1);
            await wait(11 + Math.random() * 22);
          }
          await wait(260);
        } else {
          span.textContent = step.text || "\u00a0";
          await wait(step.text ? 130 : 60);
        }
      }
      const caret = document.createElement("div");
      caret.className = "mock__line";
      caret.innerHTML = '<span class="prompt">$ </span><span class="caret"></span>';
      host.appendChild(caret);
      await wait(4200);
    }
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* -------------------------------------------------------------- reveal */

  function initReveal() {
    if (reduce || !("IntersectionObserver" in window)) return;
    const targets = $$(".card, .step, .node, .table-wrap, .section-head, .mock");
    targets.forEach((el, i) => {
      el.style.opacity = "0";
      el.style.transform = "translateY(10px)";
      el.style.transition = "opacity 520ms cubic-bezier(.22,.61,.36,1), transform 520ms cubic-bezier(.22,.61,.36,1)";
      el.style.transitionDelay = Math.min(i % 8, 6) * 45 + "ms";
    });
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.style.opacity = "1";
            e.target.style.transform = "none";
            io.unobserve(e.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.06 }
    );
    targets.forEach((el) => io.observe(el));
  }

  /* ---------------------------------------------------------------- boot */

  let booted = false;
  document.addEventListener("DOMContentLoaded", () => {
    if (booted) return;
    booted = true;
    let saved = "midnight";
    try {
      saved = localStorage.getItem("grid:theme") || "midnight";
    } catch {}
    applyTheme(saved);

    $$("[data-theme]").forEach((b) => b.addEventListener("click", () => applyTheme(b.dataset.theme)));

    initReveal();
    runTerminal();

    // Smooth in-page anchors without hijacking cross-page links
    $$('a[href^="#"]').forEach((a) =>
      a.addEventListener("click", (e) => {
        const id = a.getAttribute("href").slice(1);
        const target = id && document.getElementById(id);
        if (!target) return;
        e.preventDefault();
        target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
        history.replaceState(null, "", "#" + id);
      })
    );
  });
})();
