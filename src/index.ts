import "dotenv/config";
import express from "express";
import crypto from "crypto";
import Razorpay from "razorpay";
import { PrismaClient } from "./generated/prisma/client.js";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { requestPayment, computeRequestHash, razorpay } from "./gateway.js";
import { transitionTransaction, canTransition } from "./state-machine.js";
import { writeAuditLog, auditLogRepository } from "./audit-log.js";
import { startAgentChat, runAgentTurn, AgentContext } from "./agent.js";

const app = express();
const dbUrl = process.env.DATABASE_URL || "file:./dev.db";
const dbPath = dbUrl.replace(/^file:/, "");
const adapter = new PrismaBetterSqlite3({ url: dbPath });
const prisma = new PrismaClient({ adapter });
const PORT = Number(process.env.PORT) || 3000;


// 1. Webhook endpoint with raw body parser registered before global JSON middleware
app.post("/api/webhooks/razorpay", express.raw({ type: "application/json" }), async (req: any, res: any) => {
  const rawBody = req.body;
  const signature = req.headers["x-razorpay-signature"];

  if (!signature || !rawBody) {
    console.error("Missing signature or body in webhook request");
    return res.status(400).send("Signature or body missing");
  }

  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("RAZORPAY_WEBHOOK_SECRET is not configured");
    return res.status(500).send("Server misconfigured");
  }

  const hmac = crypto.createHmac("sha256", webhookSecret);
  hmac.update(rawBody);
  const generatedSignature = hmac.digest("hex");

  try {
    const genBuf = Buffer.from(generatedSignature);
    const sigBuf = Buffer.from(signature as string);
    const isSignatureValid = genBuf.length === sigBuf.length && crypto.timingSafeEqual(genBuf, sigBuf);

    if (!isSignatureValid) {
      await writeAuditLog({
        actor: "system",
        event: "WEBHOOK_SIGNATURE_MISMATCH",
        metadata: {
          receivedSignature: signature,
        },
      });
      return res.status(400).send("Invalid signature");
    }
  } catch (error) {
    console.error("Error during signature verification:", error);
    return res.status(400).send("Verification error");
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch (error) {
    return res.status(400).send("Invalid JSON payload");
  }

  const razorpayEventId = payload?.id;
  if (!razorpayEventId) {
    return res.status(400).send("Missing event ID in webhook payload");
  }

  const payloadHash = crypto.createHash("sha256").update(rawBody).digest("hex");

  // Insert-First Idempotency Check (Non-Negotiable Invariant #11, caught at unique constraint level)
  try {
    await prisma.webhookEvent.create({
      data: {
        razorpayEventId,
        eventType: payload?.event || "unknown",
        payloadHash,
        status: "RECEIVED"
      }
    });
  } catch (error: any) {
    if (error.code === "P2002") {
      console.log(`[IDEMPOTENCY] Webhook event ID ${razorpayEventId} already exists. Ignoring duplicate.`);
      return res.status(200).json({ status: "ignored_duplicate" });
    }
    console.error("Failed to insert WebhookEvent:", error);
    return res.status(500).send("Internal server error");
  }

  const eventType = payload?.event;
  if (eventType === "payment.captured") {
    const payment = payload?.payload?.payment?.entity;
    const webhookOrderId = payment?.order_id;
    const webhookPaymentId = payment?.id;

    if (!webhookOrderId) {
      await writeAuditLog({
        actor: "system",
        event: "WEBHOOK_MISSING_ORDER_ID",
        metadata: {
          paymentId: webhookPaymentId,
        },
      });
      return res.status(400).send("Missing order_id in webhook payment entity");
    }

    // Resolve transaction against our database
    const transaction = await prisma.transaction.findFirst({
      where: { razorpayOrderId: webhookOrderId },
    });

    if (!transaction) {
      // Invariant #5: A webhook cannot create an unknown internal transaction.
      await writeAuditLog({
        actor: "system",
        event: "WEBHOOK_UNKNOWN_ORDER_ID",
        metadata: {
          razorpayOrderId: webhookOrderId,
          razorpayPaymentId: webhookPaymentId,
        },
      });
      // Mark as processed since it is resolved and logged
      await prisma.webhookEvent.update({
        where: { razorpayEventId },
        data: { status: "PROCESSED", processedAt: new Date() }
      });
      return res.status(200).send("Event logged (no matching internal transaction)");
    }

    // Invariant #6: A payment cannot be attached to a different Razorpay order than the one it belongs to.
    if (transaction.razorpayOrderId !== webhookOrderId) {
      await writeAuditLog({
        transactionRequestId: transaction.transactionRequestId,
        actor: "system",
        event: "WEBHOOK_ORDER_MISMATCH",
        metadata: {
          expectedOrderId: transaction.razorpayOrderId,
          receivedOrderId: webhookOrderId,
        },
      });
      return res.status(400).send("Order ID mismatch");
    }

    // Validate payment ID mismatch if already set
    if (transaction.razorpayPaymentId && transaction.razorpayPaymentId !== webhookPaymentId) {
      await writeAuditLog({
        transactionRequestId: transaction.transactionRequestId,
        actor: "system",
        event: "WEBHOOK_PAYMENT_MISMATCH",
        metadata: {
          storedPaymentId: transaction.razorpayPaymentId,
          receivedPaymentId: webhookPaymentId,
        },
      });
      return res.status(400).send("Payment ID mismatch");
    }

    // Validate amount mismatch if reported in webhook
    const reportedAmount = payload?.payload?.payment?.entity?.amount;
    if (reportedAmount !== undefined) {
      const txReq = await prisma.transactionRequest.findUnique({
        where: { id: transaction.transactionRequestId },
      });
      if (txReq && txReq.amountPaise !== reportedAmount) {
        await writeAuditLog({
          transactionRequestId: transaction.transactionRequestId,
          actor: "system",
          event: "WEBHOOK_AMOUNT_MISMATCH",
          metadata: {
            expectedAmountPaise: txReq.amountPaise,
            receivedAmountPaise: reportedAmount,
          },
        });
        return res.status(400).send("Amount mismatch");
      }
    }

    // Update transaction to CAPTURED using state-machine transition Transaction helper
    try {
      await prisma.$transaction(async (tx) => {
        await transitionTransaction(tx, transaction.id, "CAPTURED", webhookPaymentId);
      });

      await writeAuditLog({
        transactionRequestId: transaction.transactionRequestId,
        actor: "system",
        event: "PAYMENT_CAPTURED",
        metadata: {
          razorpayOrderId: webhookOrderId,
          razorpayPaymentId: webhookPaymentId,
        },
      });
    } catch (error: any) {
      console.error("Webhook CAPTURED state transition failed:", error);
      return res.status(500).send("State transition failed");
    }
  } else if (eventType === "payment.failed") {
    const payment = payload?.payload?.payment?.entity;
    const webhookOrderId = payment?.order_id;
    const webhookPaymentId = payment?.id;

    if (webhookOrderId) {
      const transaction = await prisma.transaction.findFirst({
        where: { razorpayOrderId: webhookOrderId },
      });

      if (transaction) {
        try {
          await prisma.$transaction(async (tx) => {
            await transitionTransaction(tx, transaction.id, "FAILED", webhookPaymentId);
          });

          await writeAuditLog({
            transactionRequestId: transaction.transactionRequestId,
            actor: "system",
            event: "PAYMENT_FAILED",
            metadata: {
              razorpayOrderId: webhookOrderId,
              razorpayPaymentId: webhookPaymentId,
              errorMessage: payment?.error_description || "Payment failed",
            },
          });
        } catch (error: any) {
          console.error("Webhook FAILED state transition failed:", error);
        }
      }
    }
  }

  try {
    await prisma.webhookEvent.update({
      where: { razorpayEventId },
      data: {
        status: "PROCESSED",
        processedAt: new Date()
      }
    });
  } catch (error: any) {
    console.error("Failed to update WebhookEvent to PROCESSED status:", error);
  }

  return res.status(200).json({ status: "processed" });
});

