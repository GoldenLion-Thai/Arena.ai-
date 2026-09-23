/* ============================================================================
   md.js — tiny, safe markdown-ish renderer for streamed chat output.
   Escapes everything first, then applies a small rule set. No innerHTML of
   unescaped user/model text ever reaches the DOM.
   ========================================================================== */

(function () {
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/_([^_\n]+)_/g, "<em>$1</em>");
  }

  function render(src) {
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
            .map((h) => `<th>${inline(h)}</th>`)
            .join("")}</tr></thead><tbody>${rows
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table></div>`
        );
        continue;
      }

      // headings
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        closeList();
        const lvl = Math.min(6, Math.max(4, h[1].length));
        out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
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
        out.push(`<li>${inline((ul || ol)[1])}</li>`);
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
      out.push(`<p style="margin:0 0 10px">${inline(line)}</p>`);
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
