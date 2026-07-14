// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { getAgentByName } from "agents";
import type { Env } from "../types";

export function getEmailAgentStub(
	namespace: Env["EMAIL_AGENT"],
	mailboxId: string,
) {
	return getAgentByName(namespace, mailboxId);
}