// 2. Global JSON parsing for subsequent endpoints
app.use(express.json());

// Serve static checkout page
app.use(express.static("/Users/krishgupta/Desktop/GuardPay"));

// In-Memory Agent Chat Session Store (scoped per browser demo session; single process)
interface AgentDemoSession {
  id: string;
  chatSession: any;
  createdAt: Date;
  lastActive: Date;
  pendingConsentId?: string;
  pendingConsentDetails?: any;
  confirmedConsentId?: string;
  lastDecision?: any;
}
const agentSessions = new Map<string, AgentDemoSession>();

// POST /api/agent/chat - Live Conversational Agent Endpoint (Phase 4.3)
app.post("/api/agent/chat", async (req: any, res: any) => {
  try {
    const { sessionId, message } = req.body;
    if (!message || typeof message !== "string" || message.trim() === "") {
      return res.status(400).json({ error: "Message is required" });
    }

    let session = sessionId ? agentSessions.get(sessionId) : undefined;
    if (!session) {
      const newSessionId = `sess_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
      session = {
        id: newSessionId,
        chatSession: startAgentChat([]),
        createdAt: new Date(),
        lastActive: new Date(),
      };
      agentSessions.set(newSessionId, session);
    }
    session.lastActive = new Date();

    // Fixed demo context (enforcing Invariant: client cannot choose agentId or actionType)
    const demoContext: AgentContext = {
      customerId: "cust_demo_1",
      agentId: "agent_revenue",
      actionType: "CREATE_ORDER",
    };

    const toolEvents: Array<{ name: string; args: any; output?: any; error?: any }> = [];
    let pendingConsentDetails: any = null;
    let governanceDecision: any = null;

    const onConsentRequested = async (consentId: string) => {
      session!.pendingConsentId = consentId;
      const consentRec = await prisma.consent.findUnique({ where: { id: consentId } });
      if (consentRec) {
        pendingConsentDetails = {
          consentId: consentRec.id,
          customerId: consentRec.customerId,
          cartId: consentRec.cartId,
          amountPaise: consentRec.amountPaise,
          productSnapshot: consentRec.productSnapshot,
          cartHash: consentRec.cartHash,
          status: consentRec.status,
        };
        session!.pendingConsentDetails = pendingConsentDetails;
      }
    };

    const onToolExecuted = async (event: { name: string; args: any; output?: any; error?: any }) => {
      toolEvents.push(event);
      if (event.name === "requestPayment" && event.output) {
        governanceDecision = event.output;
        session!.lastDecision = event.output;
      }
    };

    const response = await runAgentTurn(
      session.chatSession,
      message,
      demoContext,
      onConsentRequested,
      onToolExecuted
    );

    // Check if there is still a pending consent in database if not captured during this turn
    let consentRequired = pendingConsentDetails;
    if (!consentRequired && session.pendingConsentId) {
      const consentRec = await prisma.consent.findUnique({ where: { id: session.pendingConsentId } });
      if (consentRec && consentRec.status === "PENDING") {
        consentRequired = {
          consentId: consentRec.id,
          customerId: consentRec.customerId,
          cartId: consentRec.cartId,
          amountPaise: consentRec.amountPaise,
          productSnapshot: consentRec.productSnapshot,
          cartHash: consentRec.cartHash,
          status: consentRec.status,
        };
      }
    }

    return res.status(200).json({
      sessionId: session.id,
      response,
      toolEvents,
      consentRequired: consentRequired || null,
      governanceDecision: governanceDecision || session.lastDecision || null,
    });
  } catch (error: any) {
    console.error("POST /api/agent/chat error:", error);
    return res.status(500).json({ error: error.message || "Failed to process chat message" });
  }
});

// POST /api/agent/consent/confirm - Explicit Customer UI Consent Confirmation
app.post("/api/agent/consent/confirm", async (req: any, res: any) => {
  try {
    const { sessionId, consentId } = req.body;
    if (!consentId) {
      return res.status(400).json({ error: "consentId is required" });
    }

    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required for consent confirmation" });
    }

    const session = agentSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Active session not found" });
    }

    if (session.pendingConsentId !== consentId) {
      return res.status(400).json({
        error: `Session pending consent mismatch: expected ${session.pendingConsentId || "none"}, received ${consentId}`,
      });
    }

    const consent = await prisma.consent.findUnique({ where: { id: consentId } });
    if (!consent) {
      return res.status(404).json({ error: "Consent record not found" });
    }

    if (consent.customerId !== "cust_demo_1") {
      return res.status(403).json({ error: "Unauthorized consent confirmation" });
    }

    if (consent.status !== "PENDING") {
      return res.status(400).json({ error: `Consent is already ${consent.status}` });
    }

    const updated = await prisma.consent.update({
      where: { id: consentId },
      data: { status: "CONFIRMED", confirmedAt: new Date() },
    });

    session.pendingConsentId = undefined;
    session.pendingConsentDetails = undefined;
    session.confirmedConsentId = updated.id;

    await writeAuditLog({
      actor: "human",
      event: "CUSTOMER_CONSENT_CONFIRMED",
      metadata: {
        consentId: updated.id,
        sessionId: session.id,
        customerId: updated.customerId,
        cartId: updated.cartId,
        amountPaise: updated.amountPaise,
        cartHash: updated.cartHash,
      },
    });

    return res.status(200).json({
      status: "CONFIRMED",
      consentId: updated.id,
      message: "Customer consent explicitly confirmed via secure UI.",
    });
  } catch (error: any) {
    console.error("POST /api/agent/consent/confirm error:", error);
    return res.status(500).json({ error: error.message || "Failed to confirm consent" });
  }
});

// POST /api/agent/reset-session - Reset Active Browser Chat Session
app.post("/api/agent/reset-session", async (req: any, res: any) => {
  try {
    const { sessionId } = req.body;
    if (sessionId && agentSessions.has(sessionId)) {
      agentSessions.delete(sessionId);
    }
    const newSessionId = `sess_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    agentSessions.set(newSessionId, {
      id: newSessionId,
      chatSession: startAgentChat([]),
      createdAt: new Date(),
      lastActive: new Date(),
    });
    return res.status(200).json({ status: "success", sessionId: newSessionId });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to reset session" });
  }
});

// Health Check
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Gated Test Setup Endpoint (Disabled - Superseded by Task 1.4/1.6 gateway tools)
app.post("/api/test/setup", async (req: any, res: any) => {
  return res.status(410).json({ error: "Endpoint superseded by Task 1.4/1.6 gateway tools." });
});

// POST /api/carts/:id/campaign - Apply campaign code to cart (server-side verified at write time)
app.post("/api/carts/:id/campaign", async (req: any, res: any) => {
  const cartId = req.params.id;
  const { campaignCode } = req.body;

  if (!campaignCode) {
    return res.status(400).json({ error: "Missing campaignCode" });
  }

  try {
    const campaign = await prisma.campaign.findUnique({
      where: { code: campaignCode },
    });

    if (!campaign) {
      return res.status(400).json({ error: `Campaign code not found: ${campaignCode}` });
    }

    if (!campaign.isActive || new Date() > new Date(campaign.expiresAt)) {
      return res.status(400).json({ error: "Campaign has expired or is inactive" });
    }

    // Upsert the CartCampaign
    const cartCampaign = await prisma.cartCampaign.upsert({
      where: { cartId },
      update: { campaignCode },
      create: { cartId, campaignCode },
    });

    return res.status(200).json({ status: "success", campaignCode: cartCampaign.campaignCode });
  } catch (error: any) {
    console.error("POST /api/carts/:id/campaign failed:", error);
    return res.status(500).json({ error: "Failed to apply campaign" });
  }
});

// Create Order Endpoint (derive amount server-side from request record, Invariants #2, #3)
app.post("/api/orders", async (req: any, res: any) => {
  const { transactionRequestId } = req.body;
  if (!transactionRequestId) {
    return res.status(400).json({ error: "Missing transactionRequestId" });
  }

  const transactionRequest = await prisma.transactionRequest.findUnique({
    where: { id: transactionRequestId },
  });

  if (!transactionRequest) {
    return res.status(404).json({ error: "TransactionRequest not found" });
  }

  try {
    const order = await razorpay.orders.create({
      amount: transactionRequest.amountPaise,
      currency: "INR",
      receipt: `rcpt_${transactionRequest.id}`,
    });

    const transaction = await prisma.transaction.create({
      data: {
        transactionRequestId: transactionRequest.id,
        razorpayOrderId: order.id,
        status: "CREATED",
      },
    });

    await writeAuditLog({
      transactionRequestId: transactionRequest.id,
      actor: "system",
      event: "RAZORPAY_ORDER_CREATED",
      metadata: {
        razorpayOrderId: order.id,
        amountPaise: transactionRequest.amountPaise,
      },
    });

    return res.status(200).json({
      orderId: order.id,
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error: any) {
    console.error("Error creating Razorpay order:", error);
    return res.status(500).json({ error: error.message || "Failed to create Razorpay order" });
  }
});

// Payments Checkout Opened Endpoint (Invariants #4)
app.post("/api/payments/checkout-opened", async (req: any, res: any) => {
  const { razorpay_order_id } = req.body;
  if (!razorpay_order_id) {
    return res.status(400).json({ error: "Missing razorpay_order_id" });
  }

  try {
    const transaction = await prisma.transaction.findFirst({
      where: { razorpayOrderId: razorpay_order_id },
    });

    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found for order ID" });
    }

    await prisma.$transaction(async (tx) => {
      await transitionTransaction(tx, transaction.id, "CHECKOUT_OPENED");
    });

    await writeAuditLog({
      transactionRequestId: transaction.transactionRequestId,
      actor: "system",
      event: "PAYMENT_CHECKOUT_OPENED",
      metadata: {
        razorpay_order_id,
      },
    });

    return res.status(200).json({ status: "success" });
  } catch (error: any) {
    if (error.message.includes("Invalid state transition")) {
      // Ignore checkout-opened if transaction has already moved past CREATED (e.g. fast authorization)
      return res.status(200).json({ status: "ignored_duplicate" });
    }
    console.error("checkout-opened failed:", error);
    return res.status(500).json({ error: error.message || error });
  }
});

// Payments Verification Endpoint (Signature validation using timingSafeEqual, Invariants #4, #13)
app.post("/api/payments/verify", async (req: any, res: any) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: "Missing required verification fields" });
  }

  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const generated = crypto
    .createHmac("sha256", keySecret)
    .update(razorpay_order_id + "|" + razorpay_payment_id)
    .digest("hex");

  try {
    const genBuf = Buffer.from(generated);
    const sigBuf = Buffer.from(razorpay_signature);
    const isValid = genBuf.length === sigBuf.length && crypto.timingSafeEqual(genBuf, sigBuf);

    if (!isValid) {
      await writeAuditLog({
        actor: "system",
        event: "PAYMENT_VERIFICATION_SIGNATURE_MISMATCH",
        metadata: {
          razorpay_order_id,
          razorpay_payment_id,
          received_signature: razorpay_signature,
        },
      });
      return res.status(400).json({ error: "Invalid signature" });
    }
  } catch (error) {
    return res.status(400).json({ error: "Verification failed" });
  }

  const transaction = await prisma.transaction.findFirst({
    where: { razorpayOrderId: razorpay_order_id },
  });

  if (!transaction) {
    await writeAuditLog({
      actor: "system",
      event: "PAYMENT_VERIFICATION_UNKNOWN_ORDER",
      metadata: {
        razorpay_order_id,
        razorpay_payment_id,
      },
    });
    return res.status(400).json({ error: "No matching transaction found for order ID" });
  }

  // Invariant #6: A payment cannot be attached to a different Razorpay order than the one it belongs to.
  // Step A: Check if this payment ID was already recorded on a different internal Transaction with a different order ID.
  const existingTransactionForPaymentId = await prisma.transaction.findFirst({
    where: {
      razorpayPaymentId: razorpay_payment_id,
    },
  });

  if (existingTransactionForPaymentId && existingTransactionForPaymentId.razorpayOrderId !== razorpay_order_id) {
    await writeAuditLog({
      transactionRequestId: transaction.transactionRequestId,
      actor: "system",
      event: "PAYMENT_VERIFICATION_PAYMENT_MISMATCH",
      metadata: {
        claimedOrderId: razorpay_order_id,
        razorpay_order_id,
        receivedPaymentId: razorpay_payment_id,
        razorpay_payment_id,
        actualOrderIdForPayment: existingTransactionForPaymentId.razorpayOrderId,
        conflictingOrderId: existingTransactionForPaymentId.razorpayOrderId,
        conflictingTransactionId: existingTransactionForPaymentId.id,
      },
    });
    return res.status(400).json({
      error: `Payment ID mismatch: payment ${razorpay_payment_id} belongs to order ${existingTransactionForPaymentId.razorpayOrderId}, not claimed order ${razorpay_order_id}`,
    });
  }

  // Step B: Check if the claimed transaction is already bound to a different payment ID.
  if (transaction.razorpayPaymentId && transaction.razorpayPaymentId !== razorpay_payment_id) {
    await writeAuditLog({
      transactionRequestId: transaction.transactionRequestId,
      actor: "system",
      event: "PAYMENT_VERIFICATION_PAYMENT_MISMATCH",
      metadata: {
        claimedOrderId: razorpay_order_id,
        storedPaymentId: transaction.razorpayPaymentId,
        receivedPaymentId: razorpay_payment_id,
      },
    });
    return res.status(400).json({
      error: `Payment ID mismatch: order ${razorpay_order_id} is already bound to payment ${transaction.razorpayPaymentId}`,
    });
  }

  const currentStatus = transaction.status;

  try {
    await prisma.$transaction(async (tx) => {
      await transitionTransaction(tx, transaction.id, "AUTHORIZED", razorpay_payment_id);
    });

    await writeAuditLog({
      transactionRequestId: transaction.transactionRequestId,
      actor: "system",
      event: "PAYMENT_VERIFICATION_SUCCESS",
      metadata: {
        razorpay_order_id,
        razorpay_payment_id,
      },
    });
  } catch (error: any) {
    if (error.message.includes("Invalid state transition")) {
      // Current status is already AUTHORIZED, CAPTURED, or FAILED.
      // Ensure we do not downgrade the status.
      if (transaction.razorpayPaymentId && transaction.razorpayPaymentId !== razorpay_payment_id) {
        await writeAuditLog({
          transactionRequestId: transaction.transactionRequestId,
          actor: "system",
          event: "PAYMENT_VERIFICATION_PAYMENT_MISMATCH",
          metadata: {
            storedPaymentId: transaction.razorpayPaymentId,
            receivedPaymentId: razorpay_payment_id,
          },
        });
        return res.status(400).json({ error: "Payment ID mismatch" });
      }

      if (!transaction.razorpayPaymentId) {
        await prisma.transaction.update({
          where: { id: transaction.id },
          data: {
            razorpayPaymentId: razorpay_payment_id,
          },
        });
      }

      await writeAuditLog({
        transactionRequestId: transaction.transactionRequestId,
        actor: "system",
        event: "PAYMENT_VERIFICATION_OUT_OF_ORDER",
        metadata: {
          razorpay_order_id,
          razorpay_payment_id,
          currentStatus: transaction.status,
          message: "Verification arrived after transaction reached advanced state",
        },
      });
    } else {
      console.error("Verification state transition failed:", error);
      return res.status(500).json({ error: "Verification failed" });
    }
  }

  return res.status(200).json({ status: "success" });
});

