// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface SignatureSettings {
	enabled: boolean;
	text: string;
	html?: string;
}

export interface MailboxSettings {
	fromName?: string;
	forwarding?: { enabled: boolean; email: string };
	signature?: SignatureSettings;
	autoReply?: { enabled: boolean; subject: string; message: string };
	agentSystemPrompt?: string;
}

export interface Mailbox {
	id: string;
	email: string;
	name: string;
	settings?: MailboxSettings;
}

export interface Email {
	id: string;
	thread_id?: string | null;
	folder_id?: string | null;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string;
	bcc?: string;
	date: string;
	read: boolean;
	starred: boolean;
	body?: string | null;
	in_reply_to?: string | null;
	email_references?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	attachments?: Attachment[];
	snippet?: string | null;
	// Thread aggregate fields (only present in threaded list view)
	thread_count?: number;
	thread_unread_count?: number;
	participants?: string;
	needs_reply?: boolean;
	has_draft?: boolean;
}

export interface Attachment {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string;
	disposition?: string;
}

export interface InboundOperation {
	id: string;
	externalIdentity: string;
	payloadHash: string;
	emailId: string;
	state:
		| "received"
		| "storing_attachments"
		| "intake_failed"
		| "intake_committed"
		| "drafting"
		| "draft_failed"
		| "awaiting_human_review"
		| "rejected"
		| "approved"
		| "delivery_pending"
		| "sent"
		| "delivery_failed";
	intakeAttempts: number;
	attachmentManifest: Array<{
		id: string;
		key: string;
		filename: string;
		size: number;
		mimetype: string;
	}>;
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

export interface Folder {
	id: string;
	name: string;
	unreadCount: number;
}
