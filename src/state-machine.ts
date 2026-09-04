import { PrismaClient } from "./generated/prisma/client.js";
import { writeAuditLog } from "./audit-log.js";

export type TransactionState = "CREATED" | "CHECKOUT_OPENED" | "AUTHORIZED" | "CAPTURED" | "FAILED";

export const KNOWN_STATES = new Set<string>(["CREATED", "CHECKOUT_OPENED", "AUTHORIZED", "CAPTURED", "FAILED"]);

const STATE_HIERARCHY: Record<string, number> = {
  CREATED: 1,
  CHECKOUT_OPENED: 2,
  AUTHORIZED: 3,
  CAPTURED: 4,
  FAILED: 5,
};

// NOTE: STATES_ORDER excludes the FAILED state because FAILED is a terminal branch,
// not a sequential step, and is bypassed in normal skip-ahead audit checks.
const STATES_ORDER = ["CREATED", "CHECKOUT_OPENED", "AUTHORIZED", "CAPTURED"];

/**
 * Validates whether a transaction can move from the current state to the next state.
 * Allows strict forward progression and skip-aheads, but rejects downgrades and invalid states.
 */
export function canTransition(current: string, next: string): boolean {
  if (!KNOWN_STATES.has(current) || !KNOWN_STATES.has(next)) {
    return false;
  }

  // Handle terminal states
  if (current === "CAPTURED" || current === "FAILED") {
    return current === next;
  }

  // Can transition to FAILED from any non-terminal state
  if (next === "FAILED") {
    return true;
  }

  const currentPriority = STATE_HIERARCHY[current];
  const nextPriority = STATE_HIERARCHY[next];

  return nextPriority >= currentPriority;
}

/**
 * Executes a monotonic state transition for a transaction.
 * Automatically detects and logs skip-aheads into the AuditLog.
 */
export async function transitionTransaction(
  prismaTx: any,
  transactionId: string,
  nextState: TransactionState,
  razorpayPaymentId?: string
) {
  const transaction = await prismaTx.transaction.findUnique({
    where: { id: transactionId },
  });

  if (!transaction) {
    throw new Error(`Transaction ${transactionId} not found`);
  }

  const currentStatus = transaction.status;

  if (!canTransition(currentStatus, nextState)) {
    throw new Error(`Invalid state transition from ${currentStatus} to ${nextState}`);
  }

  // Detect skip-ahead transitions and log a synthetic audit log
  const currentIndex = STATES_ORDER.indexOf(currentStatus);
  const nextIndex = STATES_ORDER.indexOf(nextState);
  if (currentIndex !== -1 && nextIndex !== -1 && nextIndex > currentIndex + 1) {
    const bypassed = STATES_ORDER.slice(currentIndex + 1, nextIndex);
    await writeAuditLog(
      {
        transactionRequestId: transaction.transactionRequestId,
        actor: "system",
        event: "FAST_WEBHOOK_SKIP_DETECTED",
        metadata: {
          previousState: currentStatus,
          nextState,
          bypassedStates: bypassed,
          message: `Fast payment path bypass detected. Bypassed intermediate states: ${bypassed.join(", ")}`,
        },
      },
      prismaTx
    );
  }

  // If nextState matches current, it is a no-op transition, return transaction as-is
  if (currentStatus === nextState) {
    // If a payment ID was provided and is not currently stored, update it
    if (razorpayPaymentId && transaction.razorpayPaymentId !== razorpayPaymentId) {
      return await prismaTx.transaction.update({
        where: { id: transactionId },
        data: { razorpayPaymentId },
      });
    }
    return transaction;
  }

  const updateData: any = { status: nextState };
  if (razorpayPaymentId) {
    updateData.razorpayPaymentId = razorpayPaymentId;
  }

  return await prismaTx.transaction.update({
    where: { id: transactionId },
    data: updateData,
  });
}
