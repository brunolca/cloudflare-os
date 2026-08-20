// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownMessage } from "./ChatInterface";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MarkdownMessage line breaks", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    vi.unstubAllGlobals();
  });

  async function render(message: string) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(MarkdownMessage, { message })));
  }

  // The user-message fix relies on Markdown preserving a single newline as a literal "\n"
  // in the DOM, so the `whitespace-pre-wrap` wrapper renders it as a hard line break. If a
  // dependency upgrade (react-markdown / remark-gfm) ever collapsed it to a space, the
  // visual fix would silently break; this test guards that invariant.
  it("preserves a single newline within a paragraph as a literal newline", async () => {
    await render("line one\nline two");

    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs.length).toBe(1);
    expect(paragraphs[0].textContent).toBe("line one\nline two");
  });

  it("still renders a blank line as a paragraph break (two <p>)", async () => {
    await render("para one\n\npara two");

    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs.length).toBe(2);
    expect(paragraphs[0].textContent).toBe("para one");
    expect(paragraphs[1].textContent).toBe("para two");
  });

  it("copies fenced code without the Markdown trailing newline", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await render("```ts\nconst answer = 42;\n```");

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy code"]',
    );
    expect(button?.title).toBe("Copy code");

    await act(async () => button?.click());

    expect(writeText).toHaveBeenCalledWith("const answer = 42;");
  });
});

describe("MarkdownMessage flint chart blocks", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
  });

  async function render(message: string) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(MarkdownMessage, { message })));
  }

  const SPEC = JSON.stringify({
    data: { values: [{ a: "x", b: 1 }] },
    semantic_types: { a: "Category", b: "Count" },
    chart_spec: { chartType: "Bar Chart", encodings: { x: { field: "a" }, y: { field: "b" } } },
  }, null, 2);

  // The chart replaces the whole <pre>: nesting a chart inside one would inherit its monospace,
  // whitespace, and scrolling. jsdom has no layout, so the chart never renders here -- what this
  // pins down is the routing, not the drawing.
  it("routes a flint block away from <pre> and into the chart container", async () => {
    await render("Here you go:\n\n```flint\n" + SPEC + "\n```\n");

    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector('[role="img"]')).not.toBeNull();
  });

  it("leaves other fenced code blocks as <pre>", async () => {
    await render("```js\nconst a = 1;\n```\n");

    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("const a = 1;");
    expect(container.querySelector('[role="img"]')).toBeNull();
  });

  it("leaves an unlabelled fenced block as <pre>", async () => {
    await render("```\n" + SPEC + "\n```\n");

    expect(container.querySelector("pre")).not.toBeNull();
    expect(container.querySelector('[role="img"]')).toBeNull();
  });

  // A malformed spec must degrade to something the user can still read and quote back, rather
  // than throwing inside the message and taking the whole conversation down with it.
  it("shows a readable fallback for a spec that is complete but wrong", async () => {
    await render('```flint\n{"data": {"values": []}}\n```\n');

    expect(container.textContent).toContain("data rows");
    expect(container.querySelector("pre")).not.toBeNull();
  });
});
