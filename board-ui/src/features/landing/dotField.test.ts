import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOT_ALPHA_MAX, DOT_RGB, PULSE_PERIOD_MS, buildDots, pulse, seededRng, stepDrift } from "./dotField";

describe("dot field", () => {
  it("dot_colours_are_green_in_dark_and_dark_in_light", () => {
    expect(DOT_RGB.dark).toEqual([92, 205, 160]);
    expect(DOT_RGB.light).toEqual([11, 17, 18]);
  });

  it("max_alpha_is_low_in_both_themes", () => {
    expect(DOT_ALPHA_MAX.dark).toBeGreaterThan(0);
    expect(DOT_ALPHA_MAX.dark).toBeLessThanOrEqual(0.2);
    expect(DOT_ALPHA_MAX.light).toBeGreaterThan(0);
    expect(DOT_ALPHA_MAX.light).toBeLessThanOrEqual(0.1);
  });

  it("pulse_has_a_six_second_period", () => {
    expect(PULSE_PERIOD_MS).toBe(6000);
    for (const t of [0, 1234, 4000]) expect(pulse(t)).toBeCloseTo(pulse(t + 6000), 6);
    expect(Math.abs(pulse(0) - pulse(3000))).toBeGreaterThan(0.01);
    for (const t of [0, 750, 1500, 3000, 4500, 5999, 12345]) {
      expect(pulse(t)).toBeGreaterThanOrEqual(0);
      expect(pulse(t)).toBeLessThanOrEqual(1);
    }
  });

  it("build_dots_is_sparse_and_carries_depth", () => {
    const dots = buildDots(800, 600, 24, seededRng(1));
    expect(dots).toBeInstanceOf(Float32Array);
    expect(dots.length % 3).toBe(0);
    const count = dots.length / 3;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan((Math.ceil(800 / 24) * Math.ceil(600 / 24)) / 2);
    for (let i = 2; i < dots.length; i += 3) {
      expect(dots[i]).toBeGreaterThanOrEqual(0.2);
      expect(dots[i]).toBeLessThanOrEqual(1);
    }
    expect(Array.from(buildDots(800, 600, 24, seededRng(1)))).toEqual(Array.from(dots));
  });

  it("drift_eases_toward_the_pointer", () => {
    const next = stepDrift({ x: 0, y: 0 }, { x: 1, y: 1 }, 0.05);
    expect(next.x).toBeGreaterThan(0);
    expect(next.x).toBeLessThan(1);
    expect(next.y).toBeGreaterThan(0);
    expect(next.y).toBeLessThan(1);
  });

  it("adds_no_new_dependency", () => {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies).not.toHaveProperty("three");
    expect(pkg.devDependencies).not.toHaveProperty("three");
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      "@radix-ui/react-dropdown-menu", "@seliseblocks/client", "@tanstack/react-query", "clsx", "diff", "lucide-react", "react", "react-dom", "tailwind-merge"
    ]);
    expect(Object.keys(pkg.devDependencies).sort()).toEqual([
      "@testing-library/jest-dom", "@testing-library/react", "@testing-library/user-event", "@types/node", "@types/react", "@types/react-dom",
      "@vitejs/plugin-react", "autoprefixer", "jsdom", "postcss", "selfsigned", "tailwindcss", "typescript", "vite", "vitest"
    ]);
  });
});
