import { TransactionRequest } from "./generated/prisma/client.js";

export interface ContextSignals {
  rapidRepeatedCheckout: boolean;
  recentCheckoutCount: number;
  unusualOrderAmount: boolean;
  historicalAverageAmountPaise: number | null;
  isNewProductForCustomer: boolean;
  newProductIds: string[];
}

/**
 * Evaluates contextual behavioral & historical signals for a transaction request.
 * Runs inside a database transaction context to inspect past customer activity.
 */
export async function evaluateContextSignals(
  prismaTx: any,
  request: TransactionRequest
): Promise<ContextSignals> {
  // 1. Velocity: Count all requests in the rolling last 5 minutes for this customer (includes current persisted request)
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  const recentRequests = await prismaTx.transactionRequest.count({
    where: {
      customerId: request.customerId,
      requestedAt: { gte: fiveMinutesAgo }
    }
  });
  const rapidRepeatedCheckout = recentRequests > 3; // >3 total requests in 5 minutes

  // 2. Anomaly: Compute historical captured/authorized AOV for this customer
  const customerRequests = await prismaTx.transactionRequest.findMany({
    where: { customerId: request.customerId },
    select: { id: true, amountPaise: true, cartSnapshot: true }
  });

  const requestMap = new Map<string, { id: string; amountPaise: number; cartSnapshot: any }>(
    customerRequests.map((r: any) => [r.id, r])
  );
  const customerRequestIds = customerRequests.map((r: any) => r.id);

  const pastCapturedTransactions = await prismaTx.transaction.findMany({
    where: {
      status: { in: ["AUTHORIZED", "CAPTURED"] },
      transactionRequestId: { in: customerRequestIds }
    }
  });

  let historicalAverageAmountPaise: number | null = null;
  let unusualOrderAmount = false;
  // Gate on >= 2 past transactions to establish a reliable baseline and prevent false positives on thin single-purchase history
  if (pastCapturedTransactions.length >= 2) {
    const totalPastPaise = pastCapturedTransactions.reduce((sum: number, tx: any) => {
      const matchedReq = requestMap.get(tx.transactionRequestId);
      return sum + (matchedReq ? matchedReq.amountPaise : 0);
    }, 0);
    historicalAverageAmountPaise = Math.round(totalPastPaise / pastCapturedTransactions.length);
    if (request.amountPaise > historicalAverageAmountPaise * 3) {
      unusualOrderAmount = true;
    }
  }

  // 3. Novelty: Check for first-time product purchases
  const previousProductIds = new Set<string>();
  for (const tx of pastCapturedTransactions) {
    const matchedReq = requestMap.get(tx.transactionRequestId);
    const items = (matchedReq?.cartSnapshot as any)?.items || [];
    for (const item of items) {
      if (item.productId) previousProductIds.add(item.productId);
    }
  }

  const currentItems = (request.cartSnapshot as any)?.items || [];
  const newProductIds: string[] = [];
  for (const item of currentItems) {
    if (item.productId && !previousProductIds.has(item.productId)) {
      newProductIds.push(item.productId);
    }
  }
  const isNewProductForCustomer = pastCapturedTransactions.length > 0 && newProductIds.length > 0;

  return {
    rapidRepeatedCheckout,
    recentCheckoutCount: recentRequests,
    unusualOrderAmount,
    historicalAverageAmountPaise,
    isNewProductForCustomer,
    newProductIds
  };
}
