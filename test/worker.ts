import { DurableObject } from "cloudflare:workers";

export { MailboxDO } from "../workers/durableObject";

interface FakeAgentTrigger {
	operationId?: string;
	mailboxId?: string;
	emailId?: string;
	sender?: string;
	subject?: string;
	threadId?: string;
}

export class FakeEmailAgent extends DurableObject {
	async fetch(request: Request) {
		const url = new URL(request.url);
		if (url.pathname === "/resetTeachingScenario" && request.method === "POST") {
			if (request.headers.get("Authorization") !== "Bearer synthetic-teaching-admin-token") {
				return new Response("Forbidden", { status: 403 });
			}
			await this.ctx.storage.delete("triggerCount");
			await this.ctx.storage.delete("triggerFailureSeen");
			return new Response(null, { status: 204 });
		}
		const input = await request.clone().json<FakeAgentTrigger>()
			.catch(() => ({} as FakeAgentTrigger));
		if (
			input.subject === "Order VM-1007 trigger failure" &&
			!(await this.ctx.storage.get<boolean>("triggerFailureSeen"))
		) {
			await this.ctx.storage.put("triggerFailureSeen", true);
			return new Response("Synthetic Agent trigger failure", { status: 503 });
		}
		const triggerCount = (await this.ctx.storage.get<number>("triggerCount")) ?? 0;
		await this.ctx.storage.put("triggerCount", triggerCount + 1);
		if (
			input.operationId &&
			input.mailboxId &&
			input.emailId &&
			input.sender &&
			input.threadId
		) {
			const testEnv = this.env as unknown as {
				MAILBOX: DurableObjectNamespace<import("../workers/durableObject").MailboxDO>;
			};
			const mailbox = testEnv.MAILBOX.get(
				testEnv.MAILBOX.idFromName(input.mailboxId),
			);
			await mailbox.commitCurrentDraft({
				operationId: input.operationId,
				draft: {
					subject: input.subject?.startsWith("Re:")
						? input.subject
						: `Re: ${input.subject || "Request"}`,
					sender: input.mailboxId,
					recipient: input.sender,
					date: new Date().toISOString(),
					body: "The synthetic order is ready for human review.",
					in_reply_to: input.emailId,
					thread_id: input.threadId,
				},
			});
		}
		return Response.json({ status: "accepted" });
	}

	async getTriggerCount() {
		return (await this.ctx.storage.get<number>("triggerCount")) ?? 0;
	}
}

export default {
	fetch() {
		return new Response("Not found", { status: 404 });
	},
};
