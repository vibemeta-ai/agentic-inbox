// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { sendEmail } from "./email-sender";
import { storeAttachments, type StoredAttachment } from "./lib/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
	listMailboxes,
} from "./lib/email-helpers";
import { SendEmailRequestSchema } from "./lib/schemas";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import type { Env } from "./types";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";
import {
	createAttachmentIdentity,
	createInboundExternalIdentity,
	createInboundPayloadHash,
	normalizeMessageIdentity,
} from "./lib/inbound-identity";
import { hasValidTeachingAdminToken } from "./lib/teaching-auth";

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
});

const DraftBody = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
});

const TeachingResetBody = z.object({
	mode: z.enum(["normal", "draft_failed"]).default("normal"),
}).strict();

// -- Helpers --------------------------------------------------------

function slugify(text: string) { // can return "" for non-alphanumeric input
	return text.toString().toLowerCase()
		.replace(/\s+/g, "-").replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function intQuery(c: AppContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: AppContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

// -- App & middleware -----------------------------------------------

const app = new Hono<MailboxContext>();
app.use("/api/*", cors({
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch { /* invalid origin */ }
		// Block all other cross-origin requests. The app is served from the
		// same origin as the API, so legitimate browser requests never send
		// an Origin header. Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
}));
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", (c) => {
	const domainsRaw = c.env.DOMAINS || "";
	const domains = domainsRaw.split(",").map((d) => d.trim()).filter(Boolean);
	const emailAddresses = c.env.EMAIL_ADDRESSES ?? [];
	return c.json({ domains, emailAddresses });
});

const VM_1007_RESET_PATH = "/api/v1/teaching/scenarios/vm-1007/reset";
const VM_1007_STATUS_PATH = "/api/v1/teaching/scenarios/vm-1007/status";
const VM_1007_REPLAY_PATH = "/api/v1/teaching/scenarios/vm-1007/replay";
const VM_1007_CONFLICT_PATH = "/api/v1/teaching/scenarios/vm-1007/conflict";

function getTeachingMailboxId(env: Env): string | undefined {
	const addresses = [...new Set(((env.EMAIL_ADDRESSES ?? []) as string[])
		.map((address) => address.trim().toLowerCase())
		.filter(Boolean))];
	if (addresses.length !== 1) return undefined;

	const domains = (env.DOMAINS || "")
		.split(",")
		.map((domain) => domain.trim().toLowerCase())
		.filter(Boolean);
	const address = addresses[0];
	return domains.some((domain) => address === `lab@${domain}`)
		? address
		: undefined;
}

function createVm1007Email(
	mailboxId: string,
	variant: "baseline" | "conflict" = "baseline",
): string {
	const requestBody = variant === "conflict"
		? "Changed payload under the same identity must be blocked."
		: "Please check the synthetic order status.";
	return [
		"Message-ID: <vm-1007@example.test>",
		"Date: Tue, 14 Jul 2026 07:00:00 +0000",
		"From: Requester <requester@example.test>",
		`To: ${mailboxId}`,
		"Subject: Order VM-1007 status",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="vm-1007-boundary"',
		"",
		"--vm-1007-boundary",
		"Content-Type: text/plain; charset=utf-8",
		"",
		requestBody,
		"--vm-1007-boundary",
		'Content-Type: text/plain; name="synthetic-order-VM-1007.txt"',
		"Content-Transfer-Encoding: base64",
		'Content-Disposition: attachment; filename="synthetic-order-VM-1007.txt"',
		"",
		"U3ludGhldGljIG9yZGVyIFZNLTEwMDcuCg==",
		"--vm-1007-boundary--",
	].join("\r\n");
}

type TeachingScenarioAuthorization =
	| { mailboxId: string }
	| { error: string; status: 403 | 409 };

async function authorizeTeachingScenario(
	c: AppContext,
): Promise<TeachingScenarioAuthorization> {
	if (!(await hasValidTeachingAdminToken(c.req.raw, c.env.TEACHING_ADMIN_TOKEN))) {
		return { error: "Teaching Admin authorization required", status: 403 };
	}

	const mailboxId = getTeachingMailboxId(c.env);
	if (!mailboxId) {
		return {
			error: "VM-1007 requires exactly one allowlisted lab@ mailbox on a configured domain",
			status: 409,
		};
	}

	return { mailboxId };
}

