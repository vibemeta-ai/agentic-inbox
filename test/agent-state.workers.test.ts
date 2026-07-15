import { env } from "cloudflare:workers";
import { getAgentByName, routeAgentEmail } from "agents";
import { describe, expect, it } from "vitest";
import type { EmailAgent } from "../workers/agent";

describe("named Email Agent state", () => {
	it("persists its mailbox projection and exposes the refresh command as callable", async () => {
		const testEnv = env as unknown as {
			STATE_EMAIL_AGENT: DurableObjectNamespace<EmailAgent>;
		};
		const agent = await getAgentByName(
			testEnv.STATE_EMAIL_AGENT,
			"lab@inbox.test",
		);

		await expect(agent.refreshMailboxState()).resolves.toMatchObject({
			phase: "ready",
			pendingReviews: 0,
			failedOperations: 0,
			lastOperationId: null,
		});
		const callables = await agent.getCallableMethods();
		expect([...callables.keys()]).toContain("refreshMailboxState");
	});

	it("receives Email Service input and projects the durable intake state", async () => {
		const rawText = [
			"Message-ID: <agents-v4-route@example.test>",
			"From: Requester <requester@example.test>",
			"To: lab@inbox.test",
			"Subject: Agents V4 routing",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"Please prepare a synthetic reply.",
		].join("\r\n");
		const raw = new TextEncoder().encode(rawText);
		const email: ForwardableEmailMessage = {
			from: "requester@example.test",
			to: "lab@inbox.test",
			headers: new Headers({ subject: "Agents V4 routing" }),
			raw: new ReadableStream({
				start(controller) {
					controller.enqueue(raw);
					controller.close();
				},
			}),
			rawSize: raw.byteLength,
			setReject() {},
			async forward() {
				return { messageId: "synthetic-forward" };
			},
			async reply() {
				return { messageId: "synthetic-reply" };
			},
		};
		const testEnv = env as unknown as Cloudflare.Env & {
			STATE_EMAIL_AGENT: DurableObjectNamespace<EmailAgent>;
		};
		await env.BUCKET.put("mailboxes/lab@inbox.test.json", "{}");

		await routeAgentEmail(email, testEnv, {
			resolver: async () => ({
				agentName: "STATE_EMAIL_AGENT",
				agentId: "lab@inbox.test",
			}),
		});

		const agent = await getAgentByName(
			testEnv.STATE_EMAIL_AGENT,
			"lab@inbox.test",
		);
		await expect(agent.refreshMailboxState()).resolves.toMatchObject({
			phase: "drafting",
			pendingReviews: 0,
			failedOperations: 0,
			lastOperationId: expect.stringMatching(/^inbound_/),
		});
	});
});
