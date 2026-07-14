import {
	createExecutionContext,
	runInDurableObject,
	runDurableObjectAlarm,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import InboundOperationStatus from "../app/components/email-panel/InboundOperationStatus";
import type { InboundOperation } from "../app/types";
import { app, receiveEmail } from "../workers";
import type { Env } from "../workers/types";

const SYNTHETIC_EMAIL = [
	"Message-ID: <vm-1007@example.test>",
	"Date: Tue, 14 Jul 2026 07:00:00 +0000",
	"From: Requester <requester@example.test>",
	"To: lab@inbox.test",
	"Subject: Order VM-1007 status",
	"MIME-Version: 1.0",
	'Content-Type: multipart/mixed; boundary="vm-1007-boundary"',
	"",
	"--vm-1007-boundary",
	"Content-Type: text/plain; charset=utf-8",
	"",
	"Please check the synthetic order status.",
	"--vm-1007-boundary",
	'Content-Type: text/plain; name="synthetic-order-VM-1007.txt"',
	"Content-Transfer-Encoding: base64",
	'Content-Disposition: attachment; filename="synthetic-order-VM-1007.txt"',
	"",
	"U3ludGhldGljIG9yZGVyIFZNLTEwMDcuCg==",
	"--vm-1007-boundary--",
].join("\r\n");

const RECOVERY_EMAIL = SYNTHETIC_EMAIL.replace(
	"<vm-1007@example.test>",
	"<vm-1007-recovery@example.test>",
);

const RESET_PARTIAL_EMAIL = SYNTHETIC_EMAIL.replace(
	"<vm-1007@example.test>",
	"<vm-1007-reset-partial@example.test>",
);

const CONFLICT_EMAIL = SYNTHETIC_EMAIL.replace(
	"<vm-1007@example.test>",
	"<vm-1007-conflict@example.test>",
);

const CHANGED_CONFLICT_EMAIL = CONFLICT_EMAIL.replace(
	"Please check the synthetic order status.",
	"Changed payload under the same identity must be blocked.",
);

const THREAD_LOOKUP_FAILURE_EMAIL = SYNTHETIC_EMAIL.replace(
	"<vm-1007@example.test>",
	"<vm-1007-thread-lookup-failure@example.test>",
);

const AGENT_TRIGGER_FAILURE_EMAIL = SYNTHETIC_EMAIL
	.replace(
		"<vm-1007@example.test>",
		"<vm-1007-agent-trigger-failure@example.test>",
	)
	.replace("Order VM-1007 status", "Order VM-1007 trigger failure");

const DURABLE_AGENT_EMAIL = SYNTHETIC_EMAIL.replace(
	"<vm-1007@example.test>",
	"<vm-1007-durable-agent@example.test>",
);

const OVERLAPPING_INTAKE_EMAIL = SYNTHETIC_EMAIL.replace(
	"<vm-1007@example.test>",
	"<vm-1007-overlapping-intake@example.test>",
);

const TEACHING_RESET_URL =
	"http://inbox.test/api/v1/teaching/scenarios/vm-1007/reset";
const TEACHING_STATUS_URL =
	"http://inbox.test/api/v1/teaching/scenarios/vm-1007/status";
const TEACHING_REPLAY_URL =
	"http://inbox.test/api/v1/teaching/scenarios/vm-1007/replay";
const TEACHING_CONFLICT_URL =
	"http://inbox.test/api/v1/teaching/scenarios/vm-1007/conflict";
const TEACHING_ADMIN_HEADERS = {
	Authorization: "Bearer synthetic-teaching-admin-token",
};

function createEmailEvent(raw: string) {
	const bytes = new TextEncoder().encode(raw);
	return {
		raw: new Blob([bytes]).stream(),
		rawSize: bytes.byteLength,
	};
}

async function deliverSyntheticEmail(
	runtimeEnv: Env = env as unknown as Env,
	raw = SYNTHETIC_EMAIL,
	runAgentAlarm = true,
) {
	const ctx = createExecutionContext();
	await receiveEmail(
		createEmailEvent(raw),
		runtimeEnv,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	if (runAgentAlarm) {
		const mailbox = env.MAILBOX.get(
			env.MAILBOX.idFromName("lab@inbox.test"),
		);
		await runDurableObjectAlarm(mailbox);
	}
}

function createAcknowledgedWriteFailureEnv(): Env {
	let failAfterPut = true;
	const failingBucket = new Proxy(env.BUCKET, {
		get(target, property) {
			if (property === "put") {
				return async (...args: Parameters<R2Bucket["put"]>) => {
					const result = await target.put(...args);
					if (failAfterPut) {
						failAfterPut = false;
						throw new Error("synthetic_r2_ack_failure");
					}
					return result;
				};
			}
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return {
		BUCKET: failingBucket,
		MAILBOX: env.MAILBOX,
		EMAIL_AGENT: env.EMAIL_AGENT,
		DOMAINS: "inbox.test",
		EMAIL_ADDRESSES: ["lab@inbox.test"],
	} as unknown as Env;
}

function createThreadLookupFailureEnv(): Env {
	const failingNamespace = new Proxy(env.MAILBOX, {
		get(target, property) {
			if (property === "get") {
				return (...args: Parameters<typeof target.get>) => {
					const stub = target.get(...args);
					return new Proxy(stub, {
						get(stubTarget, stubProperty) {
							if (stubProperty === "findThreadBySubject") {
								return async () => {
									throw new Error("synthetic_thread_lookup_failure");
								};
							}
							const value = Reflect.get(stubTarget, stubProperty);
							return typeof value === "function"
								? (...methodArgs: unknown[]) =>
									(stubTarget as unknown as Record<PropertyKey, (...args: unknown[]) => unknown>)[stubProperty](...methodArgs)
								: value;
						},
					});
				};
			}
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return {
		BUCKET: env.BUCKET,
		MAILBOX: failingNamespace,
		EMAIL_AGENT: env.EMAIL_AGENT,
		DOMAINS: "inbox.test",
		EMAIL_ADDRESSES: ["lab@inbox.test"],
	} as unknown as Env;
}

function createGatedIntakeEnv() {
	let resolveFirstPrepared!: () => void;
	let releaseFirstPrepared!: () => void;
	const firstPrepared = new Promise<void>((resolve) => {
		resolveFirstPrepared = resolve;
	});
	const releaseFirst = new Promise<void>((resolve) => {
		releaseFirstPrepared = resolve;
	});
	const attachmentPutKeys: string[] = [];
	let prepareCalls = 0;

	const countingBucket = new Proxy(env.BUCKET, {
		get(target, property) {
			if (property === "put") {
				return async (...args: Parameters<R2Bucket["put"]>) => {
					if (args[0].startsWith("attachments/")) {
						attachmentPutKeys.push(args[0]);
					}
					return target.put(...args);
				};
			}
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const gatedNamespace = new Proxy(env.MAILBOX, {
		get(target, property) {
			if (property === "get") {
				return (...args: Parameters<typeof target.get>) => {
					const stub = target.get(...args);
					return new Proxy(stub, {
						get(stubTarget, stubProperty) {
							if (stubProperty === "prepareInboundIntake") {
								return async (...methodArgs: unknown[]) => {
									const result = await (
										stubTarget as unknown as Record<
											PropertyKey,
											(...args: unknown[]) => Promise<unknown>
										>
									)[stubProperty](...methodArgs);
									prepareCalls += 1;
									if (prepareCalls === 1) {
										resolveFirstPrepared();
										await releaseFirst;
									}
									return result;
								};
							}
							const value = Reflect.get(stubTarget, stubProperty);
							return typeof value === "function"
								? (...methodArgs: unknown[]) =>
									(stubTarget as unknown as Record<
										PropertyKey,
										(...args: unknown[]) => unknown
									>)[stubProperty](...methodArgs)
								: value;
						},
					});
				};
			}
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	return {
		runtimeEnv: {
			BUCKET: countingBucket,
			MAILBOX: gatedNamespace,
			EMAIL_AGENT: env.EMAIL_AGENT,
			DOMAINS: "inbox.test",
			EMAIL_ADDRESSES: ["lab@inbox.test"],
		} as unknown as Env,
		attachmentPutKeys,
		firstPrepared,
		releaseFirstPrepared,
	};
}

describe("inbound email product seam", () => {
	it("projects and triggers an exact Email Routing replay only once", async () => {
		await env.BUCKET.put("mailboxes/lab@inbox.test.json", "{}");

		await deliverSyntheticEmail();
		for (let replay = 0; replay < 10; replay++) {
			await deliverSyntheticEmail();
		}

		const mailbox = env.MAILBOX.get(
			env.MAILBOX.idFromName("lab@inbox.test"),
		) as unknown as {
			getEmails(input: { folder: string }): Promise<Array<{ id: string }>>;
			getEmail(id: string): Promise<{
				attachments: Array<{ filename: string }>;
			}>;
		};
		const agent = env.EMAIL_AGENT.get(
			env.EMAIL_AGENT.idFromName("lab@inbox.test"),
		) as unknown as {
			getTriggerCount(): Promise<number>;
		};

		const inbox = await mailbox.getEmails({ folder: "inbox" });
		expect(inbox).toHaveLength(1);
		const email = await mailbox.getEmail(inbox[0].id);
		expect(email.attachments).toEqual([
			expect.objectContaining({
				filename: "synthetic-order-VM-1007.txt",
			}),
		]);
		const attachmentObjects = await env.BUCKET.list({ prefix: "attachments/" });
		expect(attachmentObjects.objects).toHaveLength(1);
		expect(await agent.getTriggerCount()).toBe(1);

		const operationResponse = await app.request(
			`http://inbox.test/api/v1/mailboxes/lab%40inbox.test/emails/${inbox[0].id}/operation`,
			{},
			env,
		);
		expect(operationResponse.status).toBe(200);
		expect(await operationResponse.json()).toMatchObject({
			emailId: inbox[0].id,
			state: "awaiting_human_review",
			intakeAttempts: 1,
			agentAttempts: 1,
			conflictCount: 0,
		});

		const deleteResponse = await app.request(
			`http://inbox.test/api/v1/mailboxes/lab%40inbox.test/emails/${inbox[0].id}`,
			{ method: "DELETE" },
			env,
		);
		expect(deleteResponse.status).toBe(409);
		expect(await deleteResponse.json()).toMatchObject({
			error: "Cannot delete the source request while its durable operation is retained",
		});
		expect(await mailbox.getEmail(inbox[0].id)).not.toBeNull();
		expect((await env.BUCKET.list({ prefix: "attachments/" })).objects).toHaveLength(1);
	});

	it("skips R2 work for an active intake overlap and recovers after the lease expires", async () => {
		await env.BUCKET.put("mailboxes/lab@inbox.test.json", "{}");
		const {
			runtimeEnv,
			attachmentPutKeys,
			firstPrepared,
			releaseFirstPrepared,
		} = createGatedIntakeEnv();
		const mailbox = env.MAILBOX.get(
			env.MAILBOX.idFromName("lab@inbox.test"),
		) as unknown as {
			listInboundOperations(): Promise<InboundOperation[]>;
			getEmails(input: { folder: string }): Promise<Array<{ id: string }>>;
		};

		const firstDelivery = receiveEmail(
			createEmailEvent(OVERLAPPING_INTAKE_EMAIL),
			runtimeEnv,
			createExecutionContext(),
			{ runAgent: false },
		);
		await firstPrepared;

		try {
			await receiveEmail(
				createEmailEvent(OVERLAPPING_INTAKE_EMAIL),
				runtimeEnv,
				createExecutionContext(),
				{ runAgent: false },
			);
			expect(attachmentPutKeys).toHaveLength(0);

			const active = (await mailbox.listInboundOperations()).find(
				(operation) => operation.externalIdentity.includes(
					"vm-1007-overlapping-intake",
				),
			);
			expect(active).toMatchObject({
				state: "storing_attachments",
				intakeAttempts: 1,
			});

			await runInDurableObject(
				env.MAILBOX.get(env.MAILBOX.idFromName("lab@inbox.test")),
				(_instance, state) => {
					state.storage.sql.exec(
						`UPDATE inbound_operations
						 SET updated_at = '2000-01-01T00:00:00.000Z'
						 WHERE state = 'storing_attachments'`,
					);
				},
			);

			await receiveEmail(
				createEmailEvent(OVERLAPPING_INTAKE_EMAIL),
				runtimeEnv,
				createExecutionContext(),
				{ runAgent: false },
			);
			expect(attachmentPutKeys).toHaveLength(1);
		} finally {
			releaseFirstPrepared();
			await firstDelivery;
		}

		const recovered = (await mailbox.listInboundOperations()).find(
			(operation) => operation.externalIdentity.includes(
				"vm-1007-overlapping-intake",
			),
		);
		expect(recovered).toMatchObject({
			state: "intake_committed",
			intakeAttempts: 2,
		});
		expect(attachmentPutKeys).toHaveLength(2);
		expect(new Set(attachmentPutKeys).size).toBe(1);
		expect((await mailbox.getEmails({ folder: "inbox" })).filter(
			(email) => email.id === recovered!.emailId,
		)).toHaveLength(1);
		expect((await env.BUCKET.list({
			prefix: `attachments/${recovered!.emailId}/`,
		})).objects).toHaveLength(1);
	});

	it("keeps Agent work durable when the Email Worker request ends before execution", async () => {
		await env.BUCKET.put("mailboxes/lab@inbox.test.json", "{}");
		const mailbox = env.MAILBOX.get(
			env.MAILBOX.idFromName("lab@inbox.test"),
		) as unknown as {
			listInboundOperations(): Promise<InboundOperation[]>;
		};
		const agent = env.EMAIL_AGENT.get(
			env.EMAIL_AGENT.idFromName("lab@inbox.test"),
		) as unknown as {
			getTriggerCount(): Promise<number>;
			getNamedConnectionStats(): Promise<{ count: number; lastRoom?: string }>;
		};
		const triggerCount = await agent.getTriggerCount();
		const namedConnectionCount = (await agent.getNamedConnectionStats()).count;

		await deliverSyntheticEmail(
			env as unknown as Env,
			DURABLE_AGENT_EMAIL,
			false,
		);
		const pending = (await mailbox.listInboundOperations()).find(
			(operation) => operation.externalIdentity.includes("vm-1007-durable-agent"),
		);
		expect(pending).toMatchObject({
			state: "drafting",
			agentAttempts: 1,
			agentTriggerPending: true,
		});
		expect(await agent.getTriggerCount()).toBe(triggerCount);

		expect(await runDurableObjectAlarm(
			env.MAILBOX.get(env.MAILBOX.idFromName("lab@inbox.test")),
		)).toBe(true);
		const completed = (await mailbox.listInboundOperations()).find(
			(operation) => operation.id === pending!.id,
		);
		expect(completed).toMatchObject({
			state: "awaiting_human_review",
			agentAttempts: 1,
			agentTriggerPending: false,
			currentDraftId: expect.stringMatching(/^draft_/),
		});
		expect(await agent.getTriggerCount()).toBe(triggerCount + 1);
		expect(await agent.getNamedConnectionStats()).toEqual({
			count: namedConnectionCount + 1,
			lastRoom: "lab@inbox.test",
		});
	});

	it("records and recovers an acknowledged R2 write without duplicating intake", async () => {
		await env.BUCKET.put("mailboxes/lab@inbox.test.json", "{}");
		const mailbox = env.MAILBOX.get(
			env.MAILBOX.idFromName("lab@inbox.test"),
		) as unknown as {
			getEmails(input: { folder: string }): Promise<Array<{ id: string }>>;
		};
		const agent = env.EMAIL_AGENT.get(
			env.EMAIL_AGENT.idFromName("lab@inbox.test"),
		) as unknown as {
			getTriggerCount(): Promise<number>;
		};
		const initialInbox = await mailbox.getEmails({ folder: "inbox" });
		const initialObjects = await env.BUCKET.list({ prefix: "attachments/" });
		const initialTriggerCount = await agent.getTriggerCount();

		await expect(
			deliverSyntheticEmail(createAcknowledgedWriteFailureEnv(), RECOVERY_EMAIL),
		).rejects.toThrow(
			"synthetic_r2_ack_failure",
		);
		expect((await env.BUCKET.list({ prefix: "attachments/" })).objects).toHaveLength(
			initialObjects.objects.length + 1,
		);

		await deliverSyntheticEmail(env as unknown as Env, RECOVERY_EMAIL);

		const inbox = await mailbox.getEmails({ folder: "inbox" });
		expect(inbox).toHaveLength(initialInbox.length + 1);
		expect((await env.BUCKET.list({ prefix: "attachments/" })).objects).toHaveLength(
			initialObjects.objects.length + 1,
		);
		expect(await agent.getTriggerCount()).toBe(initialTriggerCount + 1);
		const recoveredEmail = inbox.find(
			(email) => !initialInbox.some((existing) => existing.id === email.id),
		);
		expect(recoveredEmail).toBeDefined();

		const operationResponse = await app.request(
			`http://inbox.test/api/v1/mailboxes/lab%40inbox.test/emails/${recoveredEmail!.id}/operation`,
			{},
			env,
		);
		expect(operationResponse.status).toBe(200);
		expect(await operationResponse.json()).toMatchObject({
			state: "awaiting_human_review",
			intakeAttempts: 2,
			lastIntakeError: "synthetic_r2_ack_failure",
			lastIntakeFailedAt: expect.any(String),
		});
		});

	it("records a visible intake failure before the first R2 write", async () => {
		await env.BUCKET.put("mailboxes/lab@inbox.test.json", "{}");
		const mailbox = env.MAILBOX.get(
			env.MAILBOX.idFromName("lab@inbox.test"),
		) as unknown as {
			getEmails(input: { folder: string }): Promise<Array<{ id: string }>>;
		};
		const initialInbox = await mailbox.getEmails({ folder: "inbox" });
		const initialObjects = await env.BUCKET.list({ prefix: "attachments/" });

		await expect(
			deliverSyntheticEmail(createThreadLookupFailureEnv(), THREAD_LOOKUP_FAILURE_EMAIL),
		).rejects.toThrow("synthetic_thread_lookup_failure");
		await expect(
			deliverSyntheticEmail(createThreadLookupFailureEnv(), THREAD_LOOKUP_FAILURE_EMAIL),
		).rejects.toThrow("synthetic_thread_lookup_failure");

		expect(await mailbox.getEmails({ folder: "inbox" })).toHaveLength(
			initialInbox.length,
		);
		expect((await env.BUCKET.list({ prefix: "attachments/" })).objects).toHaveLength(
			initialObjects.objects.length,
		);

		const statusResponse = await app.request(
			TEACHING_STATUS_URL,
			{ headers: TEACHING_ADMIN_HEADERS },
			env,
		);
		const status = await statusResponse.json() as {
			operations: InboundOperation[];
		};
		const failed = status.operations.find(
			(operation) =>
				operation.externalIdentity.includes("vm-1007-thread-lookup-failure")
		);
		expect(failed).toMatchObject({
			state: "intake_failed",
			intakeAttempts: 0,
			lastError: "synthetic_thread_lookup_failure",
			lastIntakeError: "synthetic_thread_lookup_failure",
			lastIntakeFailedAt: expect.any(String),
			conflictCount: 0,
		});
		expect(
			renderToStaticMarkup(InboundOperationStatus({ operation: failed! })),
		).toContain("Request needs retry");
	});

	it("makes Agent trigger failure visible and exposes one guarded Draft retry", async () => {
		await env.BUCKET.put("mailboxes/lab@inbox.test.json", "{}");
		const mailbox = env.MAILBOX.get(
			env.MAILBOX.idFromName("lab@inbox.test"),
		) as unknown as {
			getEmails(input: { folder: string }): Promise<Array<{
				id: string;
				subject: string;
			}>>;
		};
		const initialInbox = await mailbox.getEmails({ folder: "inbox" });

		await deliverSyntheticEmail(
			env as unknown as Env,
			AGENT_TRIGGER_FAILURE_EMAIL,
		);
		const inbox = await mailbox.getEmails({ folder: "inbox" });
		const email = inbox.find(
			(candidate) => !initialInbox.some((existing) => existing.id === candidate.id),
		);
		expect(email).toBeDefined();

		const operationUrl =
			`http://inbox.test/api/v1/mailboxes/lab%40inbox.test/emails/${email!.id}/operation`;
		const failedResponse = await app.request(operationUrl, {}, env);
		const failed = await failedResponse.json() as InboundOperation;
		expect(failed).toMatchObject({
			state: "draft_failed",
			agentAttempts: 1,
			lastError: "agent_trigger_http_503",
		});
		expect(renderToStaticMarkup(InboundOperationStatus({
			operation: failed,
			onRetryDraft() {},
		}))).toContain("Retry Draft");

		const retryUrl = `${operationUrl}/retry-draft`;
		const retryResponse = await app.request(retryUrl, { method: "POST" }, env);
		expect(retryResponse.status).toBe(202);
		expect(await retryResponse.json()).toMatchObject({
			state: "drafting",
			agentAttempts: 2,
			lastError: null,
			agentTriggerPending: true,
		});
		const competingRetry = await app.request(retryUrl, { method: "POST" }, env);
		expect(competingRetry.status).toBe(409);
	});

	it("projects a changed replay from Email Routing through the API into the operator status", async () => {
		await env.BUCKET.put("mailboxes/lab@inbox.test.json", "{}");
		const mailbox = env.MAILBOX.get(
			env.MAILBOX.idFromName("lab@inbox.test"),
		) as unknown as {
			getEmails(input: { folder: string }): Promise<Array<{ id: string }>>;
		};
		const initialInbox = await mailbox.getEmails({ folder: "inbox" });

		await deliverSyntheticEmail(env as unknown as Env, CONFLICT_EMAIL);
		await deliverSyntheticEmail(env as unknown as Env, CHANGED_CONFLICT_EMAIL);

		const inbox = await mailbox.getEmails({ folder: "inbox" });
		expect(inbox).toHaveLength(initialInbox.length + 1);
		const originalEmail = inbox.find(
			(email) => !initialInbox.some((existing) => existing.id === email.id),
		);
		expect(originalEmail).toBeDefined();

		const response = await app.request(
			`http://inbox.test/api/v1/mailboxes/lab%40inbox.test/emails/${originalEmail!.id}/operation`,
			{},
			env,
		);
		expect(response.status).toBe(200);
		const operation = await response.json() as InboundOperation;
		expect(operation).toMatchObject({
			emailId: originalEmail!.id,
			state: "awaiting_human_review",
			conflictCount: 1,
			lastConflictPayloadHash: expect.stringMatching(/^sha256:/),
			lastConflictAt: expect.any(String),
		});

		const statusMarkup = renderToStaticMarkup(
			InboundOperationStatus({ operation }),
		);
		expect(statusMarkup).toContain("Awaiting your review");
		expect(statusMarkup).toContain("1 conflicting delivery");
		expect(statusMarkup).toContain("blocked");
	});

	it("requires teaching Admin authority and resets VM-1007 to one deterministic seed", async () => {
		const unauthorizedReset = await app.request(
			TEACHING_RESET_URL,
			{ method: "POST" },
			env,
		);
		expect(unauthorizedReset.status).toBe(403);
		const unauthorizedStatus = await app.request(
			TEACHING_STATUS_URL,
			{},
			env,
		);
		expect(unauthorizedStatus.status).toBe(403);
		const unauthorizedReplay = await app.request(
			TEACHING_REPLAY_URL,
			{ method: "POST" },
			env,
		);
		expect(unauthorizedReplay.status).toBe(403);
		const unauthorizedConflict = await app.request(
			TEACHING_CONFLICT_URL,
			{ method: "POST" },
			env,
		);
		expect(unauthorizedConflict.status).toBe(403);

		const unseededMailbox = env.MAILBOX.get(
			env.MAILBOX.idFromName("lab@inbox.test"),
		) as unknown as {
			getTeachingResetPlan(): Promise<{ attachmentKeys: string[] }>;
			resetTeachingScenario(): Promise<unknown>;
		};
		const unseededResetPlan = await unseededMailbox.getTeachingResetPlan();
		if (unseededResetPlan.attachmentKeys.length > 0) {
			await env.BUCKET.delete(unseededResetPlan.attachmentKeys);
		}
		await unseededMailbox.resetTeachingScenario();
		const replayWithoutSeed = await app.request(
			TEACHING_REPLAY_URL,
			{ method: "POST", headers: TEACHING_ADMIN_HEADERS },
			env,
		);
		expect(replayWithoutSeed.status).toBe(409);
		const invalidMode = await app.request(
			TEACHING_RESET_URL,
			{
				method: "POST",
				headers: {
					...TEACHING_ADMIN_HEADERS,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ mode: "unbounded_failure_hook" }),
			},
			env,
		);
		expect(invalidMode.status).toBe(400);

		const multiMailboxEnv = {
			BUCKET: env.BUCKET,
			MAILBOX: env.MAILBOX,
			EMAIL_AGENT: env.EMAIL_AGENT,
			DOMAINS: "inbox.test",
			EMAIL_ADDRESSES: ["lab@inbox.test", "other@inbox.test"],
			TEACHING_ADMIN_TOKEN: "synthetic-teaching-admin-token",
		} as unknown as Env;
		const ambiguousMailbox = await app.request(
			TEACHING_RESET_URL,
			{ method: "POST", headers: TEACHING_ADMIN_HEADERS },
			multiMailboxEnv,
		);
		expect(ambiguousMailbox.status).toBe(409);

		await env.BUCKET.put("mailboxes/lab@inbox.test.json", "{}");
		await expect(
			deliverSyntheticEmail(
				createAcknowledgedWriteFailureEnv(),
				RESET_PARTIAL_EMAIL,
			),
		).rejects.toThrow("synthetic_r2_ack_failure");
		const failedStatusResponse = await app.request(
			TEACHING_STATUS_URL,
			{ headers: TEACHING_ADMIN_HEADERS },
			env,
		);
		expect(failedStatusResponse.status).toBe(200);
		const failedStatus = await failedStatusResponse.json() as {
			mailboxId: string;
			operations: InboundOperation[];
		};
		expect(failedStatus).toMatchObject({
			mailboxId: "lab@inbox.test",
			operations: expect.arrayContaining([
				expect.objectContaining({
					state: "intake_failed",
					lastError: "synthetic_r2_ack_failure",
					lastIntakeError: "synthetic_r2_ack_failure",
					attachmentManifest: [
						expect.objectContaining({
							filename: "synthetic-order-VM-1007.txt",
						}),
					],
				}),
			]),
		});
		const failedOperation = failedStatus.operations.find(
			(operation) => operation.state === "intake_failed",
		);
		expect(failedOperation).toBeDefined();
		expect(
			renderToStaticMarkup(
				InboundOperationStatus({ operation: failedOperation! }),
			),
		).toContain("Request needs retry");

		const reset = () => app.request(
			TEACHING_RESET_URL,
			{
				method: "POST",
				headers: TEACHING_ADMIN_HEADERS,
			},
			env,
		);
		const mailbox = env.MAILBOX.get(
			env.MAILBOX.idFromName("lab@inbox.test"),
		) as unknown as {
			getEmails(input: { folder: string }): Promise<Array<{
				id: string;
				subject: string;
			}>>;
			getEmail(id: string): Promise<{
				attachments: Array<{ filename: string }>;
			}>;
		};
		const agent = env.EMAIL_AGENT.get(
			env.EMAIL_AGENT.idFromName("lab@inbox.test"),
		) as unknown as {
			getTriggerCount(): Promise<number>;
			getNamedConnectionStats(): Promise<{ count: number; lastRoom?: string }>;
		};
		const namedConnectionCount = (await agent.getNamedConnectionStats()).count;

		const firstResponse = await reset();
		expect(firstResponse.status).toBe(200);
		expect(await agent.getNamedConnectionStats()).toEqual({
			count: namedConnectionCount + 1,
			lastRoom: "lab@inbox.test",
		});
		const first = await firstResponse.json() as {
			mailboxId: string;
			emailId: string;
			operation: InboundOperation;
		};
		expect(first).toMatchObject({
			mailboxId: "lab@inbox.test",
			operation: {
				state: "drafting",
				intakeAttempts: 1,
				conflictCount: 0,
				agentTriggerPending: true,
			},
		});
		expect(await runDurableObjectAlarm(
			env.MAILBOX.get(env.MAILBOX.idFromName("lab@inbox.test")),
		)).toBe(true);
		expect(await agent.getNamedConnectionStats()).toEqual({
			count: namedConnectionCount + 2,
			lastRoom: "lab@inbox.test",
		});

		const firstInbox = await mailbox.getEmails({ folder: "inbox" });
		expect(firstInbox).toEqual([
			expect.objectContaining({
				id: first.emailId,
				subject: "Order VM-1007 status",
			}),
		]);
		expect((await mailbox.getEmail(first.emailId)).attachments).toEqual([
			expect.objectContaining({ filename: "synthetic-order-VM-1007.txt" }),
		]);
		expect((await env.BUCKET.list({ prefix: "attachments/" })).objects).toHaveLength(1);
		expect(await agent.getTriggerCount()).toBe(1);

		const exactReplayResponse = await app.request(
			TEACHING_REPLAY_URL,
			{ method: "POST", headers: TEACHING_ADMIN_HEADERS },
			env,
		);
		expect(exactReplayResponse.status).toBe(200);
		expect(await exactReplayResponse.json()).toMatchObject({
			action: "exact_replay",
			emailId: first.emailId,
			operation: {
				state: "awaiting_human_review",
				intakeAttempts: 1,
				conflictCount: 0,
			},
		});
		expect(await mailbox.getEmails({ folder: "inbox" })).toHaveLength(1);
		expect((await env.BUCKET.list({ prefix: "attachments/" })).objects).toHaveLength(1);
		expect(await agent.getTriggerCount()).toBe(1);

		const conflictResponse = await app.request(
			TEACHING_CONFLICT_URL,
			{ method: "POST", headers: TEACHING_ADMIN_HEADERS },
			env,
		);
		expect(conflictResponse.status).toBe(200);
		expect(await conflictResponse.json()).toMatchObject({
			action: "changed_payload_conflict",
			emailId: first.emailId,
			operation: {
				state: "awaiting_human_review",
				intakeAttempts: 1,
				conflictCount: 1,
				lastConflictPayloadHash: expect.stringMatching(/^sha256:/),
			},
		});
		expect(await mailbox.getEmails({ folder: "inbox" })).toHaveLength(1);
		expect((await env.BUCKET.list({ prefix: "attachments/" })).objects).toHaveLength(1);
		expect(await agent.getTriggerCount()).toBe(1);

		const secondResponse = await reset();
		expect(secondResponse.status).toBe(200);
		const second = await secondResponse.json() as typeof first;
		expect(second.emailId).toBe(first.emailId);
		expect(second.operation).toMatchObject({
			state: "drafting",
			intakeAttempts: 1,
			conflictCount: 0,
		});
		expect(await runDurableObjectAlarm(
			env.MAILBOX.get(env.MAILBOX.idFromName("lab@inbox.test")),
		)).toBe(true);
		expect(await mailbox.getEmails({ folder: "inbox" })).toHaveLength(1);
		expect((await env.BUCKET.list({ prefix: "attachments/" })).objects).toHaveLength(1);
		expect(await agent.getTriggerCount()).toBe(1);

		const failedResetResponse = await app.request(
			TEACHING_RESET_URL,
			{
				method: "POST",
				headers: {
					...TEACHING_ADMIN_HEADERS,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ mode: "draft_failed" }),
			},
			env,
		);
		expect(failedResetResponse.status).toBe(200);
		const failedReset = await failedResetResponse.json() as typeof first & {
			mode: string;
		};
		expect(failedReset).toMatchObject({
			mode: "draft_failed",
			emailId: first.emailId,
			operation: {
				state: "draft_failed",
				agentAttempts: 0,
				lastError: "synthetic_teaching_draft_failure",
			},
		});
		expect(await agent.getTriggerCount()).toBe(0);
		expect(renderToStaticMarkup(InboundOperationStatus({
			operation: failedReset.operation,
			onRetryDraft() {},
		}))).toContain("Retry Draft");

		const retryUrl =
			`http://inbox.test/api/v1/mailboxes/lab%40inbox.test/emails/${failedReset.emailId}/operation/retry-draft`;
		const retryResponse = await app.request(retryUrl, { method: "POST" }, env);
		expect(retryResponse.status).toBe(202);
		expect(await retryResponse.json()).toMatchObject({
			state: "drafting",
			agentAttempts: 1,
			lastError: null,
		});
		expect((await app.request(retryUrl, { method: "POST" }, env)).status).toBe(409);
		expect(await runDurableObjectAlarm(
			env.MAILBOX.get(env.MAILBOX.idFromName("lab@inbox.test")),
		)).toBe(true);
		expect(await agent.getTriggerCount()).toBe(1);
	});
});
