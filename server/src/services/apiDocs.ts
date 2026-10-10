/**
 * Renders `docs/API.md` as the public `/docs` page.
 *
 * The markdown is converted server-side to static HTML — no client script
 * (the app's CSP disallows inline scripts) and no dependencies. The renderer
 * covers the constructs API.md uses: headings, paragraphs, fenced code
 * blocks, tables, ordered/ordered lists, blockquotes, horizontal rules,
 * bold, inline code, and links. Every piece of content is HTML-escaped.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** GitHub-style heading ids, deduplicated. */
function slugify(text: string, used: Map<string, number>): string {
  const base = text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

/** Inline formatting: code spans are extracted first so nothing re-formats them. */
function inlineMarkdown(text: string): string {
  const codeSpans: string[] = [];
  let prepared = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  prepared = escapeHtml(prepared);
  // Bold before links so link labels can be bold.
  prepared = prepared.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  prepared = prepared.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
    const safeHref = /^(https?:\/\/|\/|#|mailto:)/.test(href) ? href : "#";
    const external = /^https?:\/\//.test(safeHref);
    return `<a href="${safeHref}"${external ? ' rel="noreferrer"' : ""}>${label}</a>`;
  });
  prepared = prepared.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");

  return prepared.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codeSpans[Number(index)]!);
}

function tableRowCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function markdownToHtml(markdown: string): { body: string; toc: Array<{ id: string; title: string }> } {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  const toc: Array<{ id: string; title: string }> = [];
  const slugs = new Map<string, number>();
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    if (!line.trim()) {
      index += 1;
      continue;
    }

    // Fenced code block.
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      const language = fence[1] || "text";
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      index += 1; // closing fence
      out.push(
        `<pre class="code" data-language="${escapeHtml(language)}"><code>${escapeHtml(body.join("\n"))}</code></pre>`,
      );
      continue;
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const rawTitle = heading[2]!.trim();
      const plainTitle = rawTitle.replace(/`/g, "");
      if (level >= 2 && level <= 3) {
        // h2/h3 drive the page TOC; the document h1 is the page title.
        const id = slugify(rawTitle, slugs);
        toc.push({ id, title: plainTitle });
        out.push(`<h${level} id="${id}">${inlineMarkdown(rawTitle)}</h${level}>`);
      } else {
        out.push(`<h${level}>${inlineMarkdown(rawTitle)}</h${level}>`);
      }
      index += 1;
      continue;
    }

    // Horizontal rule.
    if (/^-{3,}$/.test(line.trim())) {
      out.push("<hr />");
      index += 1;
      continue;
    }

    // Table.
    if (/^\|.*\|$/.test(line.trim()) && index + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[index + 1]!.trim())) {
      const headers = tableRowCells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && /^\|.*\|$/.test(lines[index]!.trim())) {
        rows.push(tableRowCells(lines[index]!));
        index += 1;
      }
      const head = headers.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("");
      const body = rows
        .map((cells) => `<tr>${cells.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<div class="tableWrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
      continue;
    }

    // Blockquote.
    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index]!)) {
        quoted.push(lines[index]!.replace(/^>\s?/, ""));
        index += 1;
      }
      out.push(`<blockquote><p>${inlineMarkdown(quoted.join(" "))}</p></blockquote>`);
      continue;
    }

    // Unordered list.
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index]!)) {
        items.push(`<li>${inlineMarkdown(lines[index]!.replace(/^[-*]\s+/, ""))}</li>`);
        index += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list.
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index]!)) {
        items.push(`<li>${inlineMarkdown(lines[index]!.replace(/^\d+\.\s+/, ""))}</li>`);
        index += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Paragraph: consume until blank line or a block starter.
    const paragraph: string[] = [];
    while (
      index < lines.length
      && lines[index]!.trim()
      && !/^(#{1,6}\s|```|\||>|[-*]\s|\d+\.\s|-{3,}$)/.test(lines[index]!)
    ) {
      paragraph.push(lines[index]!.trim());
      index += 1;
    }
    if (paragraph.length > 0) {
      out.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    } else {
      index += 1;
    }
  }

  return { body: out.join("\n"), toc };
}

