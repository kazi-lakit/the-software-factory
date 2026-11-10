// Test-only: valid checks for the repo form tests.
export const checksFixtureForTests = {
  client: { cwd: "client", install: "i", lint: "l", test: "t", typecheck: "tc" },
  e2e: "off",
  server: { build: "b", cwd: "server", test: "t" }
} as const;
