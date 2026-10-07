/* ============================================================================
   md.js — tiny, safe markdown-ish renderer for streamed chat output.
   Escapes everything first, then applies a small rule set. No innerHTML of
   unescaped user/model text ever reaches the DOM.
   ========================================================================== */

(function () {
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  /* Links are opt-in (opts.links) and scheme-allowlisted. The chat renderer has
     never emitted anchors and its output must not change; a wiki page is a
     document, so it asks for real headings and real links. */
  const SAFE_HREF = /^(https?:|mailto:|#|\/)/i;

  function links(s) {
    return s
      // [[slug]] or [[slug|label]] — the platform's own wiki link syntax
      .replace(/\[\[([^\]|#]+)(?:[|#]([^\]]*))?\]\]/g, (_, slug, label) => {
        const id = slug.trim();
        return `<a class="wikilink" data-slug="${id}" href="#wiki:${id}">${(label || id).trim()}</a>`;
      })
      // [text](href) — wiki: and /wiki/ become internal links, http(s)/mailto open out
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) => {
        if (/^(#?wiki:)/i.test(href)) {
          const id = href.replace(/^(#?wiki:)/i, "").replace(/&amp;/g, "&");
          return `<a class="wikilink" data-slug="${id}" href="#wiki:${id}">${text}</a>`;
        }
        if (!SAFE_HREF.test(href.replace(/&amp;/g, "&"))) return m; // javascript: and friends stay text
        return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      })
      // a bare /wiki/slug in prose is a link too, matching platform/wiki.mjs extractLinks
      .replace(/(^|[\s(])\/wiki\/([\w\-/]+)/g, (_, pre, id) => `${pre}<a class="wikilink" data-slug="${id}" href="#wiki:${id}">/wiki/${id}</a>`);
  }

  function inline(s, opts) {
    const out = s
      .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/_([^_\n]+)_/g, "<em>$1</em>");
    return opts && opts.links ? links(out) : out;
  }

  /**
   * @param {string} src markdown-ish source
   * @param {{documentHeadings?:boolean, links?:boolean}} [opts]
   *   documentHeadings  map # → h1 … ###### → h6 (a document). The default
   *                     clamps to h4–h6, which suits a chat bubble.
   *   links             render [text](href) and [[slug]] as anchors
   */
  function render(src, opts) {
    const lines = escape(src || "").split("\n");
    const out = [];
    let i = 0;
    let list = null;

    const closeList = () => {
      if (list) {
        out.push(`</${list}>`);
        list = null;
      }
    };

    while (i < lines.length) {
      const line = lines[i];

      // fenced code
      if (/^```/.test(line.trim())) {
        closeList();
        const lang = line.trim().slice(3).trim();
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i].trim())) buf.push(lines[i++]);
        i++; // closing fence
        out.push(
          `<pre${lang ? ` data-lang="${lang}"` : ""}><code>${buf.join("\n") || "&nbsp;"}</code></pre>`
        );
        continue;
      }

      // pipe table
      if (/^\s*\|.*\|\s*$/.test(line) && /\|[\s:-]+\|/.test(lines[i + 1] || "")) {
        closeList();
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push(
          `<div class="table-wrap" style="margin:12px 0"><table><thead><tr>${head
            .map((h) => `<th>${inline(h, opts)}</th>`)
            .join("")}</tr></thead><tbody>${rows
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c, opts)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table></div>`
        );
        continue;
      }

      // headings
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        closeList();
        const floor = opts && opts.documentHeadings ? 1 : 4; // chat bubbles never want an h1
        const lvl = Math.min(6, Math.max(floor, h[1].length));
        out.push(`<h${lvl}>${inline(h[2], opts)}</h${lvl}>`);
        i++;
        continue;
      }

      // ordered / unordered list
      const ul = line.match(/^\s*[-*•]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        const want = ul ? "ul" : "ol";
        if (list !== want) {
          closeList();
          out.push(`<${want}>`);
          list = want;
        }
        out.push(`<li>${inline((ul || ol)[1], opts)}</li>`);
        i++;
        continue;
      }

      // horizontal rule
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        closeList();
        out.push('<hr style="border:0;border-top:1px solid var(--border);margin:16px 0">');
        i++;
        continue;
      }

      // blank
      if (!line.trim()) {
        closeList();
        i++;
        continue;
      }

      closeList();
      out.push(`<p style="margin:0 0 10px">${inline(line, opts)}</p>`);
      i++;
    }
    closeList();
    return out.join("");
  }

  function cells(line) {
    return line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  }

  window.GRID_MD = { render, escape };
})();
