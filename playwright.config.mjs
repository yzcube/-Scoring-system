import { defineConfig } from "@playwright/test";

export default defineConfig({
  snapshotPathTemplate: "{testDir}/snapshots/{arg}{ext}",
});