// GET /api/approvals - List pending decisions that need human approval
// GET /api/approvals - List pending decisions that need human approval
app.get("/api/approvals", async (req: any, res: any) => {
  try {
    // Lazy check-on-read: expire pending approvals past their expiration time
    const now = new Date();
    const expiredApprovals = await prisma.approval.findMany({
      where: {
        status: "PENDING",
        expiresAt: { lte: now }
      }
    });

    if (expiredApprovals.length > 0) {
      await prisma.approval.updateMany({
        where: {
          id: { in: expiredApprovals.map((a: any) => a.id) }
        },
        data: { status: "EXPIRED" }
      });

      for (const appRecord of expiredApprovals) {
        await writeAuditLog({
          transactionRequestId: appRecord.transactionRequestId,
          actor: "system",
          event: "DECISION_EXPIRED",
          metadata: {
            approvalId: appRecord.id,
            message: "Approval expired on lazy read check"
          }
        });
      }
    }

    // Retrieve all active PENDING approvals
    const pendingApprovals = await prisma.approval.findMany({
      where: { status: "PENDING" },
      orderBy: { expiresAt: "desc" }
    });

    const pending = [];
    for (const approval of pendingApprovals) {
      const request = await prisma.transactionRequest.findUnique({
        where: { id: approval.transactionRequestId },
      });

      const decision = await prisma.decision.findFirst({
        where: { transactionRequestId: approval.transactionRequestId },
      });

      if (request && decision) {
        pending.push({
          decision: {
            id: request.id, // ID is TransactionRequest.id for click handlers
            decidedAt: decision.decidedAt,
            reason: decision.reason,
          },
          request: {
            id: request.id,
            agentId: request.agentId,
            customerId: request.customerId,
            amountPaise: request.amountPaise,
            cartSnapshot: request.cartSnapshot,
            expiresAt: approval.expiresAt,
          },
        });
      }
    }

    return res.status(200).json(pending);
  } catch (error: any) {
    console.error("GET /api/approvals failed:", error);
    return res.status(500).json({ error: "Failed to load approvals" });
  }
});

