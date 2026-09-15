/* ============================================================================
   brand.js — the ONE place the brand lives.

   To rename this product: change `NAME` (and optionally `MARK`) below.
   Every page title, meta description, wordmark, logo mark and favicon is
   derived from this file at load. Body marketing copy stays in the pages,
   because copy should be edited as copy — but nothing *identifying* does.

   Nothing here phones home. No analytics, no beacons, no third-party calls.
   ========================================================================== */

(function () {
  /* ---------------------------------------------------------------- rename */

  const NAME = "Sovereign"; // ← the product name
  // Derived from NAME so a rename really is one constant. Override explicitly
  // only if the trading name differs from the product name.
  const LEGAL_NAME = `${NAME} Private AI`; // ← contracts, footer, invoices
  const SHORT = "SOV"; // ← prefixes, storage keys, log tags
  const SLUG = NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-"); // ← CLI text, filenames
  const TAGLINE = "Private intelligence, on your terms.";
  const POSITIONING = "Your AI. Your server. Your data.";
  const DESCRIPTION =
    "Run capable language models inside infrastructure you control. Private document intelligence, inspectable data boundaries, and governance by design.";

  /* The logo mark: one SVG, drawn once, injected everywhere.
     Swap this string to rebrand the mark without touching a single page. */
  const MARK = `<svg viewBox="0 0 32 32" width="20" height="20" role="img" aria-label="${NAME}">
    <rect width="32" height="32" rx="9" fill="#0b0e14"/>
    <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="8.25" fill="none" stroke="#2b3648"/>
    <circle cx="16" cy="16" r="8.6" fill="#c8ff3d"/>
    <circle cx="19.4" cy="13.2" r="6.1" fill="#0b0e14"/>
    <circle cx="16" cy="16" r="2.05" fill="#c8ff3d"/>
  </svg>`;

  /* ------------------------------------------------------------- injection */

  const TITLES = {
    "index.html": `${NAME} — ${TAGLINE}`,
    "app.html": `${NAME} — Private workspace`,
    "lab.html": `Behaviour Lab — ${NAME}`,
  };

  function faviconHref() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#090b10"/><circle cx="16" cy="16" r="8" fill="#c8ff3d"/><circle cx="19" cy="13.5" r="5.6" fill="#090b10"/></svg>`;
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }

  function apply() {
    const page = (location.pathname.split("/").pop() || "index.html").toLowerCase();

    // document title
    if (TITLES[page]) document.title = TITLES[page];

    // meta description
    const meta = document.querySelector('meta[name="description"]');
    if (meta && !meta.dataset.keep) meta.setAttribute("content", DESCRIPTION);

    // favicon
    const icon = document.querySelector('link[rel="icon"]');
    if (icon) icon.setAttribute("href", faviconHref());

    // wordmarks and copy slots
    document.querySelectorAll("[data-brand]").forEach((el) => {
      const slot = el.dataset.brand;
      const value = {
        name: NAME,
        legal: LEGAL_NAME,
        short: SHORT,
        slug: SLUG,
        tagline: TAGLINE,
        positioning: POSITIONING,
        year: new Date().getFullYear(),
      }[slot];
      if (value != null) el.textContent = String(value);
    });

    // logo marks
    document.querySelectorAll("[data-brand-mark], .brand__mark").forEach((el) => {
      el.innerHTML = MARK;
      el.style.background = "none";
      el.style.boxShadow = "none";
    });

    // aria labels that mention the product
    document.querySelectorAll("[data-brand-aria]").forEach((el) =>
      el.setAttribute("aria-label", el.dataset.brandAria.replace("{name}", NAME))
    );
  }

  window.SOV_BRAND = { NAME, LEGAL_NAME, SHORT, SLUG, TAGLINE, POSITIONING, DESCRIPTION, MARK, apply };

  // Run as early as possible, and again on DOMContentLoaded for late pages.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply, { once: true });
  else apply();
})();
