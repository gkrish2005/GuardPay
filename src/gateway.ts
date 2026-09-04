import "dotenv/config";
import crypto from "crypto";
import Razorpay from "razorpay";
import { PrismaClient } from "./generated/prisma/client.js";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PRODUCT_CATALOG, Product } from "./catalog.js";
import { decide, getDailyValueSoFar } from "./governance.js";
import { evaluateContextSignals } from "./context-engine.js";
import { writeAuditLog } from "./audit-log.js";

import { prisma } from "./db.js";
export { prisma };

export const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || "",
  key_secret: process.env.RAZORPAY_KEY_SECRET || "",
});

// Helper: Canonical Cart Hash computation
export function computeCartHash(productSnapshot: any, amountPaise: number): string {
  const items = productSnapshot.items || [];
  const canonicalItems = items.map((item: any) => ({
    productId: item.productId,
    name: item.name,
    price: item.price,
    qty: item.qty,
  })).sort((a: any, b: any) => a.productId.localeCompare(b.productId));

  const str = JSON.stringify({ items: canonicalItems }) + `|${amountPaise}`;
  return crypto.createHash("sha256").update(str).digest("hex");
}

// Helper: Canonical Request Hash computation for Approval snapshot-binding
export function computeRequestHash(
  amountPaise: number,
  cartSnapshot: any,
  actionType: string,
  policyVersion: number
): string {
  const canonicalCart = JSON.stringify(cartSnapshot);
  const data = `${amountPaise}:${canonicalCart}:${actionType}:${policyVersion}`;
  return crypto.createHash("sha256").update(data).digest("hex");
}

// 1. searchProducts(query: string): Product[]
export function searchProducts(query: string): Product[] {
  const lowerQuery = query.toLowerCase();
  return PRODUCT_CATALOG.filter(
    (p) =>
      p.name.toLowerCase().includes(lowerQuery) ||
      p.description.toLowerCase().includes(lowerQuery)
  );
}

// 2. getProduct(productId: string): Product
export function getProduct(productId: string): Product {
  const product = PRODUCT_CATALOG.find((p) => p.id === productId);
  if (!product) {
    throw new Error(`Product not found: ${productId}`);
  }
  return product;
}

// 3. proposeUpsell(cartId: string): { product: Product, price: number }
export function proposeUpsell(cartId: string): { product: Product; price: number } {
  // Hardcoded upsell suggestion (socks) lookup from server-side catalog
  const product = getProduct("prod_5");
  return {
    product,
    price: product.price,
  };
}

// 4. requestConsent
export async function requestConsent(
  customerId: string,
  cartId: string,
  productId: string,
  description: string
): Promise<{ consentId: string }> {
  const product = getProduct(productId);
  let amountPaise = product.price * 100;
  let campaignCodeApplied: string | null = null;

  // Resolve CartCampaign from DB
  const cartCampaign = await prisma.cartCampaign.findUnique({
    where: { cartId },
  });

  if (cartCampaign) {
    const campaign = await prisma.campaign.findUnique({
      where: { code: cartCampaign.campaignCode },
    });

    if (!campaign) {
      throw new Error(`Campaign code not found: ${cartCampaign.campaignCode}`);
    }

    if (!campaign.isActive || new Date() > new Date(campaign.expiresAt)) {
      throw new Error(`Campaign has expired or is inactive`);
    }

    // Verify product eligibility
    const allowedProducts = (campaign.allowedProductIds || []) as string[];
    if (!allowedProducts.includes(productId)) {
      throw new Error(`Product is not eligible for this campaign`);
    }

    // Apply discount
    const discountAmount = Math.floor((product.price * campaign.discountPercent) / 100);
    const discountedPrice = product.price - discountAmount;
    amountPaise = discountedPrice * 100;
    campaignCodeApplied = campaign.code;
  }

  const productSnapshot = {
    items: [
      {
        productId: product.id,
        name: product.name,
        price: product.price,
        qty: 1,
      },
    ],
  };

  const cartHash = computeCartHash(productSnapshot, amountPaise);

  const consent = await prisma.consent.create({
    data: {
      customerId,
      cartId,
      productSnapshot,
      cartHash,
      amountPaise,
      campaignCode: campaignCodeApplied,
      status: "PENDING",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes expiry
    },
  });

  return { consentId: consent.id };
}

