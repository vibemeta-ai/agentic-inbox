// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { ApiError } from "~/services/api";
import type { InboundOperation } from "~/types";
import { queryKeys } from "./keys";

const ACTIVE_STATES = new Set([
	"received",
	"storing_attachments",
	"intake_committed",
	"drafting",
]);

export function useInboundOperation(
	mailboxId: string | undefined,
	emailId: string | undefined,
) {
	return useQuery<InboundOperation | null>({
		queryKey:
			mailboxId && emailId
				? queryKeys.emails.operation(mailboxId, emailId)
				: ["emails", "_disabled_operation"],
		queryFn: async ({ signal }) => {
			try {
				return await api.getEmailOperation(mailboxId!, emailId!, { signal });
			} catch (error) {
				if (error instanceof ApiError && error.status === 404) return null;
				throw error;
			}
		},
		enabled: !!mailboxId && !!emailId,
		refetchInterval: (query) =>
			query.state.data && ACTIVE_STATES.has(query.state.data.state)
				? 1_500
				: false,
	});
}

export function useRetryInboundDraft() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, emailId }: { mailboxId: string; emailId: string }) =>
			api.retryEmailDraft(mailboxId, emailId),
		onSuccess: (operation, { mailboxId, emailId }) => {
			queryClient.setQueryData(
				queryKeys.emails.operation(mailboxId, emailId),
				operation,
			);
		},
	});
}
