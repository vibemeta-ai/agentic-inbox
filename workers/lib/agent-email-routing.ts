// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentEmail } from "agents";
import type { EmailResolver } from "agents/email";
import type { Env } from "../types";

export const resolveAllowlistedEmailAgent: EmailResolver<Env> = async (
	email,
	env,
) => {
	const recipient = email.to.trim().toLowerCase();
	const allowedAddresses = new Set(
		((env.EMAIL_ADDRESSES ?? []) as string[])
			.map((address) => address.trim().toLowerCase())
			.filter(Boolean),
	);

	if (!allowedAddresses.has(recipient)) return null;

	return {
		agentName: "EMAIL_AGENT",
		agentId: recipient,
	};
};

export async function routeInboundEmailToAgent(
	email: ForwardableEmailMessage,
	env: Env,
) {
	await routeAgentEmail(email, env, {
		resolver: resolveAllowlistedEmailAgent,
		onNoRoute(message) {
			message.setReject("Unknown recipient");
		},
	});
}
