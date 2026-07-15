import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";
import { defineProject } from "vitest/config";

export default defineProject({
	plugins: [
		...agents(),
		cloudflareTest({
			wrangler: {
				configPath: "./wrangler.test.jsonc",
			},
		}),
	],
	test: {
		include: ["test/**/*.workers.test.ts"],
	},
});