async function parseTeachingResetBody(c: AppContext) {
	const rawBody = await c.req.text();
	let input: unknown = {};
	if (rawBody.trim()) {
		try {
			input = JSON.parse(rawBody);
		} catch {
			return { error: "Teaching reset body must be valid JSON" } as const;
		}
	}

	const parsed = TeachingResetBody.safeParse(input);
	return parsed.success
		? parsed.data
		: { error: "Teaching reset mode must be normal or draft_failed" } as const;
}

async function deliverVm1007(
	env: Env,
	mailboxId: string,
	variant: "baseline" | "conflict",
	runAgent: boolean,
) {
	const raw = new TextEncoder().encode(createVm1007Email(mailboxId, variant));
	const pending: Promise<unknown>[] = [];
	const teachingContext = {
		waitUntil(promise: Promise<unknown>) {
			pending.push(promise);
		},
		passThroughOnException() {},
	} as unknown as ExecutionContext;
	await receiveEmail(
		{ raw: new Blob([raw]).stream(), rawSize: raw.byteLength },
		env,
		teachingContext,
		{ runAgent },
	);
	await Promise.all(pending);
}

async function getVm1007Projection(env: Env, mailboxId: string) {
	const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	const inbox = await mailbox.getEmails({ folder: Folders.INBOX });
	const email = inbox.find((candidate) => candidate.subject === "Order VM-1007 status");
	if (!email) return undefined;
	const operation = await mailbox.getInboundOperationByEmailId(email.id);
	return operation ? { email, operation } : undefined;
}

