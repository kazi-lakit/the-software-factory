import "@testing-library/jest-dom/vitest";

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
