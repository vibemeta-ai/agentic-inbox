// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, and, or, asc, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import { applyMigrations, mailboxMigrations } from "./migrations";

/**
 * SQL expression to normalize email subjects by stripping common
 * reply/forward prefixes (Re:, Fwd:, FW:, AW:, WG:, Réf:, SV:).
 * Used for conversation grouping. Hardcoded to the `subject` column.
 */
const NORMALIZED_SUBJECT_SQL = `LOWER(TRIM(
	REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
		LOWER(subject),
		'aw: ', ''), 'wg: ', ''), 'réf: ', ''), 'sv: ', ''),
		're: ', ''), 'fwd: ', ''), 'fw: ', '')
))`;

const ALLOWED_SORT_COLUMNS = [
	"id",
	"subject",
	"sender",
	"recipient",
	"date",
	"read",
	"starred",
] as const;

const INBOUND_INTAKE_LEASE_MS = 60_000;

type SortColumn = (typeof ALLOWED_SORT_COLUMNS)[number];

/**
 * Map SortColumn string names to Drizzle column references for safe
 * ORDER BY construction (no string interpolation into SQL).
 */
const SORT_COLUMN_MAP = {
	id: schema.emails.id,
	subject: schema.emails.subject,
	sender: schema.emails.sender,
	recipient: schema.emails.recipient,
	date: schema.emails.date,
	read: schema.emails.read,
	starred: schema.emails.starred,
} satisfies Record<SortColumn, typeof schema.emails[keyof typeof schema.emails]>;

interface SearchFilterOptions {
	query: string;
	folder?: string;
	from?: string;
	to?: string;
	subject?: string;
	date_start?: string;
	date_end?: string;
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
}

interface GetEmailsOptions {
	folder?: string;
	thread_id?: string;
	page?: number;
	limit?: number;
	sortColumn?: SortColumn;
	sortDirection?: "ASC" | "DESC";
}

interface EmailData {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	body: string;
	read?: boolean;
	starred?: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
}

