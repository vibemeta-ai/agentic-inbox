import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../workers";

interface InboundOperationClaim {
	kind: "created" | "replay" | "conflict";
	operation: {
		id: string;
		externalIdentity: string;
		payloadHash: string;
		emailId: string;
			state: string;
			intakeAttempts: number;
			lastIntakeError: string | null;
			lastIntakeFailedAt: string | null;
			currentDraftId: string | null;
		lastError: string | null;
		agentAttempts: number;
		conflictCount: number;
		lastConflictPayloadHash: string | null;
	};
}

interface InboundOperationLedgerStub {
	claimInboundOperation(input: {
		externalIdentity: string;
		payloadHash: string;
	}): Promise<InboundOperationClaim>;
	prepareInboundIntake(input: {
		operationId: string;
		attachmentManifest: Array<{
			id: string;
			key: string;
			filename: string;
			size: number;
			mimetype: string;
		}>;
	}): Promise<unknown>;
	failInboundIntake(operationId: string, error: string): Promise<{
		kind: "failed" | "replay";
		operation: InboundOperationClaim["operation"];
	}>;
	commitInboundOperation(input: {
		operationId: string;
		email: {
			subject: string;
			sender: string;
			recipient: string;
			date: string;
			body: string;
			thread_id: string;
			message_id: string;
		};
		attachments: Array<{
			id: string;
			filename: string;
			mimetype: string;
			size: number;
			disposition: string;
		}>;
	}): Promise<{
		kind: "committed" | "replay";
		operation: InboundOperationClaim["operation"];
	}>;
	getEmail(id: string): Promise<{
		id: string;
		body: string;
		attachments: Array<{ id: string; email_id: string }>;
	} | null>;
	getEmails(input: { folder: string }): Promise<Array<{ id: string }>>;
	getInboundOperation(operationId: string): Promise<
		InboundOperationClaim["operation"] | null
	>;
	startInboundDraft(operationId: string): Promise<{
		kind: "started" | "replay";
		operation: InboundOperationClaim["operation"];
	}>;
	failInboundDraft(operationId: string, error: string): Promise<{
		kind: "failed" | "replay";
		operation: InboundOperationClaim["operation"];
	}>;
	commitCurrentDraft(input: {
		operationId: string;
		draft: {
			subject: string;
			sender: string;
			recipient: string;
			date: string;
			body: string;
			in_reply_to: string;
			thread_id: string;
		};
	}): Promise<{
		kind: "committed" | "replay";
		draftId: string;
		operation: InboundOperationClaim["operation"];
	}>;
}

function getLedger(mailboxId: string): InboundOperationLedgerStub {
	const id = env.MAILBOX.idFromName(mailboxId);
	return env.MAILBOX.get(id) as unknown as InboundOperationLedgerStub;
}

