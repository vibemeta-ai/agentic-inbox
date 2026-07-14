interface InboundAttachmentIdentity {
	filename?: string | null;
	mimeType: string;
	content: string | ArrayBuffer | Uint8Array;
	contentId?: string;
	disposition?: string | null;
}

interface InboundPayloadIdentityInput {
	mailboxId: string;
	sender: string;
	recipients: string[];
	cc: string[];
	bcc: string[];
	subject: string;
	body: string;
	attachments: InboundAttachmentIdentity[];
}

function bytesFrom(value: string | ArrayBuffer | Uint8Array): Uint8Array {
	if (typeof value === "string") return new TextEncoder().encode(value);
	if (value instanceof Uint8Array) return value;
	return new Uint8Array(value);
}

export async function sha256Hex(
	value: string | ArrayBuffer | Uint8Array,
): Promise<string> {
	const source = bytesFrom(value);
	const bytes = new Uint8Array(source.byteLength);
	bytes.set(source);
	const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function normalizeAddresses(values: string[]): string[] {
	return values.map((value) => value.trim().toLowerCase()).filter(Boolean).sort();
}

function normalizeBody(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
}

export function normalizeMessageIdentity(messageId: string): string {
	return messageId.trim().replace(/^<|>$/g, "").toLowerCase();
}

export async function createInboundPayloadHash(
	input: InboundPayloadIdentityInput,
): Promise<string> {
	const attachments = await Promise.all(
		input.attachments.map(async (attachment) => ({
			filename: (attachment.filename || "untitled").trim(),
			mimeType: attachment.mimeType.trim().toLowerCase(),
			contentId: attachment.contentId?.trim().toLowerCase() || null,
			disposition: attachment.disposition?.trim().toLowerCase() || "attachment",
			contentHash: await sha256Hex(attachment.content),
		})),
	);
	attachments.sort((left, right) =>
		JSON.stringify(left).localeCompare(JSON.stringify(right)),
	);

	const canonicalPayload = JSON.stringify({
		mailboxId: input.mailboxId.trim().toLowerCase(),
		sender: input.sender.trim().toLowerCase(),
		recipients: normalizeAddresses(input.recipients),
		cc: normalizeAddresses(input.cc),
		bcc: normalizeAddresses(input.bcc),
		subject: input.subject.trim(),
		body: normalizeBody(input.body),
		attachments,
	});

	return `sha256:${await sha256Hex(canonicalPayload)}`;
}

export async function createInboundExternalIdentity(input: {
	mailboxId: string;
	messageId: string | null;
	rawEmail: ArrayBuffer | Uint8Array;
}): Promise<string> {
	const mailboxId = input.mailboxId.trim().toLowerCase();
	if (input.messageId) {
		return `message:${mailboxId}:${normalizeMessageIdentity(input.messageId)}`;
	}
	return `content:${mailboxId}:${await sha256Hex(input.rawEmail)}`;
}

export async function createAttachmentIdentity(input: {
	operationId: string;
	index: number;
	filename: string;
	content: string | ArrayBuffer | Uint8Array;
}): Promise<string> {
	const contentHash = await sha256Hex(input.content);
	const identity = [
		input.operationId,
		input.index.toString(10),
		input.filename,
		contentHash,
	].join("\n");
	return `attachment_${await sha256Hex(identity)}`;
}
