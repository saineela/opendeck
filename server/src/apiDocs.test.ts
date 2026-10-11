import { describe, expect, it } from "vitest";
import { markdownToHtml, renderApiDocsPage } from "./services/apiDocs.js";

describe("apiDocs markdown renderer", () => {
  it("renders headings with slugged ids, tables, and fenced code", () => {
    const { body, toc } = markdownToHtml(
      [
        "# OpenDeck API",
        "",
        "## `GET /api/history`",
        "",
        "Lists plays.",
        "",
        "| Field | Type |",
        "|---|---|",
        "| `plays` | array |",
        "",
        "```json",
        '{ "plays": [] }',
        "```",
      ].join("\n"),
    );

    expect(toc).toHaveLength(1);
    expect(toc[0]!.title).toBe("GET /api/history");
    expect(body).toContain("<h1>OpenDeck API</h1>");
    expect(body).toContain(`<h2 id="${toc[0]!.id}">`);
    expect(body).toContain("<table>");
    expect(body).toContain("<td><code>plays</code></td>");
    expect(body).toContain('<pre class="code" data-language="json"><code>{ &quot;plays&quot;: [] }</code></pre>');
  });

  it("escapes raw HTML and refuses unsafe link targets", () => {
    const { body } = markdownToHtml(
      '<img src=x onerror="alert(1)"> and [bad](javascript:alert(1)) and [ok](https://example.com)',
    );
    expect(body).not.toContain("<img");
    expect(body).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(body).not.toContain('href="javascript:');
    expect(body).toContain('href="https://example.com"');
  });

  it("groups lists and inline code without reformatting code spans", () => {
    const { body } = markdownToHtml("- one **bold**\n- `a|b` *em*\n\n1. first\n2. second");
    expect(body).toContain("<ul><li>one <strong>bold</strong></li><li><code>a|b</code> <em>em</em></li></ul>");
    expect(body).toContain("<ol><li>first</li><li>second</li></ol>");
  });

  it("joins wrapped list-item lines instead of splitting them mid-sentence", () => {
    // API.md's "Hardened headers" bullet wraps across two source lines. The
    // renderer used to close the <li> at the wrap and emit the remainder as a
    // stray paragraph, so the bullet read "…COOP," then "CORP, HSTS…".
    const { body } = markdownToHtml(
      [
        "- **Rate limiting** on every surface.",
        "- **Hardened headers** (CSP without third-party script origins, COOP,",
        "  CORP, HSTS, nosniff, frame-ancestors) on every response.",
        "- **Validation** on every input: bounded sizes.",
      ].join("\n"),
    );

    expect(body).toContain(
      "<li><strong>Hardened headers</strong> (CSP without third-party script origins, COOP, CORP, HSTS, nosniff, frame-ancestors) on every response.</li>",
    );
    expect(body).not.toContain("<p>CORP");
    expect((body.match(/<ul>/g) ?? []).length).toBe(1);
    expect((body.match(/<li>/g) ?? []).length).toBe(3);
  });

  it("joins wrapped ordered-list items too", () => {
    const { body } = markdownToHtml(
      ["1. First step that wraps", "   onto a second line.", "2. Second step."].join("\n"),
    );
    expect(body).toContain("<li>First step that wraps onto a second line.</li>");
    expect(body).toContain("<li>Second step.</li>");
  });

  it("stops a list at an unindented paragraph", () => {
    const { body } = markdownToHtml(
      ["- an item", "  continued", "", "a paragraph after."].join("\n"),
    );
    expect(body).toContain("<li>an item continued</li>");
    expect(body).toContain("<p>a paragraph after.</p>");
  });

  it("resolves companion documents to /docs/… instead of a dead link", () => {
    // Previously every relative target was neutered to href="#", so six links
    // on the reference page pointed nowhere.
    const { body } = markdownToHtml(
      "See [INTEGRATION.md](INTEGRATION.md), [openapi.yaml](openapi.yaml), "
        + "and [.env.example](.env.example).",
    );
    expect(body).not.toContain('href="#"');
    expect(body).toContain('<a href="/docs/INTEGRATION.md">INTEGRATION.md</a>');
    expect(body).toContain('<a href="/docs/openapi.yaml">openapi.yaml</a>');
    expect(body).toContain('<a href="/docs/.env.example">.env.example</a>');
  });

  it("renders an unresolvable relative link as text, never as a dead anchor", () => {
    // A traversal attempt matches the link syntax but is not a bare filename,
    // so it must not become an anchor (and must not escape the docs dir).
    const { body } = markdownToHtml("See [x](../etc/passwd). More.");
    expect(body).not.toContain("<a");
    expect(body).not.toContain("href");
    expect(body).toContain("See x. More.");
  });

  it("leaves a bracketed span that is not a link as literal text", () => {
    // The link regex requires a whitespace-free target, so this is not a link.
    const { body } = markdownToHtml("See [x](not a safe target). More.");
    expect(body).not.toContain("<a");
    expect(body).toContain("See [x](not a safe target). More.");
  });

  it("still allows absolute, in-page and mail links", () => {
    const { body } = markdownToHtml(
      "[ext](https://example.com/a) [anchor](#top) [mail](mailto:a@b.c) [rel](/api/auth)",
    );
    expect(body).toContain('<a href="https://example.com/a" rel="noreferrer">ext</a>');
    expect(body).toContain('<a href="#top">anchor</a>');
    expect(body).toContain('<a href="mailto:a@b.c">mail</a>');
    expect(body).toContain('<a href="/api/auth">rel</a>');
  });

  it("wraps rendered content in the public page shell", () => {
    const page = renderApiDocsPage("# Title\n\nBody text.");
    expect(page).toContain("<!doctype html>");
    expect(page).toContain("API reference contents");
    expect(page).toContain("<h1");
    expect(page).toContain("Body text.");
    expect(page).not.toContain("<script");
  });
});
