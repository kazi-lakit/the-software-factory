// Test-only: valid checks for the repo form tests.
export const checksFixtureForTests = [
  { name: "server.build", cwd: "server", run: "b" },
  { name: "server.test", cwd: "server", run: "t", needs: "server.build" },
  { name: "client.install", cwd: "client", run: "i" },
  { name: "client.typecheck", cwd: "client", run: "tc", needs: "client.install" },
  { name: "client.lint", cwd: "client", run: "l", needs: "client.install" },
  { name: "client.test", cwd: "client", run: "t", needs: "client.install" }
];
