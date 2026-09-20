import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: process.env.SEEKIO_INTEGRATION
      ? ["test/integration/**/*.test.ts"]
      : ["test/unit/**/*.test.ts"],
    environment: "node",
  },
});
