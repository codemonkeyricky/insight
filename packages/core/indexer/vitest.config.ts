import { configDefaults, defineConfig } from "vitest/config";

// Fixture projects under test/fixtures are inputs the tests index, never test suites. A fixture's own *.test.ts (the
// tiers-app server's) would otherwise run here and write its database into this package.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test/fixtures/**"],
  },
});
