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

  it("wraps rendered content in the public page shell", () => {
    const page = renderApiDocsPage("# Title\n\nBody text.");
    expect(page).toContain("<!doctype html>");
    expect(page).toContain("API reference contents");
    expect(page).toContain("<h1");
    expect(page).toContain("Body text.");
    expect(page).not.toContain("<script");
  });
});
