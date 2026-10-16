import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Same alias as tsconfig's "@/*", so app code imports resolve in tests.
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    include: ["app/**/*.test.ts", "scripts/**/*.test.mjs"],
    // Tests run on recorded fixtures only. Nothing here may reach the network.
    environment: "node",
  },
});