const PAGE_STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  font-size: 15px;
  line-height: 1.6;
  background: #f6f8fb;
  color: #15171a;
}
a { color: #d7193f; text-decoration: none; }
a:hover { text-decoration: underline; }
header {
  border-bottom: 1px solid rgb(24 30 38 / 12%);
  background: #ffffff;
  padding: 18px 28px;
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex-wrap: wrap;
}
header .brand { font-weight: 700; font-size: 17px; color: #15171a; }
header .tag { color: #6b7482; font-size: 13px; }
header .back { margin-left: auto; font-size: 13px; font-weight: 600; }
.layout { display: flex; gap: 36px; max-width: 1240px; margin: 0 auto; padding: 28px; }
nav.toc {
  width: 250px; flex-shrink: 0; position: sticky; top: 20px; align-self: flex-start;
  max-height: calc(100vh - 40px); overflow: auto; font-size: 13px;
}
nav.toc h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7482; margin: 0 0 10px; }
nav.toc a { display: block; padding: 4px 8px; color: #566070; border-left: 2px solid transparent; }
nav.toc a:hover { color: #15171a; border-left-color: #d7193f; text-decoration: none; }
main { flex: 1; min-width: 0; background: #ffffff; border: 1px solid rgb(24 30 38 / 12%); border-radius: 14px; padding: 30px 36px; }
h1 { font-size: 28px; margin: 0 0 12px; letter-spacing: -0.02em; }
h2 { font-size: 21px; margin: 38px 0 12px; padding-top: 18px; border-top: 1px solid rgb(24 30 38 / 10%); letter-spacing: -0.01em; }
h2:first-child, h3:first-child { border-top: 0; padding-top: 0; }
h3 { font-size: 17px; margin: 26px 0 10px; }
h4 { font-size: 15px; margin: 20px 0 8px; }
p { margin: 10px 0; color: #33383f; }
li { color: #33383f; }
ul, ol { padding-left: 22px; margin: 10px 0; }
hr { border: 0; border-top: 1px solid rgb(24 30 38 / 12%); margin: 26px 0; }
code {
  font-family: ui-monospace, 'Cascadia Code', 'JetBrains Mono', Consolas, monospace;
  font-size: 12.5px;
  background: rgb(24 30 38 / 7%);
  border-radius: 5px;
  padding: 1.5px 5px;
}
pre.code {
  background: #0f1115;
  color: #e8e8ec;
  border-radius: 10px;
  padding: 16px 18px;
  overflow-x: auto;
  font-size: 12.5px;
  line-height: 1.55;
}
pre.code code { background: none; padding: 0; color: inherit; font-size: inherit; }
pre.code::before {
  content: attr(data-language);
  display: block;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: rgb(232 232 236 / 45%);
  margin-bottom: 8px;
}
.tableWrap { overflow-x: auto; margin: 12px 0; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
th, td { border: 1px solid rgb(24 30 38 / 12%); padding: 7px 11px; text-align: left; vertical-align: top; }
th { background: rgb(24 30 38 / 4%); font-weight: 600; }
blockquote { margin: 12px 0; padding: 8px 16px; border-left: 3px solid #d7193f; background: rgb(215 25 63 / 5%); border-radius: 0 8px 8px 0; }
blockquote p { margin: 0; }
@media (max-width: 900px) { nav.toc { display: none; } main { padding: 22px 18px; } }
@media (prefers-color-scheme: dark) {
  body { background: #0a0b0e; color: #e9eaee; }
  header { background: #101216; border-bottom-color: rgb(255 255 255 / 10%); }
  header .brand { color: #f4f5f7; }
  header .tag { color: #8b94a3; }
  main { background: #101216; border-color: rgb(255 255 255 / 10%); }
  h2 { border-top-color: rgb(255 255 255 / 10%); }
  p, li { color: #c3c8d1; }
  code { background: rgb(255 255 255 / 8%); }
  th, td { border-color: rgb(255 255 255 / 12%); }
  th { background: rgb(255 255 255 / 5%); }
  nav.toc a { color: #8b94a3; }
  nav.toc a:hover { color: #f4f5f7; }
}
`.trim();

/** Wraps rendered markdown in the public documentation page. */
export function renderApiDocsPage(markdown: string): string {
  const { body, toc } = markdownToHtml(markdown);
  const tocHtml = toc
    .map((entry) => `<a href="#${entry.id}">${escapeHtml(entry.title)}</a>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>OpenDeck API reference</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <header>
    <span class="brand">OpenDeck API</span>
    <span class="tag">Complete HTTP reference — endpoints, auth, rate limits, and examples</span>
    <a class="back" href="/">← Back to OpenDeck</a>
  </header>
  <div class="layout">
    <nav class="toc" aria-label="API reference contents">
      <h2>Contents</h2>
      ${tocHtml}
    </nav>
    <main>
${body}
    </main>
  </div>
</body>
</html>`;
}
