import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createEmailTools } from "../workers/agent";
import { toolDraftReply } from "../workers/lib/tools";
import type { Env } from "../workers/types";

interface Operation {
	id: string;
	emailId: string;
}

interface MailboxStub {
	claimInboundOperation(input: {
		externalIdentity: string;
		payloadHash: string;
	}): Promise<{ operation: Operation }>;
	prepareInboundIntake(input: {
		operationId: string;
		attachmentManifest: [];
	}): Promise<unknown>;
	commitInboundOperation(input: {
		operationId: string;
		email: Record<string, unknown>;
		attachments: [];
	}): Promise<unknown>;
	startInboundDraft(operationId: string): Promise<unknown>;
	getEmails(input: { folder: string }): Promise<Array<{ id: string }>>;
}

type OperationAwareDraftReply = (
	env: Env,
	mailboxId: string,
	params: {
		operationId: string;
		originalEmailId: string;
		to: string;
		subject: string;
		body: string;
		isPlainText: boolean;
		runVerifyDraft: boolean;
	},
) => Promise<{ status: string; draftId: string }>;

describe("operation-aware Agent Draft tool", () => {
	it("limits automatic intake work to context reads and one operation-aware Draft tool", () => {
		const runtimeEnv = env as unknown as Env;
		const automaticTools = createEmailTools(
			runtimeEnv,
			"lab@inbox.test",
			"inbound_vm_1007",
		);
		const interactiveTools = createEmailTools(runtimeEnv, "lab@inbox.test");

		expect(Object.keys(automaticTools).sort()).toEqual([
			"draft_reply",
			"get_email",
			"get_thread",
			"list_emails",
			"search_emails",
		]);
		expect(automaticTools).not.toHaveProperty("draft_email");
		expect(automaticTools).not.toHaveProperty("mark_email_read");
		expect(automaticTools).not.toHaveProperty("move_email");
		expect(automaticTools).not.toHaveProperty("discard_draft");
		expect(automaticTools).not.toHaveProperty("send_email");
		expect(automaticTools).not.toHaveProperty("send_reply");

		expect(interactiveTools).toHaveProperty("draft_email");
		expect(interactiveTools).toHaveProperty("mark_email_read");
		expect(interactiveTools).toHaveProperty("move_email");
		expect(interactiveTools).toHaveProperty("discard_draft");
		expect(interactiveTools).not.toHaveProperty("send_email");
		expect(interactiveTools).not.toHaveProperty("send_reply");
	});

	it("returns the same current Draft when Agent execution is repeated", async () => {
		const mailboxId = "agent-draft@inbox.test";
		const mailbox = env.MAILBOX.get(
			env.MAILBOX.idFromName(mailboxId),
		) as unknown as MailboxStub;
		const claim = await mailbox.claimInboundOperation({
			externalIdentity: "message:agent-draft-vm-1007@example.test",
			payloadHash: "sha256:agent-draft-payload",
		});
		await mailbox.prepareInboundIntake({
			operationId: claim.operation.id,
			attachmentManifest: [],
		});
		await mailbox.commitInboundOperation({
			operationId: claim.operation.id,
			email: {
				subject: "Order VM-1007 status",
				sender: "requester@example.test",
				recipient: mailboxId,
				date: "2026-07-14T07:00:00.000Z",
				body: "Please check the synthetic order status.",
				thread_id: claim.operation.emailId,
				message_id: "agent-draft-vm-1007@example.test",
			},
			attachments: [],
		});
		await mailbox.startInboundDraft(claim.operation.id);

		const draftReply = toolDraftReply as unknown as OperationAwareDraftReply;
		const first = await draftReply(env as unknown as Env, mailboxId, {
			operationId: claim.operation.id,
			originalEmailId: claim.operation.emailId,
			to: "requester@example.test",
			subject: "Re: Order VM-1007 status",
			body: "The synthetic order is ready for review.",
			isPlainText: true,
			runVerifyDraft: false,
		});
		const repeated = await draftReply(env as unknown as Env, mailboxId, {
			operationId: claim.operation.id,
			originalEmailId: claim.operation.emailId,
			to: "requester@example.test",
			subject: "Re: changed retry output",
			body: "This competing retry must not become current.",
			isPlainText: true,
			runVerifyDraft: false,
		});

		expect(repeated.draftId).toBe(first.draftId);
		expect(await mailbox.getEmails({ folder: "draft" })).toHaveLength(1);
	});
});
