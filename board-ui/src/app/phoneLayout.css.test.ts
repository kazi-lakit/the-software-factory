import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tokens } from "../test/cssTokens";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "board.css"), "utf8");

describe("phone layout tokens", () => {
  it("defines the phone tokens", () => {
    const root = tokens(css, ":root");
    expect(root["--sf-tabbar-height"]).toBe("56px");
    expect(root["--sf-actionbar-button"]).toBe("48px");
    expect(root["--sf-input-height"]).toBe("44px");
    expect(root["--sf-input-font"]).toBe("16px");
    expect(root["--sf-bar-height"]).toBe("52px");
  });
});
