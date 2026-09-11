import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Runs before any test file is imported, so no suite can inherit the
    // developer's shell. See test/setup.ts.
    setupFiles: ["./test/setup.ts"],
  },
});
