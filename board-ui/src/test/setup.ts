import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach } from "vitest";
import { resetSelectedFactoryForTests } from "../features/factories/selectedFactory";

// The picked factory is module state; each test starts from whatever localStorage holds.
beforeEach(resetSelectedFactoryForTests);
afterEach(resetSelectedFactoryForTests);

// jsdom has no matchMedia; the app shell asks it for the mobile layout.
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    addEventListener: () => undefined,
    addListener: () => undefined,
    dispatchEvent: () => false,
    matches: false,
    media: query,
    onchange: null,
    removeEventListener: () => undefined,
    removeListener: () => undefined
  });
}

// jsdom has no canvas backend and logs "not implemented" for getContext; tests that need a context mock it.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