// POST /api/approvals/:id/approve - Approve request, creating order on Razorpay (id = TransactionRequest.id)
app.post("/api/approvals/:id/approve", async (req: any, res: any) => {
  const txRequestId = req.params.id;

  try {
    // SECURITY: Load everything from DB. Do not inspect, read, or destructure req.body
    const approval = await prisma.approval.findUnique({
      where: { transactionRequestId: txRequestId },
    });

    // Backward compatibility for decisions made under Phase 1 (no Approval row)
    if (!approval) {
      const decision = await prisma.decision.findFirst({
        where: { transactionRequestId: txRequestId, verdict: "NEEDS_APPROVAL" },
      });
      if (!decision) {
        return res.status(404).json({ error: "Decision/Approval not found for this request" });
      }

      const existingTx = await prisma.transaction.findFirst({
        where: { transactionRequestId: txRequestId },
      });
      if (existingTx) {
        return res.status(400).json({ error: "Transaction request has already been approved" });
      }

      const rejection = await auditLogRepository.findFirst({
        where: { transactionRequestId: txRequestId, event: "DECISION_REJECTED" },
      });
      if (rejection) {
        return res.status(400).json({ error: "Transaction request has already been rejected" });
      }

      const txRequest = await prisma.transactionRequest.findUnique({
        where: { id: txRequestId },
      });
      if (!txRequest) {
        return res.status(404).json({ error: "TransactionRequest not found" });
      }

      if (!txRequest.consentId) {
        return res.status(400).json({ error: "No customer consent linked to this request" });
      }
      const consent = await prisma.consent.findUnique({
        where: { id: txRequest.consentId },
      });
      if (!consent || consent.status !== "CONFIRMED") {
        return res.status(400).json({ error: "Consent is invalid or unconfirmed" });
      }
      if (consent.expiresAt && new Date() > new Date(consent.expiresAt)) {
        return res.status(400).json({ error: "Consent has expired" });
      }

      const order = await razorpay.orders.create({
        amount: txRequest.amountPaise,
        currency: txRequest.currency || "INR",
        receipt: txRequest.id,
      });

      await prisma.transaction.create({
        data: {
          transactionRequestId: txRequestId,
          razorpayOrderId: order.id,
          status: "CREATED",
        },
      });

      await writeAuditLog({
        transactionRequestId: txRequestId,
        actor: "human",
        event: "DECISION_APPROVED",
        metadata: { decisionId: decision.id, approvedAt: new Date(), razorpayOrderId: order.id },
      });

      await writeAuditLog({
        transactionRequestId: txRequestId,
        actor: "system",
        event: "RAZORPAY_ORDER_CREATED",
        metadata: { orderId: order.id, amountPaise: txRequest.amountPaise },
      });

      return res.status(200).json({ status: "success", razorpayOrderId: order.id });
    }

    // Modern snapshot-binding flow using Approval table
    if (approval.status !== "PENDING") {
      return res.status(400).json({ error: "Approval has already been processed" });
    }

    if (new Date() > new Date(approval.expiresAt)) {
      await prisma.approval.update({
        where: { id: approval.id },
        data: { status: "EXPIRED" }
      });
      await writeAuditLog({
        transactionRequestId: txRequestId,
        actor: "system",
        event: "DECISION_EXPIRED",
        metadata: { approvalId: approval.id, message: "Approval expired at approval check time" }
      });
      return res.status(400).json({ error: "Approval has expired" });
    }

    const txRequest = await prisma.transactionRequest.findUnique({
      where: { id: txRequestId },
    });
    if (!txRequest) {
      return res.status(404).json({ error: "TransactionRequest not found" });
    }

    const decision = await prisma.decision.findFirst({
      where: { transactionRequestId: txRequestId },
    });
    if (!decision) {
      return res.status(404).json({ error: "Decision not found" });
    }

    // Reject outright if historical decision missing policy version
    if (decision.policyVersion === null) {
      return res.status(400).json({ error: "Cannot verify historical decision missing policy version" });
    }

    // Verify snapshot hash binding
    const recomputedHash = computeRequestHash(
      txRequest.amountPaise,
      txRequest.cartSnapshot,
      txRequest.actionType,
      decision.policyVersion
    );

    if (recomputedHash !== approval.requestHash) {
      await prisma.approval.update({
        where: { id: approval.id },
        data: { status: "REJECTED" }
      });
      await writeAuditLog({
        transactionRequestId: txRequestId,
        actor: "system",
        event: "APPROVAL_HASH_MISMATCH",
        metadata: {
          expectedHash: approval.requestHash,
          actualHash: recomputedHash,
          message: "Approval rejected due to request snapshot tampering"
        }
      });
      return res.status(400).json({ error: "Approval hash mismatch - request has been modified" });
    }

    // Success - transition Approval status to APPROVED
    await prisma.approval.update({
      where: { id: approval.id },
      data: { status: "APPROVED", approvedBy: "merchant", approvedAt: new Date() }
    });

    if (!txRequest.consentId) {
      return res.status(400).json({ error: "No customer consent linked to this request" });
    }
    const consent = await prisma.consent.findUnique({
      where: { id: txRequest.consentId },
    });
    if (!consent || consent.status !== "CONFIRMED") {
      return res.status(400).json({ error: "Consent is invalid or unconfirmed" });
    }
    if (consent.expiresAt && new Date() > new Date(consent.expiresAt)) {
      return res.status(400).json({ error: "Consent has expired" });
    }

    console.log(`[APPROVAL SYSTEM] Human approved request ${txRequestId}. Creating Razorpay Order for ${txRequest.amountPaise} paise...`);
    const order = await razorpay.orders.create({
      amount: txRequest.amountPaise,
      currency: txRequest.currency || "INR",
      receipt: txRequest.id,
    });

    await prisma.transaction.create({
      data: {
        transactionRequestId: txRequestId,
        razorpayOrderId: order.id,
        status: "CREATED",
      },
    });

    await writeAuditLog({
      transactionRequestId: txRequestId,
      actor: "human",
      event: "DECISION_APPROVED",
      metadata: {
        approvalId: approval.id,
        approvedAt: new Date(),
        razorpayOrderId: order.id,
      },
    });

    await writeAuditLog({
      transactionRequestId: txRequestId,
      actor: "system",
      event: "RAZORPAY_ORDER_CREATED",
      metadata: {
        orderId: order.id,
        amountPaise: txRequest.amountPaise,
      },
    });

    return res.status(200).json({
      status: "success",
      razorpayOrderId: order.id,
    });
  } catch (error: any) {
    console.error(`POST /api/approvals/${txRequestId}/approve failed:`, error);
    return res.status(500).json({ error: error.message || "Failed to approve transaction request" });
  }
});

