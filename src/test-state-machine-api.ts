import "dotenv/config";
import * as crypto from "crypto";
import { prisma } from "./gateway.js";

async function main() {
  console.log("=== STARTING PAYMENT STATE MACHINE API ENDPOINT TESTS ===");

  const customerId = "cust_state_api_test";
  const agentId = "agent_test_123";
  const actionType = "CREATE_ORDER";
  const cartId = `cart_state_api_${Date.now()}`;

  // 1. Create Consent and Transaction Request
  console.log("\n1. Seeding mock Transaction Request...");
  const consent = await prisma.consent.create({
    data: {
      customerId,
      cartId,
      productSnapshot: {},
      cartHash: "dummy",
      amountPaise: 5000,
      status: "CONFIRMED",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000)
    }
  });

  const txRequest = await prisma.transactionRequest.create({
    data: {
      agentId,
      customerId,
      actionType,
      amountPaise: 5000,
      cartSnapshot: {},
      consentId: consent.id
    }
  });

  const orderId = `order_state_api_${Date.now()}`;
  const transaction = await prisma.transaction.create({
    data: {
      transactionRequestId: txRequest.id,
      razorpayOrderId: orderId,
      status: "CREATED"
    }
  });
  console.log(`- Created Transaction ID: ${transaction.id} in state: ${transaction.status}`);

  // 2. Simulate Webhook FIRST (Fast capturing, CREATED -> CAPTURED skip-ahead)
  console.log("\n2. Simulating fast CAPTURED webhook call (skipping AUTHORIZED)...");
  const paymentId = `pay_state_api_${Date.now()}`;
  const webhookPayload = {
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: orderId,
          amount: 5000
        }
      }
    }
  };

  const webhookBodyStr = JSON.stringify(webhookPayload);
  const webhookSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET || "")
    .update(webhookBodyStr)
    .digest("hex");

  const webhookResponse = await fetch("http://localhost:3000/api/webhooks/razorpay", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-razorpay-signature": webhookSignature
    },
    body: webhookBodyStr
  });

  if (!webhookResponse.ok) {
    const errorText = await webhookResponse.text();
    throw new Error(`Webhook call failed: ${webhookResponse.status} ${errorText}`);
  }
  console.log("- Webhook accepted by server successfully.");

  // Verify state in DB (should be CAPTURED)
  const txAfterWebhook = await prisma.transaction.findUnique({
    where: { id: transaction.id }
  });
  console.log(`- Transaction status in DB: ${txAfterWebhook?.status} (Expected: CAPTURED)`);
  if (txAfterWebhook?.status !== "CAPTURED") {
    throw new Error("Fast webhook capture failed to update status to CAPTURED!");
  }

  // Verify FAST_WEBHOOK_SKIP_DETECTED audit log exists and lists correct bypassed states
  const skipLog = await prisma.auditLog.findFirst({
    where: {
      transactionRequestId: txRequest.id,
      event: "FAST_WEBHOOK_SKIP_DETECTED"
    }
  });
  if (!skipLog) {
    throw new Error("No FAST_WEBHOOK_SKIP_DETECTED audit event logged!");
  }
  const bypassed = (skipLog.metadata as any).bypassedStates;
  console.log(`- Passed: Found skip-ahead log with bypassed states: ${JSON.stringify(bypassed)}`);
  if (!Array.isArray(bypassed) || bypassed.length !== 2 || bypassed[0] !== "CHECKOUT_OPENED" || bypassed[1] !== "AUTHORIZED") {
    throw new Error(`Unexpected bypassed states: ${JSON.stringify(bypassed)}`);
  }

  // 3. Simulate Late /api/payments/verify call (Out-of-order CAPTURED -> AUTHORIZED attempt)
  console.log("\n3. Simulating late /verify call (attempting to transition CAPTURED -> AUTHORIZED)...");
  const verifySignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "")
    .update(orderId + "|" + paymentId)
    .digest("hex");

  const verifyResponse = await fetch("http://localhost:3000/api/payments/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: verifySignature
    })
  });

  console.log(`- Response status: ${verifyResponse.status} (Expected: 200)`);
  if (verifyResponse.status !== 200) {
    const errorBody = await verifyResponse.json();
    throw new Error(`Verify endpoint failed on out-of-order check: ${JSON.stringify(errorBody)}`);
  }

  // Check state in DB (should STILL be CAPTURED)
  const txAfterVerify = await prisma.transaction.findUnique({
    where: { id: transaction.id }
  });
  console.log(`- Transaction status in DB after verify: ${txAfterVerify?.status} (Expected: CAPTURED)`);
  if (txAfterVerify?.status !== "CAPTURED") {
    throw new Error("Transaction status downgraded from CAPTURED!");
  }

  // Verify Audit Log has OUT_OF_ORDER event
  const outOfOrderLog = await prisma.auditLog.findFirst({
    where: {
      transactionRequestId: txRequest.id,
      event: "PAYMENT_VERIFICATION_OUT_OF_ORDER"
    }
  });
  if (!outOfOrderLog) {
    throw new Error("No PAYMENT_VERIFICATION_OUT_OF_ORDER audit event logged!");
  }
  console.log(`- Passed: Found audit log event: "${outOfOrderLog.event}"`);
  console.log(`  Message: "${(outOfOrderLog.metadata as any).message}"`);

  // Clean up test data
  await prisma.transaction.delete({ where: { id: transaction.id } });
  await prisma.transactionRequest.delete({ where: { id: txRequest.id } });
  await prisma.consent.delete({ where: { id: consent.id } });

  console.log("\n=== ALL PAYMENT STATE MACHINE API ENDPOINT TESTS PASSED ===");
}

main().catch(err => {
  console.error("API State Machine Test failed:", err);
  process.exit(1);
});
