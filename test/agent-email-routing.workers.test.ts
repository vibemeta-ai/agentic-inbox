import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
	resolveAllowlistedEmailAgent,
	routeInboundEmailToAgent,
} from "../workers/lib/agent-email-routing";
import type { Env } from "../workers/types";

function createEmail(to: string, body = "Synthetic routed email") {
	const bytes = new TextEncoder().encode(body);
	const setReject = vi.fn();
	const email: ForwardableEmailMessage = {
		from: "requester@example.test",
		to,
		headers: new Headers({ subject: "Routing contract" }),
		raw: new Blob([bytes]).stream(),
		rawSize: bytes.byteLength,
		setReject,
		async forward() {
			return { messageId: "synthetic-forward" };
		},
		async reply() {
			return { messageId: "synthetic-reply" };
		},
	};
	return { email, setReject };
}

describe("Agents SDK email routing", () => {
	it("resolves only the exact allowlisted mailbox to its named Agent", async () => {
		const allowed = createEmail("LAB@INBOX.TEST").email;
		await expect(resolveAllowlistedEmailAgent(allowed, env as Env)).resolves.toEqual({
			agentName: "EMAIL_AGENT",
			agentId: "lab@inbox.test",
		});

		const unknown = createEmail("other@inbox.test").email;
		await expect(resolveAllowlistedEmailAgent(unknown, env as Env)).resolves.toBeNull();
	});

	it("crosses routeAgentEmail and the Email bridge into the named Agent", async () => {
		const { email } = createEmail("lab@inbox.test");
		await routeInboundEmailToAgent(email, env as Env);

		const agent = env.EMAIL_AGENT.get(
			env.EMAIL_AGENT.idFromName("lab@inbox.test"),
		) as unknown as {
			getLastRoutedEmail(): Promise<{
				from: string;
				to: string;
				rawSize: number;
				rawText: string;
			}>;
		};
		await expect(agent.getLastRoutedEmail()).resolves.toEqual({
			from: "requester@example.test",
			to: "lab@inbox.test",
			rawSize: 22,
			rawText: "Synthetic routed email",
		});
	});

	it("rejects an envelope recipient outside the allowlist", async () => {
		const { email, setReject } = createEmail("other@inbox.test");
		await routeInboundEmailToAgent(email, env as Env);
		expect(setReject).toHaveBeenCalledWith("Unknown recipient");
	});
});