// POST /api/approvals/:id/reject - Reject request (id = TransactionRequest.id)
app.post("/api/approvals/:id/reject", async (req: any, res: any) => {
  const txRequestId = req.params.id;

  try {
    // SECURITY: Load everything from DB. Do not inspect, read, or destructure req.body
    const approval = await prisma.approval.findUnique({
      where: { transactionRequestId: txRequestId },
    });

    // Backward compatibility for decisions made under Phase 1 (no Approval row)
    if (!approval) {
      const decision = await prisma.decision.findFirst({
        where: { transactionRequestId: txRequestId, verdict: "NEEDS_APPROVAL" },
      });
      if (!decision) {
        return res.status(404).json({ error: "Decision/Approval not found for this request" });
      }

      const existingTx = await prisma.transaction.findFirst({
        where: { transactionRequestId: txRequestId },
      });
      if (existingTx) {
        return res.status(400).json({ error: "Transaction request has already been approved" });
      }

      const rejection = await auditLogRepository.findFirst({
        where: { transactionRequestId: txRequestId, event: "DECISION_REJECTED" },
      });
      if (rejection) {
        return res.status(400).json({ error: "Transaction request has already been rejected" });
      }
    } else {
      if (approval.status !== "PENDING") {
        return res.status(400).json({ error: "Approval has already been processed" });
      }

      await prisma.approval.update({
        where: { id: approval.id },
        data: { status: "REJECTED" },
      });
    }

    // Log Human Rejection audit event
    await writeAuditLog({
      transactionRequestId: txRequestId,
      actor: "human",
      event: "DECISION_REJECTED",
      metadata: {
        rejectedAt: new Date(),
      },
    });

    return res.status(200).json({ status: "success" });
  } catch (error: any) {
    console.error(`POST /api/approvals/${txRequestId}/reject failed:`, error);
    return res.status(500).json({ error: error.message || "Failed to reject transaction request" });
  }
});

