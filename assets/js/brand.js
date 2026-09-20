/* ============================================================================
   brand.js — the ONE place the brand lives.

   To rename this product: change `NAME` (and optionally `MARK`) below.
   Legal name, compact wordmark, CLI slug, page titles, meta description,
   favicon and every logo mark are derived from it at load.

   Nothing here phones home. No analytics, no beacons, no third-party calls.
   ========================================================================== */

(function () {
  /* ---------------------------------------------------------------- rename */

  const NAME = "GRiD-OS-SOVEREIGN"; // ← the product name
  const SHORT = "GRiD"; // ← prefixes, log tags, tight UI corners
  const TAGLINE = "Private intelligence, on your terms.";
  const POSITIONING = "Your AI. Your grid. Your data.";
  const DESCRIPTION =
    "GRiD-OS-SOVEREIGN runs capable open-weight language models inside infrastructure you control: encrypted local-first history, an inspectable data boundary, retrieval over approved sources only, and governance you can audit.";

  /* Derived — a rename really is one constant. */
  const LEGAL_NAME = `${NAME} Private AI`; // contracts, footer, invoices
  const COMPACT = NAME.includes("-") ? NAME.split("-").slice(0, 2).join("-") : NAME; // top bar on small screens
  const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const SLUG = slugify(NAME); // filenames, storage keys
  const CLI = slugify(COMPACT); // the command name in terminal copy

  /* The logo mark: one SVG, drawn once, injected everywhere.
     A mesh of nodes with one sealed at the centre — your grid, your private
     node. Swap this string to rebrand the mark without touching a page. */
  const MARK = `<svg viewBox="0 0 32 32" width="20" height="20" role="img" aria-label="${NAME}">
    <rect width="32" height="32" rx="9" fill="#0b0e14"/>
    <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="8.25" fill="none" stroke="#2b3648"/>
    <g stroke="#2f3b4f" stroke-width="1">
      <path d="M9 9h14M9 16h14M9 23h14M9 9v14M16 9v14M23 9v14"/>
    </g>
    <g fill="#46546b">
      <circle cx="9" cy="9" r="1.5"/><circle cx="23" cy="9" r="1.5"/>
      <circle cx="9" cy="23" r="1.5"/><circle cx="23" cy="23" r="1.5"/>
      <circle cx="16" cy="9" r="1.3"/><circle cx="9" cy="16" r="1.3"/>
      <circle cx="23" cy="16" r="1.3"/><circle cx="16" cy="23" r="1.3"/>
    </g>
    <circle cx="16" cy="16" r="5.6" fill="#0b0e14"/>
    <circle cx="16" cy="16" r="4.9" fill="none" stroke="#c8ff3d" stroke-width="1.7"/>
    <circle cx="16" cy="16" r="1.9" fill="#c8ff3d"/>
  </svg>`;

  /* ------------------------------------------------------------- injection */

  const TITLES = {
    "index.html": `${NAME} — ${TAGLINE}`,
    "app.html": `${NAME} — Private workspace`,
    "lab.html": `Behaviour Lab — ${NAME}`,
  };

  const SLOTS = {
    name: NAME,
    legal: LEGAL_NAME,
    compact: COMPACT,
    short: SHORT,
    slug: SLUG,
    cli: CLI,
    tagline: TAGLINE,
    positioning: POSITIONING,
  };

  function faviconHref() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#090b10"/><g stroke="#2f3b4f"><path d="M9 9h14M9 23h14M9 9v14M23 9v14"/></g><circle cx="16" cy="16" r="6" fill="#090b10"/><circle cx="16" cy="16" r="5" fill="none" stroke="#c8ff3d" stroke-width="2"/><circle cx="16" cy="16" r="2" fill="#c8ff3d"/></svg>`;
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }

  function apply() {
    const page = (location.pathname.split("/").pop() || "index.html").toLowerCase();

    if (TITLES[page]) document.title = TITLES[page];

    const meta = document.querySelector('meta[name="description"]');
    if (meta && !meta.dataset.keep) meta.setAttribute("content", DESCRIPTION);

    const icon = document.querySelector('link[rel="icon"]');
    if (icon) icon.setAttribute("href", faviconHref());

    document.querySelectorAll("[data-brand]").forEach((el) => {
      const value = el.dataset.brand === "year" ? new Date().getFullYear() : SLOTS[el.dataset.brand];
      if (value != null) el.textContent = String(value);
    });

    document.querySelectorAll("[data-brand-mark], .brand__mark").forEach((el) => {
      el.innerHTML = MARK;
      el.style.background = "none";
      el.style.boxShadow = "none";
    });

    document.querySelectorAll("[data-brand-aria]").forEach((el) =>
      el.setAttribute("aria-label", el.dataset.brandAria.replace("{name}", NAME))
    );
  }

  window.GRID_BRAND = Object.assign({ NAME, LEGAL_NAME, COMPACT, SHORT, SLUG, CLI, TAGLINE, POSITIONING, DESCRIPTION, MARK, apply }, SLOTS);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply, { once: true });
  else apply();
})();