interface AttachmentData {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

interface InboundOperationInput {
	externalIdentity: string;
	payloadHash: string;
}

interface CommitInboundOperationInput {
	operationId: string;
	email: Omit<EmailData, "id">;
	attachments: Array<Omit<AttachmentData, "email_id">>;
}

interface InboundAttachmentManifestEntry {
	id: string;
	key: string;
	filename: string;
	size: number;
	mimetype: string;
}

interface PrepareInboundIntakeInput {
	operationId: string;
	attachmentManifest: InboundAttachmentManifestEntry[];
}

interface CommitCurrentDraftInput {
	operationId: string;
	draft: Omit<EmailData, "id">;
}

interface InboundAgentTrigger {
	operationId: string;
	mailboxId: string;
	emailId: string;
	sender: string;
	subject: string;
	threadId: string;
	operationStarted: true;
}

interface InboundOperation {
	id: string;
	externalIdentity: string;
	payloadHash: string;
	emailId: string;
	state: string;
	intakeAttempts: number;
	attachmentManifest: InboundAttachmentManifestEntry[];
	lastIntakeError: string | null;
	lastIntakeFailedAt: string | null;
	agentTriggerPending: boolean;
	currentDraftId: string | null;
	lastError: string | null;
	agentAttempts: number;
	conflictCount: number;
	lastConflictPayloadHash: string | null;
	lastConflictAt: string | null;
	createdAt: string;
	updatedAt: string;
}

interface InboundOperationRow {
	id: string;
	external_identity: string;
	payload_hash: string;
	email_id: string;
	state: string;
	intake_attempts: number;
	attachment_manifest: string | null;
	last_intake_error: string | null;
	last_intake_failed_at: string | null;
	pending_agent_trigger: string | null;
	current_draft_id: string | null;
	last_error: string | null;
	agent_attempts: number;
	conflict_count: number;
	last_conflict_payload_hash: string | null;
	last_conflict_at: string | null;
	created_at: string;
	updated_at: string;
}

function toInboundOperation(row: InboundOperationRow): InboundOperation {
	return {
		id: row.id,
		externalIdentity: row.external_identity,
		payloadHash: row.payload_hash,
		emailId: row.email_id,
		state: row.state,
		intakeAttempts: row.intake_attempts,
		attachmentManifest: row.attachment_manifest
			? JSON.parse(row.attachment_manifest) as InboundAttachmentManifestEntry[]
			: [],
		lastIntakeError: row.last_intake_error,
		lastIntakeFailedAt: row.last_intake_failed_at,
		agentTriggerPending: row.pending_agent_trigger !== null,
		currentDraftId: row.current_draft_id,
		lastError: row.last_error,
		agentAttempts: row.agent_attempts,
		conflictCount: row.conflict_count,
		lastConflictPayloadHash: row.last_conflict_payload_hash,
		lastConflictAt: row.last_conflict_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

async function stableId(prefix: string, value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const hex = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${prefix}_${hex}`;
}

export class MailboxDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	db: ReturnType<typeof drizzle>;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.db = drizzle(this.ctx.storage, { schema });
		applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);
	}

	async claimInboundOperation(input: InboundOperationInput) {
		const externalIdentity = input.externalIdentity.trim().toLowerCase();
		const payloadHash = input.payloadHash.trim().toLowerCase();

		if (!externalIdentity || externalIdentity.length > 1024) {
			throw new TypeError("externalIdentity must be between 1 and 1024 characters");
		}
		if (!payloadHash || payloadHash.length > 256) {
			throw new TypeError("payloadHash must be between 1 and 256 characters");
		}

		const operationId = await stableId("inbound", externalIdentity);
		const emailId = await stableId("email", externalIdentity);

		return this.ctx.storage.transactionSync(() => {
			const existing = [
				...this.ctx.storage.sql.exec(
					"SELECT * FROM inbound_operations WHERE external_identity = ?1",
					externalIdentity,
				),
			][0] as unknown as InboundOperationRow | undefined;

			if (existing) {
				if (existing.payload_hash !== payloadHash) {
					const now = new Date().toISOString();
					this.ctx.storage.sql.exec(
						`UPDATE inbound_operations
						 SET conflict_count = conflict_count + 1,
						     last_conflict_payload_hash = ?2,
						     last_conflict_at = ?3,
						     updated_at = ?3
						 WHERE id = ?1`,
						existing.id,
						payloadHash,
						now,
					);
					const conflicted = [
						...this.ctx.storage.sql.exec(
							"SELECT * FROM inbound_operations WHERE id = ?1",
							existing.id,
						),
					][0] as unknown as InboundOperationRow;
					return {
						kind: "conflict",
						operation: toInboundOperation(conflicted),
					};
				}
				return {
					kind: "replay",
					operation: toInboundOperation(existing),
				};
			}

			const now = new Date().toISOString();
			this.ctx.storage.sql.exec(
				`INSERT INTO inbound_operations (
					id, external_identity, payload_hash, email_id, state,
					current_draft_id, last_error, agent_attempts, conflict_count,
					last_conflict_payload_hash, last_conflict_at, created_at, updated_at
				) VALUES (
					?1, ?2, ?3, ?4, 'received', NULL, NULL, 0, 0,
					NULL, NULL, ?5, ?5
				)`,
				operationId,
				externalIdentity,
				payloadHash,
				emailId,
				now,
			);

			const created = [
				...this.ctx.storage.sql.exec(
					"SELECT * FROM inbound_operations WHERE id = ?1",
					operationId,
				),
			][0] as unknown as InboundOperationRow;

			return {
				kind: "created",
				operation: toInboundOperation(created),
			};
		});
	}

	async prepareInboundIntake(input: PrepareInboundIntakeInput) {
		if (!input.operationId) throw new TypeError("operationId is required");
		if (input.attachmentManifest.length > 100) {
			throw new TypeError("attachmentManifest exceeds 100 entries");
		}
		const manifest = JSON.stringify(input.attachmentManifest);
		if (manifest.length > 64 * 1024) {
			throw new TypeError("attachmentManifest exceeds 64 KiB");
		}

		return this.ctx.storage.transactionSync(() => {
			const existing = [
				...this.ctx.storage.sql.exec(
					"SELECT * FROM inbound_operations WHERE id = ?1",
					input.operationId,
				),
			][0] as unknown as InboundOperationRow | undefined;

			if (!existing) throw new Error("Inbound operation not found");
			for (const attachment of input.attachmentManifest) {
				const expectedKey =
					`attachments/${existing.email_id}/${attachment.id}/${attachment.filename}`;
				if (attachment.key !== expectedKey) {
					throw new TypeError("attachmentManifest contains an invalid R2 key");
				}
				if (
					!attachment.id ||
					!attachment.filename ||
					!attachment.mimetype ||
					!Number.isInteger(attachment.size) ||
					attachment.size < 0
				) {
					throw new TypeError("attachmentManifest contains invalid metadata");
				}
			}
				const activeIntakeLease =
					existing.state === "storing_attachments" &&
					Date.now() - Date.parse(existing.updated_at) < INBOUND_INTAKE_LEASE_MS;
				if (
					activeIntakeLease ||
					(
						existing.state !== "received" &&
						existing.state !== "storing_attachments" &&
						existing.state !== "intake_failed"
					)
				) {
				return {
					kind: "replay",
					operation: toInboundOperation(existing),
				};
			}

			const now = new Date().toISOString();
			this.ctx.storage.sql.exec(
				`UPDATE inbound_operations
				 SET state = 'storing_attachments',
				     intake_attempts = intake_attempts + 1,
				     attachment_manifest = ?2,
				     last_error = NULL,
				     updated_at = ?3
				 WHERE id = ?1`,
				input.operationId,
				manifest,
				now,
			);
			const prepared = [
				...this.ctx.storage.sql.exec(
					"SELECT * FROM inbound_operations WHERE id = ?1",
					input.operationId,
				),
			][0] as unknown as InboundOperationRow;

			return {
				kind: "prepared",
				operation: toInboundOperation(prepared),
			};
		});
	}

	async failInboundIntake(operationId: string, error: string) {
		const failure = error.trim().slice(0, 1000) || "unknown_intake_failure";
		return this.ctx.storage.transactionSync(() => {
			const existing = [
				...this.ctx.storage.sql.exec(
					"SELECT * FROM inbound_operations WHERE id = ?1",
					operationId,
				),
			][0] as unknown as InboundOperationRow | undefined;

			if (!existing) throw new Error("Inbound operation not found");
			if (
				existing.state !== "received" &&
				existing.state !== "storing_attachments" &&
				existing.state !== "intake_failed"
			) {
				return {
					kind: "replay",
					operation: toInboundOperation(existing),
				};
			}

			const now = new Date().toISOString();
			this.ctx.storage.sql.exec(
				`UPDATE inbound_operations
				 SET state = 'intake_failed', last_error = ?2,
				     last_intake_error = ?2, last_intake_failed_at = ?3,
				     updated_at = ?3
				 WHERE id = ?1`,
				operationId,
				failure,
				now,
			);
			const failed = [
				...this.ctx.storage.sql.exec(
					"SELECT * FROM inbound_operations WHERE id = ?1",
					operationId,
				),
			][0] as unknown as InboundOperationRow;

			return {
				kind: "failed",
				operation: toInboundOperation(failed),
			};
		});
	}

	async commitInboundOperation(input: CommitInboundOperationInput) {
		if (!input.operationId) {
			throw new TypeError("operationId is required");
		}

		return this.ctx.storage.transactionSync(() => {
			const existing = [
				...this.ctx.storage.sql.exec(
					"SELECT * FROM inbound_operations WHERE id = ?1",
					input.operationId,
				),
			][0] as unknown as InboundOperationRow | undefined;

			if (!existing) {
				throw new Error("Inbound operation not found");
			}

			if (existing.state !== "storing_attachments") {
				if (
					existing.state === "intake_committed" ||
					existing.state === "drafting" ||
					existing.state === "draft_failed" ||
					existing.state === "awaiting_human_review"
				) {
					return {
						kind: "replay",
						operation: toInboundOperation(existing),
					};
				}
				throw new Error(`Cannot commit intake from state ${existing.state}`);
			}

			const email = input.email;
			this.ctx.storage.sql.exec(
				`INSERT INTO emails (
					id, folder_id, subject, sender, recipient, cc, bcc, date,
					read, starred, body, in_reply_to, email_references,
					thread_id, message_id, raw_headers
				) VALUES (
					?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
					?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
				)`,
				existing.email_id,
				Folders.INBOX,
				email.subject,
				email.sender,
				email.recipient,
				email.cc ?? null,
				email.bcc ?? null,
				email.date,
				email.read ? 1 : 0,
				email.starred ? 1 : 0,
				email.body,
				email.in_reply_to ?? null,
				email.email_references ?? null,
				email.thread_id ?? existing.email_id,
				email.message_id ?? null,
				email.raw_headers ?? null,
			);

			for (const attachment of input.attachments) {
				this.ctx.storage.sql.exec(
					`INSERT INTO attachments (
						id, email_id, filename, mimetype, size, content_id, disposition
					) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
					attachment.id,
					existing.email_id,
					attachment.filename,
					attachment.mimetype,
					attachment.size,
					attachment.content_id ?? null,
					attachment.disposition ?? null,
				);
			}

			const now = new Date().toISOString();
			this.ctx.storage.sql.exec(
				`UPDATE inbound_operations
				 SET state = 'intake_committed', updated_at = ?2
				 WHERE id = ?1`,
				input.operationId,
				now,
			);

			const committed = [
				...this.ctx.storage.sql.exec(
					"SELECT * FROM inbound_operations WHERE id = ?1",
					input.operationId,
				),
			][0] as unknown as InboundOperationRow;

			return {
				kind: "committed",
				operation: toInboundOperation(committed),
			};
		});
	}

	async getInboundOperation(operationId: string) {
		const row = [
			...this.ctx.storage.sql.exec(
				"SELECT * FROM inbound_operations WHERE id = ?1",
				operationId,
			),
		][0] as unknown as InboundOperationRow | undefined;
		return row ? toInboundOperation(row) : null;
	}

	async getInboundOperationByEmailId(emailId: string) {
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM inbound_operations
				 WHERE email_id = ?1 OR current_draft_id = ?1
				 LIMIT 1`,
				emailId,
			),
		][0] as unknown as InboundOperationRow | undefined;
		return row ? toInboundOperation(row) : null;
	}

	async getTeachingResetPlan() {
		const attachments = [
			...this.ctx.storage.sql.exec(
				"SELECT email_id, id, filename FROM attachments ORDER BY email_id, id",
			),
		] as unknown as Array<{
			email_id: string;
			id: string;
			filename: string;
		}>;
		const manifestRows = [
			...this.ctx.storage.sql.exec(
				`SELECT attachment_manifest
				 FROM inbound_operations
				 WHERE attachment_manifest IS NOT NULL`,
			),
		] as unknown as Array<{ attachment_manifest: string }>;
		const attachmentKeys = new Set(
			attachments.map(
				(attachment) =>
					`attachments/${attachment.email_id}/${attachment.id}/${attachment.filename}`,
			),
		);
		for (const row of manifestRows) {
			const manifest = JSON.parse(
				row.attachment_manifest,
			) as InboundAttachmentManifestEntry[];
			for (const attachment of manifest) {
				if (attachment.key.startsWith("attachments/")) {
					attachmentKeys.add(attachment.key);
				}
			}
		}
		return {
			attachmentKeys: [...attachmentKeys].sort(),
		};
	}

	async listInboundOperations(limit = 100) {
		const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
		const rows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM inbound_operations
				 ORDER BY updated_at DESC
				 LIMIT ?1`,
				boundedLimit,
			),
		] as unknown as InboundOperationRow[];
		return rows.map(toInboundOperation);
	}

	async resetTeachingScenario() {
		return this.ctx.storage.transactionSync(() => {
			const counts = {
				operations: [
					...this.ctx.storage.sql.exec(
						"SELECT COUNT(*) AS count FROM inbound_operations",
					),
				][0] as unknown as { count: number },
				emails: [
					...this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM emails"),
				][0] as unknown as { count: number },
			};
			this.ctx.storage.sql.exec("DELETE FROM attachments");
			this.ctx.storage.sql.exec("DELETE FROM emails");
			this.ctx.storage.sql.exec("DELETE FROM inbound_operations");
			this.ctx.storage.sql.exec("DELETE FROM folders WHERE is_deletable = 1");
			return {
				removedOperations: counts.operations.count,
				removedEmails: counts.emails.count,
			};
		});
	}

	async startInboundDraft(operationId: string) {
		return this.ctx.storage.transactionSync(() => {
			const existing = [
				...this.ctx.storage.sql.exec(
					"SELECT * FROM inbound_operations WHERE id = ?1",
					operationId,
				),
			][0] as unknown as InboundOperationRow | undefined;

			if (!existing) throw new Error("Inbound operation not found");
			if (existing.current_draft_id || existing.state === "awaiting_human_review") {
				return {
					kind: "replay",
					operation: toInboundOperation(existing),
				};
			}
			if (existing.state === "drafting") {
				return {
					kind: "replay",
					operation: toInboundOperation(existing),
				};
			}
			if (
				existing.state !== "intake_committed" &&
				existing.state !== "draft_failed"
			) {
				throw new Error(`Cannot start Draft from state ${existing.state}`);
			}

			const now = new Date().toISOString();
			this.ctx.storage.sql.exec(
				`UPDATE inbound_operations
				 SET state = 'drafting', last_error = NULL,
				     agent_attempts = agent_attempts + 1, updated_at = ?2
				 WHERE id = ?1`,
				operationId,
				now,
			);
			const started = [
				...this.ctx.storage.sql.exec(
					"SELECT * FROM inbound_operations WHERE id = ?1",
					operationId,
				),
			][0] as unknown as InboundOperationRow;

			return {
				kind: "started",
				operation: toInboundOperation(started),
			};
		});
	}

	async scheduleInboundDraft(trigger: Omit<InboundAgentTrigger, "operationStarted">) {
		const queuedTrigger: InboundAgentTrigger = {
			...trigger,
			operationStarted: true,
		};
		const scheduled = this.ctx.storage.transactionSync(() => {
			const existing = [
				...this.ctx.storage.sql.exec(
					"SELECT * FROM inbound_operations WHERE id = ?1",
					trigger.operationId,
				),
			][0] as unknown as InboundOperationRow | undefined;

			if (!existing) throw new Error("Inbound operation not found");
			if (
				existing.current_draft_id ||
				existing.state === "awaiting_human_review" ||
				existing.state === "rejected" ||
				existing.state === "drafting"
			) {
				return {
					kind: "replay" as const,
					operation: toInboundOperation(existing),
				};
			}
			if (
				existing.state !== "intake_committed" &&
				existing.state !== "draft_failed"
			) {
				throw new Error(`Cannot schedule Draft from state ${existing.state}`);
			}

			const now = new Date().toISOString();
			this.ctx.storage.sql.exec(
				`UPDATE inbound_operations
				 SET state = 'drafting', last_error = NULL,
				     agent_attempts = agent_attempts + 1,
				     pending_agent_trigger = ?2, updated_at = ?3
				 WHERE id = ?1`,
				trigger.operationId,
				JSON.stringify(queuedTrigger),
				now,
			);
			const row = [
				...this.ctx.storage.sql.exec(
					"SELECT * FROM inbound_operations WHERE id = ?1",
					trigger.operationId,
				),
			][0] as unknown as InboundOperationRow;
			return {
				kind: "scheduled" as const,
				operation: toInboundOperation(row),
			};
		});

		if (scheduled.kind === "scheduled") {
			try {
				await this.ctx.storage.setAlarm(Date.now() + 1_000);
			} catch (error) {
				await this.failInboundDraft(
					trigger.operationId,
					`agent_schedule_failed:${error instanceof Error ? error.message : String(error)}`,
				);
				throw error;
			}
		}
		return scheduled;
	}

	async alarm() {
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM inbound_operations
				 WHERE pending_agent_trigger IS NOT NULL
				 ORDER BY updated_at ASC
				 LIMIT 1`,
			),
		][0] as unknown as InboundOperationRow | undefined;
		if (!row?.pending_agent_trigger) return;

		const trigger = JSON.parse(row.pending_agent_trigger) as InboundAgentTrigger;
		try {
			const agent = this.env.EMAIL_AGENT.get(
				this.env.EMAIL_AGENT.idFromName(trigger.mailboxId),
			);
			const response = await agent.fetch(new Request("https://agents/onNewEmail", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(trigger),
			}));
			if (!response.ok) throw new Error(`agent_trigger_http_${response.status}`);

			const current = await this.getInboundOperation(trigger.operationId);
			if (current?.state === "drafting") {
				throw new Error("agent_completed_without_state_transition");
			}
		} catch (error) {
			await this.failInboundDraft(
				trigger.operationId,
				error instanceof Error ? error.message : String(error),
			);
		}

		const pending = [
			...this.ctx.storage.sql.exec(
				`SELECT 1 FROM inbound_operations
				 WHERE pending_agent_trigger IS NOT NULL
				 LIMIT 1`,
			),
		];
		if (pending.length > 0) await this.ctx.storage.setAlarm(Date.now() + 1_000);
	}

	async failInboundDraft(operationId: string, error: string) {
		const lastError = error.trim().slice(0, 1000) || "unknown_agent_failure";
		return this.ctx.storage.transactionSync(() => {
			const existing = [
				...this.ctx.storage.sql.exec(
					"SELECT * FROM inbound_operations WHERE id = ?1",
					operationId,
				),
			][0] as unknown as InboundOperationRow | undefined;

			if (!existing) throw new Error("Inbound operation not found");
			if (existing.current_draft_id || existing.state === "awaiting_human_review") {
				return {
					kind: "replay",
					operation: toInboundOperation(existing),
				};
			}
			if (existing.state === "draft_failed") {
				return {
					kind: "replay",
					operation: toInboundOperation(existing),
				};
			}
			if (
				existing.state !== "intake_committed" &&
				existing.state !== "drafting"
			) {
				throw new Error(`Cannot fail Draft from state ${existing.state}`);
			}

			const now = new Date().toISOString();
			this.ctx.storage.sql.exec(
				`UPDATE inbound_operations
				 SET state = 'draft_failed', last_error = ?2,
				     pending_agent_trigger = NULL, updated_at = ?3
				 WHERE id = ?1`,
				operationId,
				lastError,
				now,
			);
			const failed = [
				...this.ctx.storage.sql.exec(
					"SELECT * FROM inbound_operations WHERE id = ?1",
					operationId,
				),
			][0] as unknown as InboundOperationRow;

			return {
				kind: "failed",
				operation: toInboundOperation(failed),
			};
		});
	}

	async commitCurrentDraft(input: CommitCurrentDraftInput) {
		const draftId = await stableId("draft", input.operationId);
		return this.ctx.storage.transactionSync(() => {
			const existing = [
				...this.ctx.storage.sql.exec(
					"SELECT * FROM inbound_operations WHERE id = ?1",
					input.operationId,
				),
			][0] as unknown as InboundOperationRow | undefined;

			if (!existing) throw new Error("Inbound operation not found");
			if (existing.current_draft_id) {
				return {
					kind: "replay",
					draftId: existing.current_draft_id,
					operation: toInboundOperation(existing),
				};
			}
			if (existing.state !== "drafting") {
				throw new Error(`Cannot commit Draft from state ${existing.state}`);
			}

			const draft = input.draft;
			this.ctx.storage.sql.exec(
				`INSERT INTO emails (
					id, folder_id, subject, sender, recipient, cc, bcc, date,
					read, starred, body, in_reply_to, email_references,
					thread_id, message_id, raw_headers
				) VALUES (
					?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
					0, 0, ?9, ?10, ?11, ?12, ?13, ?14
				)`,
				draftId,
				Folders.DRAFT,
				draft.subject,
				draft.sender,
				draft.recipient,
				draft.cc ?? null,
				draft.bcc ?? null,
				draft.date,
				draft.body,
				draft.in_reply_to ?? existing.email_id,
				draft.email_references ?? null,
				draft.thread_id ?? existing.email_id,
				draft.message_id ?? null,
				draft.raw_headers ?? null,
			);

			const now = new Date().toISOString();
			this.ctx.storage.sql.exec(
				`UPDATE inbound_operations
				 SET state = 'awaiting_human_review', current_draft_id = ?2,
				     last_error = NULL, pending_agent_trigger = NULL, updated_at = ?3
				 WHERE id = ?1`,
				input.operationId,
				draftId,
				now,
			);
			const committed = [
				...this.ctx.storage.sql.exec(
					"SELECT * FROM inbound_operations WHERE id = ?1",
					input.operationId,
				),
			][0] as unknown as InboundOperationRow;

			return {
				kind: "committed",
				draftId,
				operation: toInboundOperation(committed),
			};
		});
	}

	async updateDraft(id: string, draft: Omit<EmailData, "id">) {
		return this.ctx.storage.transactionSync(() => {
			const existing = [
				...this.ctx.storage.sql.exec(
					"SELECT folder_id FROM emails WHERE id = ?1",
					id,
				),
			][0] as { folder_id: string } | undefined;
			if (!existing || existing.folder_id !== Folders.DRAFT) return null;

			const operation = [
				...this.ctx.storage.sql.exec(
					"SELECT * FROM inbound_operations WHERE current_draft_id = ?1",
					id,
				),
			][0] as unknown as InboundOperationRow | undefined;
			if (operation && operation.state !== "awaiting_human_review") {
				throw new Error(`Cannot edit operation Draft from state ${operation.state}`);
			}

			this.ctx.storage.sql.exec(
				`UPDATE emails
				 SET subject = ?2, sender = ?3, recipient = ?4, cc = ?5, bcc = ?6,
				     date = ?7, body = ?8, in_reply_to = ?9, email_references = ?10,
				     thread_id = ?11, message_id = ?12, raw_headers = ?13
				 WHERE id = ?1`,
				id,
				draft.subject,
				draft.sender,
				draft.recipient,
				draft.cc ?? null,
				draft.bcc ?? null,
				draft.date,
				draft.body,
				draft.in_reply_to ?? null,
				draft.email_references ?? null,
				draft.thread_id ?? id,
				draft.message_id ?? null,
				draft.raw_headers ?? null,
			);
			if (operation) {
				this.ctx.storage.sql.exec(
					"UPDATE inbound_operations SET updated_at = ?2 WHERE id = ?1",
					operation.id,
					new Date().toISOString(),
				);
			}
			return { id, operation: operation ? toInboundOperation(operation) : null };
		});
	}

	async rejectCurrentDraft(id: string) {
		return this.ctx.storage.transactionSync(() => {
			const operation = [
				...this.ctx.storage.sql.exec(
					"SELECT * FROM inbound_operations WHERE current_draft_id = ?1",
					id,
				),
			][0] as unknown as InboundOperationRow | undefined;
			if (!operation) return null;
			if (operation.state === "rejected") {
				return { kind: "replay" as const, operation: toInboundOperation(operation) };
			}
			if (operation.state !== "awaiting_human_review") {
				throw new Error(`Cannot reject Draft from state ${operation.state}`);
			}

			const now = new Date().toISOString();
			this.ctx.storage.sql.exec(
				"UPDATE emails SET folder_id = ?2, date = ?3 WHERE id = ?1",
				id,
				Folders.TRASH,
				now,
			);
			this.ctx.storage.sql.exec(
				`UPDATE inbound_operations
				 SET state = 'rejected', last_error = NULL,
				     pending_agent_trigger = NULL, updated_at = ?2
				 WHERE id = ?1`,
				operation.id,
				now,
			);
			const rejected = [
				...this.ctx.storage.sql.exec(
					"SELECT * FROM inbound_operations WHERE id = ?1",
					operation.id,
				),
			][0] as unknown as InboundOperationRow;
			return { kind: "rejected" as const, operation: toInboundOperation(rejected) };
		});
	}

	// ── Email CRUD (Drizzle) ───────────────────────────────────────

	async getEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			thread_id,
			page = 1,
			limit: rawLimit = 25,
			sortColumn: rawSortColumn = "date",
			sortDirection = "DESC",
		} = options;

		// Cap pagination limit to prevent unbounded queries
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		const sortColumn: SortColumn = ALLOWED_SORT_COLUMNS.includes(
			rawSortColumn as SortColumn,
		)
			? rawSortColumn
			: "date";

		const offset = (page - 1) * limit;

		const conditions: SQL[] = [];
		if (folder) {
			conditions.push(
				sql`${schema.emails.folder_id} = (SELECT id FROM folders WHERE name = ${folder} OR id = ${folder} LIMIT 1)`,
			);
		}
		if (thread_id) {
			conditions.push(eq(schema.emails.thread_id, thread_id));
		}

		const orderCol = SORT_COLUMN_MAP[sortColumn];
		const orderDir = sortDirection === "ASC" ? asc(orderCol) : desc(orderCol);

		const result = this.db
			.select({
				id: schema.emails.id,
				subject: schema.emails.subject,
				sender: schema.emails.sender,
				recipient: schema.emails.recipient,
				cc: schema.emails.cc,
				bcc: schema.emails.bcc,
				date: schema.emails.date,
				read: schema.emails.read,
				starred: schema.emails.starred,
				in_reply_to: schema.emails.in_reply_to,
				email_references: schema.emails.email_references,
				thread_id: schema.emails.thread_id,
				folder_id: schema.emails.folder_id,
				snippet: sql<string>`SUBSTR(${schema.emails.body}, 1, 300)`,
			})
			.from(schema.emails)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(orderDir)
			.limit(limit)
			.offset(offset)
			.all();

		return result.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
		}));
	}

	/**
	 * Count total emails matching the given filters (for pagination).
	 */
	async countEmails(options: { folder?: string; thread_id?: string } = {}) {
		const { folder, thread_id } = options;
		const conditions: string[] = [];
		const params: (string | number)[] = [];

		if (folder) {
			conditions.push(
				"folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)",
			);
			params.push(folder);
		}

		if (thread_id) {
			conditions.push(`thread_id = ?${params.length + 1}`);
			params.push(thread_id);
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) as total FROM emails ${where}`,
				...params,
			),
		][0] as { total: number } | undefined;

		return row?.total ?? 0;
	}

	// ── Threaded queries (raw SQL — too complex for Drizzle's builder) ──

	async getThreadedEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			page = 1,
			limit: rawLimit = 25,
		} = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		if (!folder) {
			// Fallback to regular getEmails if no folder specified
			return this.getEmails(options);
		}

		const offset = (page - 1) * limit;

		// Thread grouping strategy:
		// For DRAFT folder: group by in_reply_to (the email being replied to).
		//   This ensures reply-drafts to different emails stay separate, even if
		//   they share a thread_id or subject. New drafts (no in_reply_to) each
		//   get their own group via their unique id.
		// For other folders:
		//   1. Primary: group by thread_id (from email threading headers)
		//   2. Fallback: group by normalized subject (strips Re:/Fwd:/FW: prefixes)
		//      for legacy emails that lack threading headers (thread_id IS NULL).
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const result = this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT *,
						COALESCE(in_reply_to, id) as draft_group_key
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				draft_stats AS (
					SELECT
						draft_group_key,
						COUNT(*) as thread_count,
						SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
						GROUP_CONCAT(DISTINCT sender) as participants
					FROM folder_emails
					GROUP BY draft_group_key
				),
				latest_per_group AS (
					SELECT
						fe.*,
						ROW_NUMBER() OVER (
							PARTITION BY fe.draft_group_key
							ORDER BY fe.date DESC
						) as rn
					FROM folder_emails fe
				)
				SELECT
					lp.id, lp.subject, lp.sender, lp.recipient, lp.date,
					lp.read, lp.starred, lp.thread_id, lp.folder_id,
					lp.in_reply_to, lp.email_references,
					SUBSTR(lp.body, 1, 300) as snippet,
					ds.thread_count, ds.thread_unread_count, ds.participants
				FROM latest_per_group lp
				JOIN draft_stats ds ON lp.draft_group_key = ds.draft_group_key
				WHERE lp.rn = 1
				ORDER BY lp.date DESC
				LIMIT ?2 OFFSET ?3`,
				folder, limit, offset
			);

			const rows = [...result];
			return rows.map((row: any) => ({
				...row,
				read: !!row.read,
				starred: !!row.starred,
				thread_count: row.thread_count || 1,
				thread_unread_count: row.thread_unread_count || 0,
				participants: row.participants || row.sender,
			}));
		}

		// Non-draft folders: full threading logic
		const result = this.ctx.storage.sql.exec(
			`WITH
			folder_emails AS (
				SELECT *,
					COALESCE(thread_id, id) as raw_thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
				FROM emails
				WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
			),
			thread_to_conversation AS (
				SELECT
					raw_thread_id,
					normalized_subject,
					CASE
						WHEN thread_id IS NOT NULL THEN raw_thread_id
						ELSE MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
					END as conversation_id
				FROM folder_emails
				GROUP BY raw_thread_id, normalized_subject, thread_id
			),
			all_emails_with_conversation AS (
				SELECT
					e.*,
					COALESCE(tc.conversation_id, COALESCE(e.thread_id, e.id)) as conversation_id
				FROM emails e
				LEFT JOIN thread_to_conversation tc
					ON COALESCE(e.thread_id, e.id) = tc.raw_thread_id
			),
			conversation_stats AS (
				SELECT
					conversation_id,
					COUNT(*) as thread_count,
					SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
					SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as thread_read_count,
					GROUP_CONCAT(DISTINCT sender) as participants,
					SUM(CASE WHEN folder_id = (SELECT id FROM folders WHERE name = 'draft' LIMIT 1) THEN 1 ELSE 0 END) as has_draft
				FROM all_emails_with_conversation
				WHERE conversation_id IN (
					SELECT DISTINCT conversation_id FROM all_emails_with_conversation
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				)
				GROUP BY conversation_id
			),
			latest_message_per_conversation AS (
				SELECT
					conversation_id,
					folder_id,
					ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC) as rn
				FROM all_emails_with_conversation
			),
			latest_in_folder AS (
				SELECT
					fe.*,
					COALESCE(tc.conversation_id, fe.raw_thread_id) as conversation_id,
					ROW_NUMBER() OVER (
						PARTITION BY COALESCE(tc.conversation_id, fe.raw_thread_id)
						ORDER BY fe.date DESC
					) as rn
				FROM folder_emails fe
				LEFT JOIN thread_to_conversation tc
					ON fe.raw_thread_id = tc.raw_thread_id
			)
			SELECT
				lif.id, lif.subject, lif.sender, lif.recipient, lif.date,
				lif.read, lif.starred, lif.thread_id, lif.folder_id,
				lif.in_reply_to, lif.email_references,
				SUBSTR(lif.body, 1, 300) as snippet,
				cs.thread_count, cs.thread_unread_count, cs.participants,
				CASE WHEN lmc.folder_id != (SELECT id FROM folders WHERE name = 'sent' LIMIT 1)
					AND lmc.folder_id != (SELECT id FROM folders WHERE name = 'draft' LIMIT 1)
					AND cs.thread_read_count > 0
					THEN 1 ELSE 0 END as needs_reply,
				CASE WHEN cs.has_draft > 0 THEN 1 ELSE 0 END as has_draft
			FROM latest_in_folder lif
			JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
			LEFT JOIN latest_message_per_conversation lmc
				ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
			WHERE lif.rn = 1
			ORDER BY lif.date DESC
			LIMIT ?2 OFFSET ?3`,
			folder, limit, offset
		);

		const rows = [...result];
		return rows.map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			thread_count: row.thread_count || 1,
			thread_unread_count: row.thread_unread_count || 0,
			participants: row.participants || row.sender,
			needs_reply: !!row.needs_reply,
			has_draft: !!row.has_draft,
		}));
	}

	/**
	 * Count threaded conversations in a folder (for pagination).
	 * Returns the number of conversation groups, not individual emails.
	 */
	async countThreadedEmails(folder: string) {
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const row = [
				...this.ctx.storage.sql.exec(
					`SELECT COUNT(DISTINCT COALESCE(in_reply_to, id)) as total
					 FROM emails
					 WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)`,
					folder,
				),
			][0] as { total: number } | undefined;
			return row?.total ?? 0;
		}

		const row = [
			...this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT
						COALESCE(thread_id, id) as raw_thread_id,
						thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				thread_to_conversation AS (
					SELECT
						raw_thread_id,
						CASE
							WHEN thread_id IS NOT NULL THEN raw_thread_id
							WHEN normalized_subject != '' THEN MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
							ELSE raw_thread_id
						END as conversation_id
					FROM folder_emails
					GROUP BY raw_thread_id, normalized_subject, thread_id
				)
				SELECT COUNT(DISTINCT conversation_id) as total
				FROM thread_to_conversation`,
				folder,
			),
		][0] as { total: number } | undefined;
		return row?.total ?? 0;
	}

	// ── Single email operations (Drizzle) ──────────────────────────

	async getEmail(id: string) {
		const email = this.db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		return {
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: emailAttachments,
		};
	}

	/**
	 * Fetch all emails in a thread with full bodies and attachments in
	 * two queries (one for emails, one for attachments) instead of
	 * N+1 individual getEmail calls.
	 */
	async getThreadEmails(threadId: string) {
		const emailRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM emails WHERE thread_id = ?1 ORDER BY date ASC`,
				threadId,
			),
		] as any[];

		if (emailRows.length === 0) return [];

		const emailIds = emailRows.map((e) => e.id as string);

		// Batch-fetch all attachments for the thread in a single query
		const placeholders = emailIds.map((_, i) => `?${i + 1}`).join(",");
		const attachmentRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM attachments WHERE email_id IN (${placeholders})`,
				...emailIds,
			),
		] as any[];

		// Group attachments by email_id
		const attachmentsByEmail = new Map<string, any[]>();
		for (const att of attachmentRows) {
			const list = attachmentsByEmail.get(att.email_id) || [];
			list.push(att);
			attachmentsByEmail.set(att.email_id, list);
		}

		return emailRows.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: attachmentsByEmail.get(email.id) || [],
		}));
	}

	async updateEmail(
		id: string,
		{ read, starred }: { read?: boolean; starred?: boolean },
	) {
		const data: { read?: number; starred?: number } = {};
		if (read !== undefined) {
			data.read = read ? 1 : 0;
		}
		if (starred !== undefined) {
			data.starred = starred ? 1 : 0;
		}

		if (Object.keys(data).length === 0) {
			return this.getEmail(id);
		}

		this.db
			.update(schema.emails)
			.set(data)
			.where(eq(schema.emails.id, id))
			.run();

		return this.getEmail(id);
	}

	async markThreadRead(threadId: string) {
		this.ctx.storage.sql.exec(
			`UPDATE emails SET read = 1 WHERE thread_id = ? AND read = 0`,
			threadId,
		);
		return { threadId, markedRead: true };
	}

	async deleteEmail(id: string) {
		const sourceOperation = [
			...this.ctx.storage.sql.exec(
				"SELECT id, state FROM inbound_operations WHERE email_id = ?1 LIMIT 1",
				id,
			),
		][0] as { id: string; state: string } | undefined;
		if (sourceOperation) {
			return {
				kind: "blocked" as const,
				reason: "operation_source" as const,
				operationId: sourceOperation.id,
				state: sourceOperation.state,
			};
		}

		const email = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select({
				id: schema.attachments.id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		this.db
			.delete(schema.emails)
			.where(eq(schema.emails.id, id))
			.run();

		return { kind: "deleted" as const, attachments: emailAttachments };
	}

	async getAttachment(id: string) {
		return (
			this.db
				.select()
				.from(schema.attachments)
				.where(eq(schema.attachments.id, id))
				.get() ?? null
		);
	}

	// ── Folders (Drizzle) ──────────────────────────────────────────

	async getFolders() {
		const result = this.db
			.select({
				id: schema.folders.id,
				name: schema.folders.name,
				unreadCount: sql<number>`COALESCE(SUM(CASE WHEN ${schema.emails.read} = 0 THEN 1 ELSE 0 END), 0)`.mapWith(Number),
			})
			.from(schema.folders)
			.leftJoin(schema.emails, eq(schema.emails.folder_id, schema.folders.id))
			.groupBy(schema.folders.id, schema.folders.name)
			.all();
		return result;
	}

	async createFolder(id: string, name: string, is_deletable: number = 1) {
		try {
			const result = this.db
				.insert(schema.folders)
				.values({ id, name, is_deletable })
				.returning({ id: schema.folders.id, name: schema.folders.name })
				.get();
			return { ...result, unreadCount: 0 };
		} catch (e: unknown) {
			if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
				return null;
			}
			throw e;
		}
	}

	async updateFolder(id: string, name: string) {
		const result = this.db
			.update(schema.folders)
			.set({ name })
			.where(eq(schema.folders.id, id))
			.returning({ id: schema.folders.id, name: schema.folders.name })
			.get();
		return result;
	}

	async deleteFolder(id: string) {
		const folder = this.db
			.select({ is_deletable: schema.folders.is_deletable })
			.from(schema.folders)
			.where(eq(schema.folders.id, id))
			.get();

		if (!folder || folder.is_deletable === 0) {
			return false;
		}

		this.db
			.delete(schema.folders)
			.where(eq(schema.folders.id, id))
			.run();

		return true;
	}

	async moveEmail(id: string, folderId: string) {
		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, folderId))
			.get();

		if (!folder) return false;
		const operationDraft = [
			...this.ctx.storage.sql.exec(
				`SELECT 1 FROM inbound_operations
				 WHERE current_draft_id = ?1 AND state = 'awaiting_human_review'
				 LIMIT 1`,
				id,
			),
		];
		if (operationDraft.length > 0 && folderId !== Folders.DRAFT) return false;

		this.db
			.update(schema.emails)
			.set({ folder_id: folderId })
			.where(eq(schema.emails.id, id))
			.run();

		return true;
	}

	// ── Search (raw SQL — dynamic condition builder) ───────────────

	/**
	 * Build WHERE conditions and params for search queries.
	 * Shared between searchEmails and countSearchResults.
	 */
	#buildSearchConditions(
		options: SearchFilterOptions,
		tableAlias = "",
	): { conditions: string[]; params: (string | number)[] } {
		const { query, folder, from, to, subject, date_start, date_end, is_read, is_starred, has_attachment } = options;
		const prefix = tableAlias ? `${tableAlias}.` : "";
		const conditions: string[] = [];
		const params: (string | number)[] = [];
		let paramIdx = 0;

		const addParam = (value: string | number) => {
			paramIdx++;
			params.push(value);
			return `?${paramIdx}`;
		};

		if (query) {
			const p1 = addParam(`%${query}%`);
			const p2 = addParam(`%${query}%`);
			const p3 = addParam(`%${query}%`);
			const p4 = addParam(`%${query}%`);
			conditions.push(`(${prefix}subject LIKE ${p1} OR ${prefix}body LIKE ${p2} OR ${prefix}sender LIKE ${p3} OR ${prefix}recipient LIKE ${p4} OR ${prefix}cc LIKE ${p4} OR ${prefix}bcc LIKE ${p4})`);
		}
		if (folder) {
			const p = addParam(folder);
			conditions.push(`${prefix}folder_id = (SELECT id FROM folders WHERE name = ${p} OR id = ${p} LIMIT 1)`);
		}
		if (from) { const p = addParam(`%${from}%`); conditions.push(`${prefix}sender LIKE ${p}`); }
		if (to) { const p = addParam(`%${to}%`); conditions.push(`(${prefix}recipient LIKE ${p} OR ${prefix}cc LIKE ${p} OR ${prefix}bcc LIKE ${p})`); }
		if (subject) { const p = addParam(`%${subject}%`); conditions.push(`${prefix}subject LIKE ${p}`); }
		if (date_start) { const p = addParam(date_start); conditions.push(`${prefix}date >= ${p}`); }
		if (date_end) { const p = addParam(date_end); conditions.push(`${prefix}date <= ${p}`); }
		if (is_read !== undefined) { const p = addParam(is_read ? 1 : 0); conditions.push(`${prefix}read = ${p}`); }
		if (is_starred !== undefined) { const p = addParam(is_starred ? 1 : 0); conditions.push(`${prefix}starred = ${p}`); }
		if (has_attachment) { conditions.push(`${prefix}id IN (SELECT DISTINCT email_id FROM attachments)`); }

		return { conditions, params };
	}

	async searchEmails(options: SearchFilterOptions & { page?: number; limit?: number }) {
		const { page = 1, limit: rawLimit = 25 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);
		const { conditions, params } = this.#buildSearchConditions(options, "e");

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const offset = (page - 1) * limit;

		const query = `
			SELECT e.id, e.subject, e.sender, e.recipient, e.cc, e.bcc, e.date,
				e.read, e.starred, e.in_reply_to, e.email_references,
				e.thread_id, e.folder_id,
				SUBSTR(e.body, 1, 300) as snippet,
				f.name as folder_name
			FROM emails e
			LEFT JOIN folders f ON e.folder_id = f.id
			${where}
			ORDER BY e.date DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`;
		params.push(limit, offset);

		const result = this.ctx.storage.sql.exec(query, ...params);
		return [...result].map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
		}));
	}

	/**
	 * Count total search results matching the given filters (for pagination).
	 */
	async countSearchResults(options: SearchFilterOptions) {
		const { conditions, params } = this.#buildSearchConditions(options);

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const query = `SELECT COUNT(*) as total FROM emails ${where}`;

		const row = [...this.ctx.storage.sql.exec(query, ...params)][0] as
			| { total: number }
			| undefined;
		return row?.total ?? 0;
	}

	// ── Threading helpers (raw SQL) ────────────────────────────────

	async findThreadBySubject(subject: string, senderAddress?: string): Promise<string | null> {
		const normalized = subject
			.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
			.trim()
			.toLowerCase();

		if (!normalized) return null;

		const result = this.ctx.storage.sql.exec(
			`SELECT thread_id, subject,
			        GROUP_CONCAT(DISTINCT LOWER(sender)) as senders,
			        GROUP_CONCAT(DISTINCT LOWER(recipient)) as recipients
			 FROM emails
			 WHERE thread_id IS NOT NULL
			   AND thread_id != id
			   AND date >= datetime('now', '-7 days')
			 GROUP BY thread_id
			 ORDER BY MAX(date) DESC
			 LIMIT 50`,
		);

		const normalizedSender = senderAddress?.toLowerCase().trim();

		for (const row of result) {
			const rowSubject = String((row as any).subject || "")
				.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
				.trim()
				.toLowerCase();
			if (rowSubject !== normalized) continue;

			if (normalizedSender) {
				const threadSenders = String((row as any).senders || "");
				const threadRecipients = String((row as any).recipients || "");
				const allParticipants = `${threadSenders},${threadRecipients}`;
				if (!allParticipants.includes(normalizedSender)) {
					continue;
				}
			}

			return String((row as any).thread_id);
		}
		return null;
	}

	// ── Rate limiting (raw SQL) ────────────────────────────────────

	/**
	 * Check if the mailbox has exceeded the send rate limit.
	 * Limits: 20 emails per hour, 100 per day per mailbox.
	 * Returns null if under limit, or an error message string if exceeded.
	 */
	async checkSendRateLimit(): Promise<string | null> {
		const hourRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 hour')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((hourRow?.cnt ?? 0) >= 20) {
			return "Rate limit exceeded: max 20 emails per hour per mailbox";
		}

		const dayRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 day')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((dayRow?.cnt ?? 0) >= 100) {
			return "Rate limit exceeded: max 100 emails per day per mailbox";
		}

		return null;
	}

	// ── Email creation (Drizzle) ───────────────────────────────────

	async createEmail(
		folder: string,
		email: EmailData,
		attachments: AttachmentData[],
	) {
		// Resolve folder name or ID to the actual folder ID.
		const folderRow = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(or(eq(schema.folders.id, folder), eq(schema.folders.name, folder)))
			.limit(1)
			.get();

		if (!folderRow) {
			throw new Error(
				`createEmail: folder "${folder}" not found. ` +
					"Ensure the folder exists before inserting an email.",
			);
		}

		const folderId = folderRow.id;
		const isSent = folderId === Folders.SENT;

		// Sent emails are always read — the sender obviously knows what they wrote.
		// This prevents sent replies from inflating thread_unread_count.
		this.db
			.insert(schema.emails)
			.values({
				id: email.id,
				folder_id: folderId,
				subject: email.subject,
				sender: email.sender,
				recipient: email.recipient,
				cc: email.cc ?? null,
				bcc: email.bcc ?? null,
				date: email.date,
				read: isSent ? 1 : (email.read ? 1 : 0),
				starred: email.starred ? 1 : 0,
				body: email.body,
				in_reply_to: email.in_reply_to ?? null,
				email_references: email.email_references ?? null,
				thread_id: email.thread_id ?? null,
				message_id: email.message_id ?? null,
				raw_headers: email.raw_headers ?? null,
			})
			.run();

		if (attachments.length > 0) {
			this.db.insert(schema.attachments).values(attachments).run();
		}
	}
}