// GET /api/audit-logs - List audit logs (limited to 200, newest first)
app.get("/api/audit-logs", async (req: any, res: any) => {
  try {
    const logs = await auditLogRepository.findMany({
      orderBy: { timestamp: "desc" },
      take: 200,
    });
    return res.status(200).json(logs);
  } catch (error: any) {
    console.error("GET /api/audit-logs failed:", error);
    return res.status(500).json({ error: "Failed to load audit logs" });
  }
});

// GET /api/kpi-dashboard - Reconciliation & Business KPI summary (Task 3.2)
app.get("/api/kpi-dashboard", (_req: any, res: any) => {
  return res.status(200).json({
    governance: {
      totalEvaluated: 1000,
      expectedPolicyAdherencePercent: 100.0,
      verdictBreakdown: {
        ALLOW: { count: 530, percentage: 53.0 },
        NEEDS_APPROVAL: { count: 230, percentage: 23.0 },
        BLOCK: { count: 240, percentage: 24.0 },
      },
      policyViolationsBlocked: "240 / 240 (100.0%)",
      expectedSafeAllowed: "530 / 530 (100.0%)",
      unexpectedDecisionsCount: 0,
      simulatedValueBlockedRupees: 7636250,
      decisionLatencyMicroseconds: {
        avg: 0.79,
        p95: 1.13,
        p99: 5.25,
      },
      note: "[SYNTHETIC EVALUATION / SIMULATED BENCHMARK — NOT REAL-WORLD GROUND TRUTH]",
    },
    revenue: {
      sessionCount: 100,
      upsellConversionRatePercent: 28.0,
      baselineTotalGmvRupees: 1037500,
      agentTotalGmvRupees: 1059900,
      baselineAovRupees: 10375.0,
      agentAovRupees: 10599.0,
      revenueUpliftPercent: 2.16,
      incrementalGmvRupees: 22400,
      assumption: "Models independent upsell attach with zero interaction effect on base cart value (all uplift = 28 × ₹800 sock attach, no cannibalization)",
    },
  });
});

app.listen(PORT, () => {
  console.log(`GuardPay server listening on http://localhost:${PORT}`);
});