// 5. confirmConsent
export async function confirmConsent(consentId: string): Promise<{ status: "CONFIRMED" }> {
  const consent = await prisma.consent.findUnique({
    where: { id: consentId },
  });

  if (!consent) {
    throw new Error(`Consent not found: ${consentId}`);
  }

  await prisma.consent.update({
    where: { id: consentId },
    data: {
      status: "CONFIRMED",
      confirmedAt: new Date(),
    },
  });

  return { status: "CONFIRMED" };
}

// 6. createTransactionRequest
export async function createTransactionRequest(params: {
  customerId: string;
  agentId: string;
  actionType: string;
  cartId: string;
  consentId: string;
}): Promise<any> {
  const { customerId, agentId, actionType, cartId, consentId } = params;

  if (!consentId) {
    throw new Error("Consent ID is missing");
  }

  const consent = await prisma.consent.findUnique({
    where: { id: consentId },
  });

  if (!consent) {
    throw new Error(`Consent not found: ${consentId}`);
  }

  if (consent.status !== "CONFIRMED") {
    throw new Error(`Consent is not confirmed (current status: ${consent.status})`);
  }

  if (consent.expiresAt && new Date() > new Date(consent.expiresAt)) {
    throw new Error("Consent has expired");
  }

  if (consent.customerId !== customerId || consent.cartId !== cartId) {
    throw new Error("Consent customer ID or cart ID mismatch");
  }

  // Snapshot Integrity Check: Recompute canonical cart hash
  const computedHash = computeCartHash(consent.productSnapshot, consent.amountPaise);
  if (computedHash !== consent.cartHash) {
    throw new Error("Cart snapshot integrity check failed (hash mismatch)");
  }

  // Create TransactionRequest
  const transactionRequest = await prisma.transactionRequest.create({
    data: {
      agentId,
      customerId,
      actionType,
      amountPaise: consent.amountPaise,
      cartSnapshot: consent.productSnapshot as any,
      consentId: consent.id,
      campaignCode: consent.campaignCode,
    },
  });

  return transactionRequest;
}

// Per-agent concurrency mutex for serializing read-check-write governance decisions (Task 3.3 TOCTOU hardening)
const agentLocks = new Map<string, Promise<void>>();

export async function acquireAgentLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const currentLock = agentLocks.get(agentId) || Promise.resolve();
  let release: () => void;
  const newLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  agentLocks.set(agentId, newLock);

  await currentLock;
  try {
    return await fn();
  } finally {
    release!();
    if (agentLocks.get(agentId) === newLock) {
      agentLocks.delete(agentId);
    }
  }
}

