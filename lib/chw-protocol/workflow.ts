import "server-only";

import { ProtocolError, type TrustState } from "./types";

export type VerificationRequestStatus =
  | "pending" | "leased" | "submitted" | "confirming" | "completed" | "failed" | "expired";

/** Public, non-clinical projection used by CHW and patient clients. */
export type VerificationStatus = "requested" | "processing" | "verified" | "failed";

/**
 * Reference model of the CHW verification intent state machine.
 *
 * The model is intentionally pure and side-effect free so it can be driven by
 * property-based tests (fast-check model-based testing) as well as by the
 * runtime projection below. It encodes the allowed commands and the invariants
 * that must hold after every transition:
 *
 *  - no double settlement: a request may only reach `completed` once;
 *  - terminal states (`completed`, `failed`, `expired`) are absorbing;
 *  - every transition is one of the explicitly allowed edges.
 */
export type VerificationCommand =
  | "create"
  | "attest-observed"
  | "finalize"
  | "invalidate"
  | "quarantine"
  | "release"
  | "settle";

export const TERMINAL_VERIFICATION_STATUSES: readonly VerificationRequestStatus[] = [
  "completed",
  "failed",
  "expired",
];

export function isTerminalVerificationStatus(status: VerificationRequestStatus): boolean {
  return TERMINAL_VERIFICATION_STATUSES.includes(status);
}

/** Allowed command transitions for the verification intent state machine. */
const VERIFICATION_TRANSITIONS: Record<
  VerificationRequestStatus,
  Partial<Record<VerificationCommand, VerificationRequestStatus>>
> = {
  pending: {
    "attest-observed": "leased",
    invalidate: "failed",
    quarantine: "failed",
    settle: "completed",
  },
  leased: {
    finalize: "submitted",
    invalidate: "failed",
    quarantine: "failed",
    release: "pending",
    settle: "completed",
  },
  submitted: {
    finalize: "confirming",
    invalidate: "failed",
    quarantine: "failed",
    settle: "completed",
  },
  confirming: {
    finalize: "completed",
    invalidate: "failed",
    quarantine: "failed",
    settle: "completed",
  },
  completed: {},
  failed: {},
  expired: {},
};

/**
 * Apply a command to a status, returning the next status or `null` when the
 * command is not allowed from the current state. Terminal states are absorbing
 * and therefore never yield a next status.
 */
export function applyVerificationCommand(
  status: VerificationRequestStatus,
  command: VerificationCommand,
): VerificationRequestStatus | null {
  if (isTerminalVerificationStatus(status)) return null;
  return VERIFICATION_TRANSITIONS[status][command] ?? null;
}

/**
 * Invariant check used by the model-based tests after every command.
 * Returns a list of violated invariant names (empty when the state is valid).
 */
export function checkVerificationInvariants(
  status: VerificationRequestStatus,
  settledCount: number,
): string[] {
  const violations: string[] = [];
  if (settledCount > 1) violations.push("no-double-settlement");
  if (isTerminalVerificationStatus(status) && settledCount > 1) {
    violations.push("terminal-absorbing");
  }
  return violations;
}

export function projectVerificationStatus(
  status: VerificationRequestStatus,
  trustState?: TrustState,
  now = new Date(),
  leaseExpiresAt?: string | null,
): VerificationStatus {
  if (status === "completed" || trustState === "verified") return "verified";
  if (status === "failed" || status === "expired" || trustState === "expired" || trustState === "revoked" || trustState === "conflicted") return "failed";
  if (status === "leased" && leaseExpiresAt && Date.parse(leaseExpiresAt) <= now.getTime()) return "failed";
  if (status === "leased" || status === "submitted" || status === "confirming" || trustState === "submitted" || trustState === "confirming") return "processing";
  return "requested";
}

export function assertCurrentRecordHash(expected: string, actual: string) {
  if (!/^[0-9a-f]{64}$/i.test(expected) || expected.toLowerCase() !== actual.toLowerCase()) {
    throw new ProtocolError("REQUEST_NOT_CURRENT");
  }
}

export function assertTransactionHash(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new ProtocolError("INVALID_INTENT");
  return value.toLowerCase();
}
