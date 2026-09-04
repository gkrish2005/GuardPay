import "dotenv/config";
import * as crypto from "crypto";
import { prisma } from "../../src/gateway.js";

async function main() {
  process.env.PORT = "3010";
  await import("../../src/index.js");
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
    id: `evt_state_api_${Date.now()}`,
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

  const webhookResponse = await fetch("http://localhost:3010/api/webhooks/razorpay", {
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

  // Verify FAST_WEBHOOK_SKIP_DETECTED audit log exists
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

  // 3. Simulate Late /api/payments/verify call (Out-of-order CAPTURED -> AUTHORIZED attempt)
  console.log("\n3. Simulating late /verify call (attempting to transition CAPTURED -> AUTHORIZED)...");
  const verifySignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "")
    .update(orderId + "|" + paymentId)
    .digest("hex");

  const verifyResponse = await fetch("http://localhost:3010/api/payments/verify", {
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

  const txAfterVerify = await prisma.transaction.findUnique({
    where: { id: transaction.id }
  });
  console.log(`- Transaction status in DB after verify: ${txAfterVerify?.status} (Expected: CAPTURED)`);
  if (txAfterVerify?.status !== "CAPTURED") {
    throw new Error("Transaction status downgraded from CAPTURED!");
  }

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

  // 4. Payment/Order Mismatch Cross-Submission Rejection Test (Invariant #6)
  console.log("\n4. Testing Payment/Order Mismatch Cross-Submission Rejection (Valid Signature, DB Cross-Check)...");
  const orderA = `order_A_${Date.now()}`;
  const orderB = `order_B_${Date.now()}`;
  const payB = `pay_B_${Date.now()}`;

  // Seed Transaction A (unpaid / CREATED)
  const consentA = await prisma.consent.create({
    data: {
      customerId: "cust_mismatch_A",
      cartId: `cart_A_${Date.now()}`,
      productSnapshot: { items: [{ productId: "prod_4", name: "InfinityRN 4", price: 6500, qty: 1 }] },
      cartHash: "hash_A",
      amountPaise: 650000,
      status: "CONFIRMED"
    }
  });
  const txReqA = await prisma.transactionRequest.create({
    data: {
      agentId,
      customerId: "cust_mismatch_A",
      actionType,
      amountPaise: 650000,
      cartSnapshot: { items: [{ productId: "prod_4", name: "InfinityRN 4", price: 6500, qty: 1 }] },
      consentId: consentA.id
    }
  });
  const txA = await prisma.transaction.create({
    data: {
      transactionRequestId: txReqA.id,
      razorpayOrderId: orderA,
      status: "CREATED"
    }
  });
  console.log(`- [SEED PRECONDITION 1] Transaction A committed: ID=${txA.id}, OrderID=${orderA}, Status=${txA.status}, PaymentID=null`);

  // Seed Transaction B (already paid with payB)
  const consentB = await prisma.consent.create({
    data: {
      customerId: "cust_mismatch_B",
      cartId: `cart_B_${Date.now()}`,
      productSnapshot: { items: [{ productId: "prod_4", name: "InfinityRN 4", price: 6500, qty: 1 }] },
      cartHash: "hash_B",
      amountPaise: 650000,
      status: "CONFIRMED"
    }
  });
  const txReqB = await prisma.transactionRequest.create({
    data: {
      agentId,
      customerId: "cust_mismatch_B",
      actionType,
      amountPaise: 650000,
      cartSnapshot: { items: [{ productId: "prod_4", name: "InfinityRN 4", price: 6500, qty: 1 }] },
      consentId: consentB.id
    }
  });
  const txB = await prisma.transaction.create({
    data: {
      transactionRequestId: txReqB.id,
      razorpayOrderId: orderB,
      razorpayPaymentId: payB,
      status: "CAPTURED"
    }
  });
  console.log(`- [SEED PRECONDITION 2] Transaction B committed: ID=${txB.id}, OrderID=${orderB}, Status=${txB.status}, PaymentID=${payB}`);

  // Generate a GENUINELY VALID HMAC signature for (orderA + "|" + payB)
  // This guarantees signature verification passes and only internal DB resolution catches the mismatch.
  const validSignatureForOrderAPaymentB = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "")
    .update(orderA + "|" + payB)
    .digest("hex");
  console.log(`- Generated valid HMAC for (orderA|payB): ${validSignatureForOrderAPaymentB.slice(0, 16)}... (signature check will pass)`);

  // Attempt to submit Payment B against Order A
  console.log(`- Submitting POST /api/payments/verify with OrderID=${orderA} and PaymentID=${payB}...`);
  const mismatchVerifyRes = await fetch("http://localhost:3010/api/payments/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      razorpay_order_id: orderA,
      razorpay_payment_id: payB,
      razorpay_signature: validSignatureForOrderAPaymentB
    })
  });

  console.log(`- Mismatch verification HTTP status: ${mismatchVerifyRes.status} (Expected: 400)`);
  assert(mismatchVerifyRes.status === 400, "Cross-submitting payment against mismatched order must return 400");
  const mismatchBody = await mismatchVerifyRes.json();
  console.log(`- Response Error: "${mismatchBody.error}"`);
  assert(
    mismatchBody.error.includes("Payment ID mismatch"),
    `Expected Payment ID mismatch error (got: "${mismatchBody.error}")`
  );

  // Assert Transaction A was NOT modified or transitioned
  const txAfterMismatch = await prisma.transaction.findUnique({ where: { id: txA.id } });
  assert(txAfterMismatch?.status === "CREATED", "Transaction A status must remain CREATED");
  assert(txAfterMismatch?.razorpayPaymentId === null, "Transaction A must not bind payment B");

  // Assert PAYMENT_VERIFICATION_PAYMENT_MISMATCH audit log was written with conflicting order ID
  const mismatchLogs = await prisma.auditLog.findMany({
    where: { event: "PAYMENT_VERIFICATION_PAYMENT_MISMATCH" }
  });
  const mismatchLog = mismatchLogs.find(l => (l.metadata as any)?.razorpay_order_id === orderA);
  assert(mismatchLog !== undefined, "PAYMENT_VERIFICATION_PAYMENT_MISMATCH security audit log must be written");
  console.log(`- Stored Security Audit Log: Event=${mismatchLog.event}, ClaimedOrder=${(mismatchLog.metadata as any)?.claimedOrderId}, ActualOrder=${(mismatchLog.metadata as any)?.actualOrderIdForPayment}`);
  assert(
    (mismatchLog?.metadata as any)?.actualOrderIdForPayment === orderB || (mismatchLog?.metadata as any)?.conflictingOrderId === orderB,
    `Audit log must record conflicting order ID ${orderB}`
  );
  console.log("- Passed: Internal DB resolution caught payment/order mismatch despite valid HMAC signature.");

  // Clean up
  await prisma.transaction.deleteMany({ where: { id: { in: [transaction.id, txA.id, txB.id] } } });
  await prisma.transactionRequest.deleteMany({ where: { id: { in: [txRequest.id, txReqA.id, txReqB.id] } } });
  await prisma.consent.deleteMany({ where: { id: { in: [consent.id, consentA.id, consentB.id] } } });

  console.log("\n=== ALL PAYMENT STATE MACHINE API ENDPOINT TESTS PASSED ===");
  process.exit(0);
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`Assertion failed: ${message}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("API State Machine Test failed:", err);
  process.exit(1);
});
