// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import agents from "agents/vite";
import { defineConfig } from "vite";

const wranglerConfigPath = process.env.VIBE_META_WRANGLER_CONFIG;

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    agents(),
    cloudflare({
      ...(wranglerConfigPath ? { configPath: wranglerConfigPath } : {}),
      viteEnvironment: { name: "ssr" },
    }),
    tailwindcss(),
    reactRouter(),
  ],
});
