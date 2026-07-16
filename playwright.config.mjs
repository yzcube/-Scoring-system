import { defineConfig } from "@playwright/test";

export default defineConfig({
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR || "test-results",
  snapshotPathTemplate: "{testDir}/snapshots/{arg}{ext}",
});
