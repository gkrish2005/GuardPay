import "dotenv/config";
import * as crypto from "crypto";
import { prisma } from "../../src/gateway.js";

async function main() {
  process.env.PORT = "3011";
  await import("../../src/index.js");
  console.log("=== STARTING WEBHOOK IDEMPOTENCY HARNESS ===");

  const customerId = "cust_idemp_test";
  const agentId = "agent_test_123";
  const actionType = "CREATE_ORDER";

  // Helpers to fire webhook requests
  async function fireWebhook(payload: any, signature: string): Promise<{ status: number; body: any }> {
    const rawBody = JSON.stringify(payload);
    const res = await fetch("http://localhost:3011/api/webhooks/razorpay", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-razorpay-signature": signature
      },
      body: rawBody
    });
    const status = res.status;
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status, body };
  }

  function getSignature(payload: any, secret: string): string {
    return crypto
      .createHmac("sha256", secret)
      .update(JSON.stringify(payload))
      .digest("hex");
  }

  // ----------------------------------------------------
  // Test Case 1: Sequential Duplicate Processing
  // ----------------------------------------------------
  console.log("\n[TEST CASE 1] Running Sequential Duplicate Webhook Test...");
  const orderId1 = `order_idemp_seq_${Date.now()}`;
  const eventId1 = `evt_idemp_seq_${Date.now()}`;

  // Seed transaction
  const txRequest1 = await prisma.transactionRequest.create({
    data: { agentId, customerId, actionType, amountPaise: 3000, cartSnapshot: {} }
  });
  const transaction1 = await prisma.transaction.create({
    data: { transactionRequestId: txRequest1.id, razorpayOrderId: orderId1, status: "CREATED" }
  });

  const payload1 = {
    id: eventId1,
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: `pay_idemp_seq_${Date.now()}`,
          order_id: orderId1,
          amount: 3000
        }
      }
    }
  };

  const validSig1 = getSignature(payload1, process.env.RAZORPAY_WEBHOOK_SECRET || "");

  // Send first webhook
  console.log("- Sending first webhook notification...");
  const resSeq1 = await fireWebhook(payload1, validSig1);
  assert(resSeq1.status === 200, `First response should be 200 OK: ${JSON.stringify(resSeq1.body)}`);

  // Verify DB state
  const txSeqAfter1 = await prisma.transaction.findUnique({ where: { id: transaction1.id } });
  assert(txSeqAfter1?.status === "CAPTURED", "Transaction status must update to CAPTURED");

  // Count audit logs
  const auditLogsCountAfter1 = await prisma.auditLog.count({
    where: { transactionRequestId: txRequest1.id }
  });

  // Send second webhook (identical payload and signature) sequentially
  console.log("- Sending duplicate webhook notification sequentially...");
  const resSeq2 = await fireWebhook(payload1, validSig1);
  assert(resSeq2.status === 200, "Duplicate response should be 200 OK");
  assert(resSeq2.body?.status === "ignored_duplicate", "Duplicate webhook response status must be 'ignored_duplicate'");

  // Assert transaction status and audit logs count remain unchanged
  const txSeqAfter2 = await prisma.transaction.findUnique({ where: { id: transaction1.id } });
  assert(txSeqAfter2?.status === "CAPTURED", "Transaction status must remain CAPTURED");

  const auditLogsCountAfter2 = await prisma.auditLog.count({
    where: { transactionRequestId: txRequest1.id }
  });
  assert(auditLogsCountAfter1 === auditLogsCountAfter2, "Audit logs count must not increase on duplicate webhooks");
  console.log("- Passed: Sequential duplicate test succeeded.");

  // ----------------------------------------------------
  // Test Case 2: Concurrent Duplicate Processing (Race Test)
  // ----------------------------------------------------
  console.log("\n[TEST CASE 2] Running Concurrent Duplicate Webhook Test...");
  const orderId2 = `order_idemp_con_${Date.now()}`;
  const eventId2 = `evt_idemp_con_${Date.now()}`;

  const txRequest2 = await prisma.transactionRequest.create({
    data: { agentId, customerId, actionType, amountPaise: 4000, cartSnapshot: {} }
  });
  const transaction2 = await prisma.transaction.create({
    data: { transactionRequestId: txRequest2.id, razorpayOrderId: orderId2, status: "CREATED" }
  });

  const payload2 = {
    id: eventId2,
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: `pay_idemp_con_${Date.now()}`,
          order_id: orderId2,
          amount: 4000
        }
      }
    }
  };

  const validSig2 = getSignature(payload2, process.env.RAZORPAY_WEBHOOK_SECRET || "");

  console.log("- Sending two identical webhooks concurrently...");
  const [resCon1, resCon2] = await Promise.all([
    fireWebhook(payload2, validSig2),
    fireWebhook(payload2, validSig2)
  ]);

  console.log(`- Response 1: ${resCon1.status} (Body: ${JSON.stringify(resCon1.body)})`);
  console.log(`- Response 2: ${resCon2.status} (Body: ${JSON.stringify(resCon2.body)})`);

  assert(resCon1.status === 200, "Response 1 should be 200");
  assert(resCon2.status === 200, "Response 2 should be 200");

  const bodies = [resCon1.body, resCon2.body];
  const processedExists = bodies.some(b => typeof b === "object" && b.status === "processed");
  const duplicateExists = bodies.some(b => typeof b === "object" && b.status === "ignored_duplicate");
  assert(processedExists, "At least one request must return 'processed'");
  assert(duplicateExists, "At least one request must return 'ignored_duplicate'");

  const txConAfter = await prisma.transaction.findUnique({ where: { id: transaction2.id } });
  assert(txConAfter?.status === "CAPTURED", "Transaction status must transition to CAPTURED");

  const auditLogsCountCon = await prisma.auditLog.count({
    where: { transactionRequestId: txRequest2.id }
  });
  console.log(`- Total audit logs created: ${auditLogsCountCon} (Expected: 2)`);
  assert(auditLogsCountCon === 2, "Exactly 2 audit log events (FAST_WEBHOOK_SKIP_DETECTED and PAYMENT_CAPTURED) must be recorded");
  console.log("- Passed: Concurrent duplicate test succeeded.");

  // ----------------------------------------------------
  // Test Case 3: Bad Signature on Reused ID Verification
  // ----------------------------------------------------
  console.log("\n[TEST CASE 3] Running Reused ID Signature Bypass Check...");
  const badSig = "invalid_signature_hash_value";

  console.log("- Sending webhook with duplicate ID but incorrect signature...");
  const resBadSig = await fireWebhook(payload1, badSig);

  console.log(`- Response status: ${resBadSig.status} (Body: ${JSON.stringify(resBadSig.body)})`);
  assert(resBadSig.status === 400, "Should be rejected with 400 Bad Request");
  assert(typeof resBadSig.body === "string" && (resBadSig.body.includes("Verification error") || resBadSig.body.includes("Invalid signature")), "Must be rejected for signature verification");
  console.log("- Passed: Reused ID signature check correctly prioritized.");

  // ----------------------------------------------------
  // Test Case 4: Unknown-Order Webhook Security Logging
  // ----------------------------------------------------
  console.log("\n[TEST CASE 4] Running Unknown-Order Webhook Security Test...");
  const unknownOrderId = `order_unknown_${Date.now()}`;
  const unknownEventId = `evt_unknown_${Date.now()}`;
  const txCountBefore = await prisma.transaction.count();

  const unknownPayload = {
    id: unknownEventId,
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: `pay_unknown_${Date.now()}`,
          order_id: unknownOrderId,
          amount: 5000
        }
      }
    }
  };

  const unknownSig = getSignature(unknownPayload, process.env.RAZORPAY_WEBHOOK_SECRET || "");
  const resUnknown = await fireWebhook(unknownPayload, unknownSig);

  console.log(`- Response status: ${resUnknown.status} (Body: ${JSON.stringify(resUnknown.body)})`);
  assert(resUnknown.status === 200, "Webhook endpoint should return 200 for logged unknown orders");
  
  // Assert no phantom transaction was created
  const txCountAfter = await prisma.transaction.count();
  assert(txCountBefore === txCountAfter, "Unknown order webhook MUST NOT create any new transaction in DB");

  // Assert WEBHOOK_UNKNOWN_ORDER_ID audit log event exists
  const logs = await prisma.auditLog.findMany({
    where: { event: "WEBHOOK_UNKNOWN_ORDER_ID" }
  });
  const unknownLog = logs.find(l => (l.metadata as any)?.razorpayOrderId === unknownOrderId);
  assert(unknownLog !== undefined, "WEBHOOK_UNKNOWN_ORDER_ID audit event must be logged");
  console.log("- Passed: Unknown-order webhook handled safely and security event logged.");

  // Clean up
  await prisma.transaction.deleteMany({ where: { id: { in: [transaction1.id, transaction2.id] } } });
  await prisma.transactionRequest.deleteMany({ where: { id: { in: [txRequest1.id, txRequest2.id] } } });
  await prisma.webhookEvent.deleteMany({ where: { razorpayEventId: { in: [eventId1, eventId2, unknownEventId] } } });

  console.log("\n=== ALL WEBHOOK IDEMPOTENCY HARNESS TESTS PASSED ===");
  process.exit(0);
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`Assertion failed: ${message}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Webhook Idempotency Harness failed:", err);
  process.exit(1);
});