describe("mailbox inbound operation ledger", () => {
	it("returns the original operation when the same inbound request is replayed", async () => {
		const ledger = getLedger("lab@inbox.test");
		const input = {
			externalIdentity: "message:vm-1007@example.test",
			payloadHash: "sha256:0ad4c615efbe45f3",
		};

		const first = await ledger.claimInboundOperation(input);
		const replay = await ledger.claimInboundOperation(input);

		expect(first.kind).toBe("created");
		expect(first.operation).toMatchObject({
			externalIdentity: input.externalIdentity,
			payloadHash: input.payloadHash,
			state: "received",
		});
		expect(first.operation.id).not.toBe("");
		expect(first.operation.emailId).not.toBe("");
		expect(replay).toEqual({
			kind: "replay",
			operation: first.operation,
		});
	});

	it("records pre-manifest intake failure and keeps the operation retryable", async () => {
		const ledger = getLedger("pre-manifest-failure@inbox.test");
		const claim = await ledger.claimInboundOperation({
			externalIdentity: "message:pre-manifest-failure@example.test",
			payloadHash: "sha256:pre-manifest-failure",
		});

		const failed = await ledger.failInboundIntake(
			claim.operation.id,
			"synthetic_manifest_validation_failure",
		);
		const retry = await ledger.prepareInboundIntake({
			operationId: claim.operation.id,
			attachmentManifest: [],
		}) as {
			kind: "prepared";
			operation: InboundOperationClaim["operation"];
		};

		expect(failed).toMatchObject({
			kind: "failed",
			operation: {
				state: "intake_failed",
				intakeAttempts: 0,
				lastIntakeError: "synthetic_manifest_validation_failure",
				lastIntakeFailedAt: expect.any(String),
			},
		});
		expect(retry).toMatchObject({
			kind: "prepared",
			operation: {
				state: "storing_attachments",
				intakeAttempts: 1,
				lastIntakeError: "synthetic_manifest_validation_failure",
			},
		});
	});

	it("rejects a changed payload without replacing the first claim", async () => {
		const ledger = getLedger("conflict@inbox.test");
		const first = await ledger.claimInboundOperation({
			externalIdentity: "message:vm-1007@example.test",
			payloadHash: "sha256:first-payload",
		});

		const conflict = await ledger.claimInboundOperation({
			externalIdentity: "message:vm-1007@example.test",
			payloadHash: "sha256:changed-payload",
		});
		const replay = await ledger.claimInboundOperation({
			externalIdentity: "message:vm-1007@example.test",
			payloadHash: "sha256:first-payload",
		});

		expect(conflict).toMatchObject({
			kind: "conflict",
			operation: {
				id: first.operation.id,
				payloadHash: "sha256:first-payload",
				conflictCount: 1,
				lastConflictPayloadHash: "sha256:changed-payload",
			},
		});
		expect(replay.kind).toBe("replay");
		expect(replay.operation.payloadHash).toBe("sha256:first-payload");
		expect(replay.operation.conflictCount).toBe(1);
	});

	it("commits one message projection when intake is repeated", async () => {
		const ledger = getLedger("commit@inbox.test");
		const claim = await ledger.claimInboundOperation({
			externalIdentity: "message:vm-1007@example.test",
			payloadHash: "sha256:0ad4c615efbe45f3",
		});
		const input = {
			operationId: claim.operation.id,
			email: {
				subject: "Order VM-1007 status",
				sender: "requester@example.test",
				recipient: "lab@inbox.test",
				date: "2026-07-14T07:00:00.000Z",
				body: "Please check the synthetic order status.",
				thread_id: claim.operation.emailId,
				message_id: "vm-1007@example.test",
			},
			attachments: [
				{
					id: "attachment_vm_1007",
					filename: "synthetic-order-VM-1007.txt",
					mimetype: "text/plain",
					size: 42,
					disposition: "attachment",
				},
			],
		};

		await ledger.prepareInboundIntake({
			operationId: claim.operation.id,
			attachmentManifest: [
				{
					id: "attachment_vm_1007",
					key: `attachments/${claim.operation.emailId}/attachment_vm_1007/synthetic-order-VM-1007.txt`,
					filename: "synthetic-order-VM-1007.txt",
					size: 42,
					mimetype: "text/plain",
				},
			],
		});
		const committed = await ledger.commitInboundOperation(input);
		const replay = await ledger.commitInboundOperation(input);
		const email = await ledger.getEmail(claim.operation.emailId);

		expect(committed.kind).toBe("committed");
		expect(committed.operation.state).toBe("intake_committed");
		expect(replay).toEqual({
			kind: "replay",
			operation: committed.operation,
		});
		expect(email).toMatchObject({
			id: claim.operation.emailId,
			attachments: [
				{
					id: "attachment_vm_1007",
					email_id: claim.operation.emailId,
				},
			],
		});
	});

	it("recovers a failed Agent attempt and converges on one current Draft", async () => {
		const ledger = getLedger("draft@inbox.test");
		const claim = await ledger.claimInboundOperation({
			externalIdentity: "message:draft-vm-1007@example.test",
			payloadHash: "sha256:draft-payload",
		});
		await ledger.prepareInboundIntake({
			operationId: claim.operation.id,
			attachmentManifest: [],
		});
		await ledger.commitInboundOperation({
			operationId: claim.operation.id,
			email: {
				subject: "Order VM-1007 status",
				sender: "requester@example.test",
				recipient: "draft@inbox.test",
				date: "2026-07-14T07:00:00.000Z",
				body: "Please check the synthetic order status.",
				thread_id: claim.operation.emailId,
				message_id: "draft-vm-1007@example.test",
			},
			attachments: [],
		});

		const firstAttempt = await ledger.startInboundDraft(claim.operation.id);
		const repeatedStart = await ledger.startInboundDraft(claim.operation.id);
		const failed = await ledger.failInboundDraft(
			claim.operation.id,
			"synthetic_agent_failure",
		);
		const repeatedFailure = await ledger.failInboundDraft(
			claim.operation.id,
			"late_failure_must_not_replace_the_first_reason",
		);
		const retry = await ledger.startInboundDraft(claim.operation.id);
		const firstDraft = await ledger.commitCurrentDraft({
			operationId: claim.operation.id,
			draft: {
				subject: "Re: Order VM-1007 status",
				sender: "draft@inbox.test",
				recipient: "requester@example.test",
				date: "2026-07-14T07:01:00.000Z",
				body: "The synthetic order is ready for review.",
				in_reply_to: claim.operation.emailId,
				thread_id: claim.operation.emailId,
			},
		});
		const repeatedDraft = await ledger.commitCurrentDraft({
			operationId: claim.operation.id,
			draft: {
				subject: "Re: changed retry output",
				sender: "draft@inbox.test",
				recipient: "requester@example.test",
				date: "2026-07-14T07:02:00.000Z",
				body: "This competing retry must not become current.",
				in_reply_to: claim.operation.emailId,
				thread_id: claim.operation.emailId,
			},
		});

		expect(firstAttempt.operation).toMatchObject({
			state: "drafting",
			agentAttempts: 1,
		});
		expect(repeatedStart).toEqual({
			kind: "replay",
			operation: firstAttempt.operation,
		});
		expect(failed.operation).toMatchObject({
			state: "draft_failed",
			lastError: "synthetic_agent_failure",
		});
		expect(repeatedFailure).toEqual({
			kind: "replay",
			operation: failed.operation,
		});
		expect(retry.operation).toMatchObject({
			state: "drafting",
			agentAttempts: 2,
			lastError: null,
		});
		expect(firstDraft).toMatchObject({
			kind: "committed",
			operation: {
				state: "awaiting_human_review",
				currentDraftId: firstDraft.draftId,
			},
		});
		expect(repeatedDraft).toEqual({
			kind: "replay",
			draftId: firstDraft.draftId,
			operation: firstDraft.operation,
		});
		expect(await ledger.getEmails({ folder: "draft" })).toHaveLength(1);
		expect(await ledger.getEmail(firstDraft.draftId)).toMatchObject({
			body: "The synthetic order is ready for review.",
		});
		expect(await ledger.getInboundOperation(claim.operation.id)).toEqual(
			firstDraft.operation,
		);
	});

	it("keeps an edited Draft current and records human rejection atomically", async () => {
		const mailboxId = "human-review@inbox.test";
		await env.BUCKET.put(`mailboxes/${mailboxId}.json`, "{}");
		const ledger = getLedger(mailboxId);
		const claim = await ledger.claimInboundOperation({
			externalIdentity: "message:human-review@example.test",
			payloadHash: "sha256:human-review",
		});
		await ledger.prepareInboundIntake({
			operationId: claim.operation.id,
			attachmentManifest: [],
		});
		await ledger.commitInboundOperation({
			operationId: claim.operation.id,
			email: {
				subject: "Order VM-1007 status",
				sender: "requester@example.test",
				recipient: mailboxId,
				date: "2026-07-14T07:00:00.000Z",
				body: "Please check the synthetic order status.",
				thread_id: claim.operation.emailId,
				message_id: "human-review@example.test",
			},
			attachments: [],
		});
		await ledger.startInboundDraft(claim.operation.id);
		const committed = await ledger.commitCurrentDraft({
			operationId: claim.operation.id,
			draft: {
				subject: "Re: Order VM-1007 status",
				sender: mailboxId,
				recipient: "requester@example.test",
				date: "2026-07-14T07:01:00.000Z",
				body: "Initial proposal.",
				in_reply_to: claim.operation.emailId,
				thread_id: claim.operation.emailId,
			},
		});

		const encodedMailbox = encodeURIComponent(mailboxId);
		const editResponse = await app.request(
			`http://inbox.test/api/v1/mailboxes/${encodedMailbox}/drafts`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					draft_id: committed.draftId,
					to: "requester@example.test",
					subject: "Re: Order VM-1007 status",
					body: "Human-edited proposal.",
					in_reply_to: claim.operation.emailId,
					thread_id: claim.operation.emailId,
				}),
			},
			env,
		);
		expect(editResponse.status).toBe(200);
		expect(await editResponse.json()).toMatchObject({
			id: committed.draftId,
			draft_id: committed.draftId,
		});
		expect(await ledger.getEmail(committed.draftId)).toMatchObject({
			id: committed.draftId,
			body: "Human-edited proposal.",
		});
		expect(await ledger.getInboundOperation(claim.operation.id)).toMatchObject({
			state: "awaiting_human_review",
			currentDraftId: committed.draftId,
		});
		const sendResponse = await app.request(
			`http://inbox.test/api/v1/mailboxes/${encodedMailbox}/emails/${claim.operation.emailId}/reply`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					to: "requester@example.test",
					from: mailboxId,
					subject: "Re: Order VM-1007 status",
					text: "Human-edited proposal.",
				}),
			},
			env,
		);
		expect(sendResponse.status).toBe(409);
		expect(await sendResponse.json()).toMatchObject({
			error: "This operation stops at human review; external delivery is not enabled",
		});
		expect(await ledger.getEmails({ folder: "sent" })).toHaveLength(0);
		expect(await ledger.getInboundOperation(claim.operation.id)).toMatchObject({
			state: "awaiting_human_review",
			currentDraftId: committed.draftId,
		});

		const rejectResponse = await app.request(
			`http://inbox.test/api/v1/mailboxes/${encodedMailbox}/emails/${committed.draftId}`,
			{ method: "DELETE" },
			env,
		);
		expect(rejectResponse.status).toBe(204);
		expect(await ledger.getInboundOperation(claim.operation.id)).toMatchObject({
			state: "rejected",
			currentDraftId: committed.draftId,
		});
		expect(await ledger.getEmails({ folder: "draft" })).toHaveLength(0);
		expect(await ledger.getEmails({ folder: "trash" })).toEqual([
			expect.objectContaining({ id: committed.draftId }),
		]);
	});
});
