import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

afterEach(cleanup);

describe("Markdown", () => {
  it("renders_headings_lists_code_and_links", () => {
    const body = "## Scope\n\n- one\n- two\n\nUse `npm test`.\n\n[docs](https://example.com)";
    const { container } = render(<Markdown body={body} />);
    expect(screen.getByRole("heading", { level: 2, name: "Scope" })).toBeInTheDocument();
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(2);
    expect(container.querySelector("code")?.textContent).toBe("npm test");
    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("href", "https://example.com");
    expect(container.firstElementChild).toHaveClass("sf-markdown");
    expect(container.querySelector("pre")).toBeNull();
  });

  it("does_not_render_raw_html", () => {
    const body = "<script>alert(1)</script>\n\n<img src=x onerror=\"alert(1)\">\n\n<b>bold</b>";
    const { container } = render(<Markdown body={body} />);
    expect(container.querySelector("script, img, b, [onerror]")).toBeNull();
  });

  it("drops_javascript_links", () => {
    const { container } = render(<Markdown body="[x](javascript:alert(1))" />);
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});
