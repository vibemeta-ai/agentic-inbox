// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const folders = sqliteTable("folders", {
	id: text("id").primaryKey(),
	name: text("name").notNull().unique(),
	is_deletable: integer("is_deletable").notNull().default(1),
});

export const emails = sqliteTable("emails", {
	id: text("id").primaryKey(),
	folder_id: text("folder_id")
		.notNull()
		.references(() => folders.id, { onDelete: "cascade" }),
	subject: text("subject"),
	sender: text("sender"),
	recipient: text("recipient"),
	cc: text("cc"),
	bcc: text("bcc"),
	date: text("date"),
	read: integer("read").default(0),
	starred: integer("starred").default(0),
	body: text("body"),
	in_reply_to: text("in_reply_to"),
	email_references: text("email_references"),
	thread_id: text("thread_id"),
	message_id: text("message_id"),
	raw_headers: text("raw_headers"),
});

export const attachments = sqliteTable("attachments", {
	id: text("id").primaryKey(),
	email_id: text("email_id")
		.notNull()
		.references(() => emails.id, { onDelete: "cascade" }),
	filename: text("filename").notNull(),
	mimetype: text("mimetype").notNull(),
	size: integer("size").notNull(),
	content_id: text("content_id"),
	disposition: text("disposition"),
});

export const inboundOperations = sqliteTable("inbound_operations", {
	id: text("id").primaryKey(),
	external_identity: text("external_identity").notNull().unique(),
	payload_hash: text("payload_hash").notNull(),
	email_id: text("email_id").notNull().unique(),
	state: text("state").notNull(),
	intake_attempts: integer("intake_attempts").notNull().default(0),
	attachment_manifest: text("attachment_manifest"),
	last_intake_error: text("last_intake_error"),
	last_intake_failed_at: text("last_intake_failed_at"),
	pending_agent_trigger: text("pending_agent_trigger"),
	current_draft_id: text("current_draft_id"),
	last_error: text("last_error"),
	agent_attempts: integer("agent_attempts").notNull().default(0),
	conflict_count: integer("conflict_count").notNull().default(0),
	last_conflict_payload_hash: text("last_conflict_payload_hash"),
	last_conflict_at: text("last_conflict_at"),
	created_at: text("created_at").notNull(),
	updated_at: text("updated_at").notNull(),
});
