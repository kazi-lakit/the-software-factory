import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default defineConfig((env) => mergeConfig(viteConfig(env), defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    // Tests never talk to Blocks: every test mocks the SDK client or the auth module.
    env: {
      VITE_BLOCKS_API_URL: "https://api.test.invalid",
      VITE_BLOCKS_APP_DOMAIN: "https://app.test.invalid",
      VITE_BLOCKS_OIDC_CLIENT_ID: "test-client",
      VITE_BLOCKS_OIDC_URL: "https://iam.test.invalid",
      VITE_BLOCKS_X_BLOCKS_KEY: "test-key"
    }
  }
})));