app.post(VM_1007_RESET_PATH, async (c) => {
	const authorization = await authorizeTeachingScenario(c);
	if ("error" in authorization) {
		return c.json({ error: authorization.error }, authorization.status);
	}
	const resetBody = await parseTeachingResetBody(c);
	if ("error" in resetBody) return c.json({ error: resetBody.error }, 400);
	const { mailboxId } = authorization;

	const mailbox = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));
	const resetPlan = await mailbox.getTeachingResetPlan();
	if (resetPlan.attachmentKeys.length > 0) {
		await c.env.BUCKET.delete(resetPlan.attachmentKeys);
	}
	const removed = await mailbox.resetTeachingScenario();

	const agent = c.env.EMAIL_AGENT.get(c.env.EMAIL_AGENT.idFromName(mailboxId));
	const agentReset = await agent.fetch(new Request("https://agents/resetTeachingScenario", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${c.env.TEACHING_ADMIN_TOKEN}`,
		},
	}));
	if (!agentReset.ok) {
		return c.json({ error: "Failed to reset teaching Agent state" }, 502);
	}

	await c.env.BUCKET.put(
		`mailboxes/${mailboxId}.json`,
		JSON.stringify({
			fromName: "Vibe Meta Lab",
			forwarding: { enabled: false, email: "" },
			signature: { enabled: false, text: "" },
			autoReply: { enabled: false, subject: "", message: "" },
		}),
	);

	await deliverVm1007(
		c.env,
		mailboxId,
		"baseline",
		resetBody.mode === "normal",
	);

	const projection = await getVm1007Projection(c.env, mailboxId);
	if (!projection) {
		return c.json({ error: "VM-1007 seed did not create the inbox request" }, 500);
	}
	let operation = projection.operation;
	if (resetBody.mode === "draft_failed") {
		const failure = await mailbox.failInboundDraft(
			operation.id,
			"synthetic_teaching_draft_failure",
		);
		operation = failure.operation;
	}

	return c.json({
		scenario: "vm-1007",
		mode: resetBody.mode,
		mailboxId,
		emailId: projection.email.id,
		operation,
		removed,
	});
});

app.get(VM_1007_STATUS_PATH, async (c) => {
	const authorization = await authorizeTeachingScenario(c);
	if ("error" in authorization) {
		return c.json({ error: authorization.error }, authorization.status);
	}
	const { mailboxId } = authorization;
	const mailbox = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));
	return c.json({
		scenario: "vm-1007",
		mailboxId,
		operations: await mailbox.listInboundOperations(),
	});
});

async function deliverVm1007Replay(
	c: AppContext,
	variant: "baseline" | "conflict",
) {
	const authorization = await authorizeTeachingScenario(c);
	if ("error" in authorization) {
		return c.json({ error: authorization.error }, authorization.status);
	}
	const { mailboxId } = authorization;
	if (!(await getVm1007Projection(c.env, mailboxId))) {
		return c.json({ error: "Reset VM-1007 before replaying a delivery" }, 409);
	}

	await deliverVm1007(c.env, mailboxId, variant, false);
	const projection = await getVm1007Projection(c.env, mailboxId);
	if (!projection) {
		return c.json({ error: "VM-1007 projection disappeared during replay" }, 500);
	}

	return c.json({
		scenario: "vm-1007",
		action: variant === "baseline" ? "exact_replay" : "changed_payload_conflict",
		mailboxId,
		emailId: projection.email.id,
		operation: projection.operation,
	});
}

app.post(VM_1007_REPLAY_PATH, (c) => deliverVm1007Replay(c, "baseline"));
app.post(VM_1007_CONFLICT_PATH, (c) => deliverVm1007Replay(c, "conflict"));

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	return c.json(allMailboxes.map((m) => ({ ...m, name: m.id })));
});

app.post("/api/v1/mailboxes", async (c) => {
	const { name, settings, email: rawEmail } = CreateMailboxBody.parse(await c.req.json());
	const email = rawEmail.toLowerCase();
	const allowedAddresses = (c.env.EMAIL_ADDRESSES ?? []) as string[];
	if (allowedAddresses.length > 0 && !allowedAddresses.map((a) => a.toLowerCase()).includes(email)) {
		return c.json({ error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES" }, 403);
	}
	const key = `mailboxes/${email}.json`;
	if (await c.env.BUCKET.head(key)) return c.json({ error: "Mailbox already exists" }, 409);
	const defaultSettings = { fromName: name, forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" } };
	const finalSettings = { ...defaultSettings, ...settings };
	await c.env.BUCKET.put(key, JSON.stringify(finalSettings));
	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email));
	await stub.getFolders();
	return c.json({ id: email, email, name, settings: finalSettings }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const obj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return c.json({ error: "Not found" }, 404);
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings: await obj.json() });
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { settings } = (await c.req.json()) as { settings: Record<string, unknown> };
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.put(key, JSON.stringify(settings));
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings });
});

app.delete("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.delete(key); // TODO: also delete DO data and R2 attachment blobs
	return c.body(null, 204);
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as any;
	const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;
	const stub = c.var.mailboxStub;

	if (threaded && folder) {
		const emails = await (stub as any).getThreadedEmails({ folder, page, limit });
		const totalCount = await (stub as any).countThreadedEmails(folder);
		return c.json({ emails, totalCount });
	}
	const emails = await stub.getEmails({ folder, thread_id, page, limit, sortColumn, sortDirection });
	if (folder) {
		const totalCount = await stub.countEmails({ folder, thread_id });
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

app.post("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments, in_reply_to, references, thread_id } = body;

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const stub = c.var.mailboxStub;
	const rateLimitError = await (stub as any).checkSendRateLimit();
	if (rateLimitError) return c.json({ error: rateLimitError }, 429);
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await stub.createEmail(Folders.SENT, {
		id: messageId, subject, sender: fromEmail, recipient: toStr,
		cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
		bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
		date: new Date().toISOString(), body: html || text || "",
		in_reply_to: in_reply_to || null, email_references: references ? JSON.stringify(references) : null,
		thread_id: thread_id || in_reply_to || messageId, message_id: outgoingMessageId,
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
			{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
			...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
			...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
			{ key: "subject", value: subject }, { key: "date", value: new Date().toISOString() },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
		]),
	}, attachmentData);

	c.executionCtx.waitUntil(
		sendEmail(c.env.EMAIL, {
			to, cc, bcc, from, subject, html, text,
			attachments: attachments?.map((att) => ({ content: att.content, filename: att.filename, type: att.type, disposition: att.disposition || "attachment", contentId: att.contentId })),
			...(in_reply_to ? { headers: buildThreadingHeaders(in_reply_to, references || []) } : {}),
		}).catch((e) => console.error("Deferred email delivery failed:", (e as Error).message)),
	);
	return c.json({ id: messageId, status: "sent" }, 202);
});

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id } = DraftBody.parse(await c.req.json());
	const stub = c.var.mailboxStub;
	const now = new Date().toISOString();
	if (draft_id) {
		const updated = await stub.updateDraft(draft_id, {
			subject: subject || "",
			sender: mailboxId.toLowerCase(),
			recipient: (to || "").toLowerCase(),
			cc: cc?.toLowerCase() || null,
			bcc: bcc?.toLowerCase() || null,
			date: now,
			body,
			in_reply_to: in_reply_to || null,
			email_references: null,
			thread_id: thread_id || in_reply_to || draft_id,
		});
		if (!updated) return c.json({ error: "Draft not found" }, 404);
		return c.json({ id: draft_id, draft_id, status: "draft", subject: subject || "", recipient: to || "", date: now });
	}

	const messageId = crypto.randomUUID();
	await stub.createEmail(Folders.DRAFT, {
		id: messageId, subject: subject || "", sender: mailboxId.toLowerCase(),
		recipient: (to || "").toLowerCase(), cc: cc?.toLowerCase() || null, bcc: bcc?.toLowerCase() || null,
		date: now, body, in_reply_to: in_reply_to || null, email_references: null,
		thread_id: thread_id || in_reply_to || messageId,
	}, []);
	return c.json({ id: messageId, draft_id: messageId, status: "draft", subject: subject || "", recipient: to || "", date: now }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id/operation", async (c: AppContext) => {
	const operation = await c.var.mailboxStub.getInboundOperationByEmailId(
		c.req.param("id")!,
	);
	return operation
		? c.json(operation)
		: c.json({ error: "Inbound operation not found" }, 404);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/operation/retry-draft", async (c: AppContext) => {
	const emailId = c.req.param("id")!;
	const email = await c.var.mailboxStub.getEmail(emailId);
	if (!email) return c.json({ error: "Email not found" }, 404);
	const operation = await c.var.mailboxStub.getInboundOperationByEmailId(emailId);
	if (!operation) return c.json({ error: "Inbound operation not found" }, 404);
	if (operation.state !== "draft_failed") {
		return c.json({ error: `Cannot retry Draft from state ${operation.state}` }, 409);
	}

	const mailboxId = c.req.param("mailboxId")!;
	const attempt = await c.var.mailboxStub.scheduleInboundDraft({
		operationId: operation.id,
		mailboxId,
		emailId,
		sender: email.sender || "",
		subject: email.subject || "",
		threadId: email.thread_id || emailId,
	});
	if (attempt.kind === "replay") return c.json(attempt.operation, 409);
	return c.json(attempt.operation, 202);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const email = await c.var.mailboxStub.getEmail(c.req.param("id")!);
	if (!email) return c.json({ error: "Email not found" }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
	const email = await c.var.mailboxStub.updateEmail(c.req.param("id")!, { read, starred });
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const rejected = await c.var.mailboxStub.rejectCurrentDraft(id);
	if (rejected) return c.body(null, 204);
	const deletion = await c.var.mailboxStub.deleteEmail(id);
	if (deletion === null) return c.json({ error: "Not found" }, 404);
	if (deletion.kind === "blocked") {
		return c.json({
			error: "Cannot delete the source request while its durable operation is retained",
			operationId: deletion.operationId,
			state: deletion.state,
		}, 409);
	}
	if (deletion.attachments.length > 0) {
		await c.env.BUCKET.delete(
			deletion.attachments.map((attachment) =>
				`attachments/${id}/${attachment.id}/${attachment.filename}`
			),
		);
	}
	return c.body(null, 204);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };
	const success = await c.var.mailboxStub.moveEmail(c.req.param("id")!, folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).getThreadEmails(c.req.param("threadId")!));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: AppContext) => {
	await c.var.mailboxStub.markThreadRead(c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", async (c: AppContext) => {
	const operation = await c.var.mailboxStub.getInboundOperationByEmailId(
		c.req.param("id")!,
	);
	if (operation?.state === "awaiting_human_review" && operation.currentDraftId) {
		return c.json({
			error: "This operation stops at human review; external delivery is not enabled",
			operationId: operation.id,
			state: operation.state,
		}, 409);
	}
	return handleReplyEmail(c);
});
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => c.json(await c.var.mailboxStub.getFolders()));

app.post("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const slug = slugify(name);
	if (!slug) return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
	const f = await c.var.mailboxStub.createFolder(slug, name);
	return f ? c.json(f, 201) : c.json({ error: "Folder with this name already exists" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: "Folder not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteFolder(c.req.param("id")!);
	return ok ? c.body(null, 204) : c.json({ error: "Folder not found or cannot be deleted" }, 400);
});

// -- Search ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/search", async (c: AppContext) => {
	const searchOpts: Record<string, unknown> = {
		query: c.req.query("query") || "", folder: c.req.query("folder"), from: c.req.query("from"),
		to: c.req.query("to"), subject: c.req.query("subject"), date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"), is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"), has_attachment: boolQuery(c, "has_attachment"),
	};
	const stub = c.var.mailboxStub as any;
	const emails = await stub.searchEmails({ ...searchOpts, page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await stub.countSearchResults(searchOpts);
	return c.json({ emails, totalCount });
});

// -- Attachments ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
	if (!attachment) return c.json({ error: "Attachment not found" }, 404);
	const obj = await c.env.BUCKET.get(`attachments/${emailId}/${attachmentId}/${attachment.filename}`);
	if (!obj) return c.json({ error: "Attachment file not found" }, 404);
	const headers = new Headers();
	headers.set("Content-Type", attachment.mimetype);
	const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
	headers.set("Content-Disposition", `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
	return new Response(obj.body, { headers });
});