// 7. requestPayment (governance-guided payment request)
export async function requestPayment(
  transactionRequestId: string
): Promise<{ verdict: "ALLOW" | "NEEDS_APPROVAL" | "BLOCK"; reason: string; orderId?: string; keyId?: string }> {
  // Pre-fetch transactionRequest to identify agentId for concurrency serialization
  const initialReq = await prisma.transactionRequest.findUnique({
    where: { id: transactionRequestId },
    select: { agentId: true },
  });
  const agentId = initialReq?.agentId || "global";

  return acquireAgentLock(agentId, async () => {
    const result = await prisma.$transaction(async (tx) => {
      const transactionRequest = await tx.transactionRequest.findUnique({
        where: { id: transactionRequestId },
      });

      if (!transactionRequest) {
        throw new Error(`Transaction request not found: ${transactionRequestId}`);
      }

    // Load agent
    const agent = await tx.agent.findUnique({
      where: { id: transactionRequest.agentId },
    });

    if (!agent) {
      throw new Error(`Agent not found: ${transactionRequest.agentId}`);
    }

    // Check agent permission: If action is not enabled for this agent, block immediately
    const permissions = (agent.permissions || {}) as any;
    if (!permissions[transactionRequest.actionType]?.enabled) {
      const decision = { verdict: "BLOCK" as const, reason: "Action not permitted for this agent" };
      await tx.decision.create({
        data: {
          transactionRequestId,
          verdict: decision.verdict,
          reason: decision.reason,
          signalsChecked: {
            agentId: agent.id,
            actionType: transactionRequest.actionType,
            amountPaise: transactionRequest.amountPaise,
            permissions,
          },
        },
      });
      await writeAuditLog(
        {
          transactionRequestId,
          actor: "system",
          event: "DECISION_BLOCKED",
          metadata: {
            reason: decision.reason,
            amountPaise: transactionRequest.amountPaise,
            actionType: transactionRequest.actionType,
          },
        },
        tx
      );
      return decision;
    }

    // Resolve latest policy itself from DB using agentId + actionType
    const policy = await tx.policy.findFirst({
      where: {
        agentId: transactionRequest.agentId,
        actionType: transactionRequest.actionType,
      },
      orderBy: { version: "desc" },
    });

    if (!policy) {
      throw new Error(
        `Policy not found for agent ${transactionRequest.agentId} and action ${transactionRequest.actionType}`
      );
    }

    // Compute daily value so far inside transaction boundary
    const dailyValue = await getDailyValueSoFar(tx, transactionRequest.agentId);

    // Evaluate behavioral & historical context risk signals
    const contextSignals = await evaluateContextSignals(tx, transactionRequest);

    // Call pure decide function with context signals
    const decision = decide(transactionRequest, policy, agent, dailyValue, contextSignals);

    // Write Decision row
    await tx.decision.create({
      data: {
        transactionRequestId,
        verdict: decision.verdict,
        reason: decision.reason,
        policyVersion: policy.version, // Bind matched policy version (invariant checks throw on missing policy)
        signalsChecked: {
          agentId: agent.id,
          policyId: policy.id,
          amountPaise: transactionRequest.amountPaise,
          dailyValueLimit: policy.dailyValueLimit,
          dailyValueSoFar: dailyValue,
          approvalThreshold: policy.approvalThreshold,
          maxAmount: policy.maxAmount,
          contextSignals: contextSignals as any,
        },
      },
    });

    // Write AuditLog row
    await writeAuditLog(
      {
        transactionRequestId,
        actor: "system",
        event:
          decision.verdict === "ALLOW"
            ? "DECISION_ALLOWED"
            : decision.verdict === "NEEDS_APPROVAL"
            ? "DECISION_NEEDS_APPROVAL"
            : "DECISION_BLOCKED",
        metadata: {
          reason: decision.reason,
          amountPaise: transactionRequest.amountPaise,
          policyId: policy.id,
          policyVersion: policy.version, // Log version statically for audit-trail history
          dailyValueSoFar: dailyValue,
          contextSignals,
        },
      },
      tx
    );

    // If NEEDS_APPROVAL, generate PENDING Approval record locked with requestHash
    if (decision.verdict === "NEEDS_APPROVAL") {
      const requestHash = computeRequestHash(
        transactionRequest.amountPaise,
        transactionRequest.cartSnapshot,
        transactionRequest.actionType,
        policy.version
      );
      await tx.approval.create({
        data: {
          transactionRequestId,
          requestHash,
          status: "PENDING",
          expiresAt: new Date(Date.now() + 30 * 60 * 1000) // 30 minutes expiry
        }
      });
    }

    return {
      verdict: decision.verdict,
      reason: decision.reason,
      transactionRequest,
    };
  });

  // If ALLOW, trigger Razorpay orders API and create transaction
  if (result.verdict === "ALLOW") {
    try {
      const order = await razorpay.orders.create({
        amount: result.transactionRequest.amountPaise,
        currency: "INR",
        receipt: `rcpt_${result.transactionRequest.id}`,
      });

      await prisma.transaction.create({
        data: {
          transactionRequestId: result.transactionRequest.id,
          razorpayOrderId: order.id,
          status: "CREATED",
        },
      });

      await writeAuditLog({
        transactionRequestId: result.transactionRequest.id,
        actor: "system",
        event: "RAZORPAY_ORDER_CREATED",
        metadata: {
          razorpayOrderId: order.id,
          amountPaise: result.transactionRequest.amountPaise,
        },
      });

      return {
        verdict: result.verdict,
        reason: result.reason,
        orderId: order.id,
        keyId: process.env.RAZORPAY_KEY_ID,
      };
    } catch (error: any) {
      await writeAuditLog({
        transactionRequestId,
        actor: "system",
        event: "RAZORPAY_ORDER_FAILED",
        metadata: {
          error: error.message || error,
        },
      });
      throw new Error(`Razorpay order creation failed: ${error.message || error}`);
    }
  }

    return { verdict: result.verdict, reason: result.reason };
  });
}
