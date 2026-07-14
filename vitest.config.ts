import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

export default defineProject({
	plugins: [
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
