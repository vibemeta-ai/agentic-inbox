// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	ArrowClockwiseIcon,
	CheckCircleIcon,
	ClockCountdownIcon,
	PencilSimpleLineIcon,
	UserFocusIcon,
	WarningCircleIcon,
} from "@phosphor-icons/react";
import type { InboundOperation } from "~/types";

const STATUS_CONTENT = {
	received: {
		label: "Request received",
		icon: ClockCountdownIcon,
		className: "text-kumo-subtle",
	},
	storing_attachments: {
		label: "Saving request",
		icon: ClockCountdownIcon,
		className: "text-kumo-subtle",
	},
	intake_failed: {
		label: "Request needs retry",
		icon: WarningCircleIcon,
		className: "text-kumo-error",
	},
	intake_committed: {
		label: "Waiting for Agent",
		icon: ClockCountdownIcon,
		className: "text-kumo-subtle",
	},
	drafting: {
		label: "Drafting response",
		icon: PencilSimpleLineIcon,
		className: "text-kumo-default",
	},
	draft_failed: {
		label: "Draft needs retry",
		icon: WarningCircleIcon,
		className: "text-kumo-error",
	},
	awaiting_human_review: {
		label: "Awaiting your review",
		icon: UserFocusIcon,
		className: "text-kumo-default",
	},
	rejected: {
		label: "Draft rejected",
		icon: WarningCircleIcon,
		className: "text-kumo-subtle",
	},
	approved: {
		label: "Approved",
		icon: CheckCircleIcon,
		className: "text-kumo-default",
	},
	delivery_pending: {
		label: "Delivery pending",
		icon: ClockCountdownIcon,
		className: "text-kumo-subtle",
	},
	sent: {
		label: "Sent",
		icon: CheckCircleIcon,
		className: "text-kumo-default",
	},
	delivery_failed: {
		label: "Delivery needs retry",
		icon: WarningCircleIcon,
		className: "text-kumo-error",
	},
} satisfies Record<
	InboundOperation["state"],
	{
		label: string;
		icon: typeof ClockCountdownIcon;
		className: string;
	}
>;

export default function InboundOperationStatus({
	operation,
	onRetryDraft,
	isRetrying = false,
}: {
	operation: InboundOperation;
	onRetryDraft?: () => void;
	isRetrying?: boolean;
}) {
	const status = STATUS_CONTENT[operation.state];
	const Icon = status.icon;

	return (
		<div
			className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-b border-kumo-line bg-kumo-fill/30 px-4 py-2 text-xs md:px-6"
			role="status"
			aria-live="polite"
		>
			<Icon size={16} weight="duotone" className={status.className} />
			<span className={`font-medium ${status.className}`}>{status.label}</span>
				{operation.conflictCount > 0 && (
				<span className="text-kumo-error">
					{operation.conflictCount}{" "}
					{operation.conflictCount === 1
						? "conflicting delivery"
						: "conflicting deliveries"}{" "}
					blocked
					</span>
				)}
				{operation.state === "draft_failed" && onRetryDraft && (
					<button
						type="button"
						onClick={onRetryDraft}
						disabled={isRetrying}
						className="ml-auto inline-flex h-7 items-center gap-1.5 border border-kumo-line bg-kumo-base px-2.5 font-medium text-kumo-default hover:bg-kumo-fill disabled:cursor-not-allowed disabled:opacity-60"
					>
						<ArrowClockwiseIcon
							size={14}
							className={isRetrying ? "animate-spin" : undefined}
						/>
						Retry Draft
					</button>
				)}
			</div>
	);
}