// -- Receive inbound email ------------------------------------------

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
	if (streamSize > MAX_EMAIL_SIZE) throw new Error(`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`);
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) { reader.cancel(); throw new Error(`Stream exceeds declared size`); }
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

interface ReceiveEmailOptions {
	runAgent?: boolean;
}

async function receiveEmail(
	event: { raw: ReadableStream; rawSize: number },
	env: Env,
	_ctx: ExecutionContext,
	options: ReceiveEmailOptions = {},
) {
	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);

	if (!parsedEmail.to?.length || !parsedEmail.to[0].address) throw new Error("received email with empty to");

	const allowedAddresses = ((env.EMAIL_ADDRESSES ?? []) as string[]).map((a) => a.toLowerCase());
	const allRecipients = parsedEmail.to.map((t) => t.address?.toLowerCase()).filter(Boolean) as string[];
	const ccRecipients = (parsedEmail.cc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
	const bccRecipients = (parsedEmail.bcc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];

	let mailboxId: string | undefined;
	if (allowedAddresses.length > 0) {
		mailboxId = allRecipients.find((addr) => allowedAddresses.includes(addr));
		if (!mailboxId) { console.log(`Ignoring email: no recipient matches EMAIL_ADDRESSES.`); return; }
	} else { mailboxId = allRecipients[0]; }
	if (!mailboxId) throw new Error("received email with no valid recipient address");

	if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) { console.log(`Ignoring email for ${mailboxId}: mailbox does not exist`); return; }

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	const originalMessageId = parsedEmail.messageId
		? normalizeMessageIdentity(parsedEmail.messageId)
		: null;
	const payloadHash = await createInboundPayloadHash({
		mailboxId,
		sender: parsedEmail.from?.address || "",
		recipients: allRecipients,
		cc: ccRecipients,
		bcc: bccRecipients,
		subject: parsedEmail.subject || "",
		body: parsedEmail.html || parsedEmail.text || "",
		attachments: parsedEmail.attachments || [],
	});
	const externalIdentity = await createInboundExternalIdentity({
		mailboxId,
		messageId: originalMessageId,
		rawEmail,
	});
	const claim = await stub.claimInboundOperation({
		externalIdentity,
		payloadHash,
	});

	if (claim.kind === "conflict") {
		console.error(`Inbound identity conflict for operation ${claim.operation.id}`);
		return;
	}
	if (
		claim.kind === "replay" &&
		claim.operation.state !== "received" &&
		claim.operation.state !== "storing_attachments" &&
		claim.operation.state !== "intake_failed"
	) {
		return;
	}

	const messageId = claim.operation.emailId;
	const extractMsgId = (s: string) => { const m = s.match(/<([^>]+)>/); return m ? m[1] : s.trim().split(/\s+/)[0]; };
	const inReplyTo = parsedEmail.inReplyTo ? extractMsgId(parsedEmail.inReplyTo) : null;
	const emailReferences = parsedEmail.references ? parsedEmail.references.split(/\s+/).filter(Boolean).map(extractMsgId) : [];
	let threadId = emailReferences[0] || inReplyTo || messageId;
	let commit: Awaited<ReturnType<typeof stub.commitInboundOperation>>;
	try {
		const attachmentData: StoredAttachment[] = [];
		const attachmentWrites: Array<{
			key: string;
			content: string | ArrayBuffer | Uint8Array;
		}> = [];
		if (parsedEmail.attachments) {
			for (const [index, att] of parsedEmail.attachments.entries()) {
				const filename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
				const attId = await createAttachmentIdentity({
					operationId: claim.operation.id,
					index,
					filename,
					content: att.content,
				});
				const key = `attachments/${messageId}/${attId}/${filename}`;
				attachmentWrites.push({ key, content: att.content });
				attachmentData.push({ id: attId, email_id: messageId, filename, mimetype: att.mimeType,
					size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
					content_id: att.contentId || null, disposition: att.disposition || "attachment" });
			}
		}

		if (!inReplyTo && emailReferences.length === 0) {
			const subjectThread = await (stub as any).findThreadBySubject(parsedEmail.subject || "", parsedEmail.from?.address || undefined);
			if (subjectThread) threadId = subjectThread;
		}

		const prepared = await stub.prepareInboundIntake({
			operationId: claim.operation.id,
			attachmentManifest: attachmentWrites.map((write, index) => ({
				id: attachmentData[index].id,
				key: write.key,
				filename: attachmentData[index].filename,
				size: attachmentData[index].size,
				mimetype: attachmentData[index].mimetype,
			})),
		});
		if (prepared.kind === "replay") return;

		for (const attachment of attachmentWrites) {
			await env.BUCKET.put(attachment.key, attachment.content);
		}
		commit = await stub.commitInboundOperation({
			operationId: claim.operation.id,
			email: {
				subject: parsedEmail.subject || "",
				sender: (parsedEmail.from?.address || "").toLowerCase(), recipient: allRecipients.join(", "),
				cc: ccRecipients.join(", ") || null, bcc: bccRecipients.join(", ") || null,
				date: new Date().toISOString(), // uses receive time, not the email's Date header
				body: parsedEmail.html || parsedEmail.text || "",
				in_reply_to: inReplyTo, email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
				thread_id: threadId, message_id: originalMessageId, raw_headers: JSON.stringify(parsedEmail.headers),
			},
			attachments: attachmentData,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		try {
			await stub.failInboundIntake(claim.operation.id, message);
		} catch (recordError) {
			console.error(
				`Failed to record intake failure for ${claim.operation.id}:`,
				recordError,
			);
		}
		throw error;
	}

	if (commit.kind === "replay") return;
	if (options.runAgent === false) return;

	await stub.scheduleInboundDraft({
		operationId: claim.operation.id,
		mailboxId,
		emailId: messageId,
		sender: (parsedEmail.from?.address || "").toLowerCase(),
		subject: parsedEmail.subject || "",
		threadId,
	});
}

export { app, receiveEmail };
