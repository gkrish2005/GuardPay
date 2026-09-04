import { TransactionRequest, Policy, Agent } from "./generated/prisma/client.js";
import { PRODUCT_CATALOG } from "./catalog.js";
import { ContextSignals } from "./context-engine.js";

// Helper to determine if an action requires customer consent
export function actionRequiresConsent(actionType: string): boolean {
  return actionType === "CREATE_ORDER";
}

// Pure deterministic decision function
export function decide(
  request: TransactionRequest,
  policy: Policy,
  agent: Agent,
  dailyValueSoFar: number,
  contextSignals?: ContextSignals
): { verdict: "ALLOW" | "NEEDS_APPROVAL" | "BLOCK"; reason: string } {
  // 1. Block if action not permitted for this agent
  const permissions = (agent.permissions || {}) as any;
  if (!permissions[request.actionType]?.enabled) {
    return { verdict: "BLOCK", reason: "Action not permitted for this agent" };
  }

  // 2. Block if amount exceeds policy.maxAmount
  if (request.amountPaise > policy.maxAmount) {
    return { verdict: "BLOCK", reason: "Exceeds absolute agent limit" };
  }

  // 3. Block if discount exceeds policy limit (recalculated using authoritative catalog prices)
  const items = (request.cartSnapshot as any)?.items || [];
  let originalTotalPaise = 0;
  for (const item of items) {
    if (item.productId) {
      const catalogItem = PRODUCT_CATALOG.find((p) => p.id === item.productId);
      if (!catalogItem) {
        return { verdict: "BLOCK", reason: `Authoritative catalog product not found: ${item.productId}` };
      }
      originalTotalPaise += catalogItem.price * (item.qty || 1) * 100;
    } else {
      originalTotalPaise += (item.price || 0) * (item.qty || 1) * 100;
    }
  }

  const finalTotal = request.amountPaise;
  const discountPercent = originalTotalPaise > 0 
    ? Math.ceil(((originalTotalPaise - finalTotal) / originalTotalPaise) * 100) 
    : 0;

  if (discountPercent > policy.maxDiscountPercent) {
    return { verdict: "BLOCK", reason: "Discount percent exceeds policy limit" };
  }

  // 4. Block if action requires consent and consentId is missing
  if (actionRequiresConsent(request.actionType) && !request.consentId) {
    return { verdict: "BLOCK", reason: "Customer consent required" };
  }

  // 5. Context Signal Escalation: Trigger NEEDS_APPROVAL if anomaly signals detected
  if (contextSignals?.rapidRepeatedCheckout) {
    return { verdict: "NEEDS_APPROVAL", reason: "Rapid repeated checkout velocity detected" };
  }

  if (contextSignals?.unusualOrderAmount) {
    return { verdict: "NEEDS_APPROVAL", reason: "Order amount significantly exceeds customer historical average" };
  }

  // 6. NEEDS_APPROVAL if amount exceeds policy.approvalThreshold
  if (request.amountPaise > policy.approvalThreshold) {
    return { verdict: "NEEDS_APPROVAL", reason: "Above auto-approve threshold" };
  }

  // 7. Block if daily value cap would be exceeded
  if (dailyValueSoFar + request.amountPaise > policy.dailyValueLimit) {
    return { verdict: "BLOCK", reason: "Daily value cap exceeded" };
  }

  // 8. Otherwise ALLOW
  return { verdict: "ALLOW", reason: "Under policy auto-approval threshold" };
}

// Helper to calculate daily total allowed spend for an agent in last 24 hours
export async function getDailyValueSoFar(prismaTx: any, agentId: string): Promise<number> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  
  // Find all requests in the last 24h for this agent
  const requests = await prismaTx.transactionRequest.findMany({
    where: {
      agentId,
      requestedAt: { gte: oneDayAgo }
    }
  });

  if (requests.length === 0) return 0;

  const requestIds = requests.map((r: any) => r.id);

  // Filter requests that reached an ALLOW decision
  const allowedDecisions = await prismaTx.decision.findMany({
    where: {
      transactionRequestId: { in: requestIds },
      verdict: "ALLOW"
    }
  });

  const allowedRequestIds = new Set(allowedDecisions.map((d: any) => d.transactionRequestId));
  
  return requests
    .filter((r: any) => allowedRequestIds.has(r.id))
    .reduce((sum: number, r: any) => sum + r.amountPaise, 0);
}
