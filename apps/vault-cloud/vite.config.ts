import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    pack: {
      entry: ["src/main.ts"],
      outDir: "dist",
      sourcemap: false,
      clean: true,
      // The deployment artifact is a single self-contained file: bundle every
      // dependency (including effect) so the Railway service needs no install.
      deps: {
        alwaysBundle: () => true,
        onlyBundle: false,
      },
      banner: {
        js: "#!/usr/bin/env node\n",
      },
    },
  }),
);
