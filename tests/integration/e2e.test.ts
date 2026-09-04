import "dotenv/config";
import * as crypto from "crypto";
import { prisma, razorpay } from "../../src/gateway.js";
import * as gateway from "../../src/gateway.js";

// Database cleanup helper
async function clearDatabase() {
  console.log("  [DB CLEAR] Resetting database tables...");
  await prisma.transaction.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.decision.deleteMany({});
  await prisma.approval.deleteMany({});
  await prisma.transactionRequest.deleteMany({});
  await prisma.consent.deleteMany({});
  await prisma.policy.deleteMany({});
}

async function runE2EIteration(iterationNum: number) {
  console.log(`\n======================================================`);
  console.log(`=== RUNNING INTEGRATION TEST ITERATION #${iterationNum} ===`);
  console.log(`======================================================`);

  await clearDatabase();

  const customerId = `cust_e2e_${iterationNum}`;
  const agentId = "agent_test_123";
  const actionType = "CREATE_ORDER";
  const cartId = `cart_e2e_${iterationNum}_${Date.now()}`;

  let ordersCreateCallCount = 0;
  const originalOrdersCreate = razorpay.orders.create.bind(razorpay.orders);
  razorpay.orders.create = async function (params: any) {
    ordersCreateCallCount++;
    return originalOrdersCreate(params);
  };

  try {
    // ----------------------------------------------------
    // SEED AGENT AND POLICY
    // ----------------------------------------------------
    console.log("\n[SEED] Configuring Agent permissions & Governance Policy...");
    await prisma.agent.upsert({
      where: { id: agentId },
      update: { permissions: { CREATE_ORDER: { enabled: true } } },
      create: { id: agentId, name: "Integration Test Agent", permissions: { CREATE_ORDER: { enabled: true } } }
    });

    await prisma.policy.create({
      data: {
        id: `policy_e2e_${iterationNum}_${Date.now()}`,
        agentId,
        actionType,
        maxAmount: 2000000, // ₹20,000 max limit
        approvalThreshold: 1000000, // ₹10,000 threshold
        dailyTxLimit: 10,
        dailyValueLimit: 10000000,
        version: 1,
      }
    });

    // ----------------------------------------------------
    // TEST CASE 1: HAPPY PATH TO CAPTURED
    // ----------------------------------------------------
    console.log("\n=== TEST CASE 1: HAPPY PATH TO CAPTURED ===");

    console.log("A. Requesting consent for ₹6,500 (InfinityRN 4 Running Shoes)...");
    const consentRes = await gateway.requestConsent(
      customerId,
      cartId,
      "prod_4", // InfinityRN 4 (₹6,500)
      "Purchase of InfinityRN 4 Running Shoes"
    );
    console.log(`- Created Consent ID: ${consentRes.consentId}`);

    console.log("B. Simulating customer out-of-band UI confirmation...");
    await gateway.confirmConsent(consentRes.consentId);
    
    const confirmedConsent = await prisma.consent.findUnique({
      where: { id: consentRes.consentId }
    });
    if (!confirmedConsent || confirmedConsent.status !== "CONFIRMED") {
      throw new Error("Consent confirmation failed to update DB state!");
    }
    console.log("- Consent successfully CONFIRMED in DB.");

    console.log("C. Generating Transaction Request...");
    const txRequest = await gateway.createTransactionRequest({
      customerId,
      agentId,
      actionType,
      cartId,
      consentId: consentRes.consentId
    });
    console.log(`- TransactionRequest created: ${txRequest.id}`);

    ordersCreateCallCount = 0;

    console.log("D. Submitting payment request for Governance evaluation...");
    const paymentRes = await gateway.requestPayment(txRequest.id);
    console.log(`- Governance verdict: ${paymentRes.verdict} (Expected: ALLOW)`);
    console.log(`- Dynamic Order ID generated: ${paymentRes.orderId}`);

    if (paymentRes.verdict !== "ALLOW") {
      throw new Error(`Governance failed: expected ALLOW but got ${paymentRes.verdict}`);
    }
    if (!paymentRes.orderId) {
      throw new Error("Razorpay order ID was not returned for ALLOW request!");
    }
    if (ordersCreateCallCount !== 1) {
      throw new Error(`Razorpay orders.create was invoked ${ordersCreateCallCount} times (expected exactly 1)`);
    }
    console.log("- ALLOW verdict and Razorpay order creation verified.");

    console.log("E. Simulating customer completing Razorpay Checkout and verifying signature...");
    const paymentId = `pay_e2e_${Date.now()}`;
    const orderId = paymentRes.orderId;
    
    const verifySignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "")
      .update(orderId + "|" + paymentId)
      .digest("hex");

    const verifyResponse = await fetch("http://localhost:3012/api/payments/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: verifySignature
      })
    });

    if (!verifyResponse.ok) {
      const errorText = await verifyResponse.text();
      throw new Error(`Payment verification endpoint failed: ${verifyResponse.status} ${errorText}`);
    }

    const txAfterVerify = await prisma.transaction.findFirst({
      where: { transactionRequestId: txRequest.id }
    });
    if (!txAfterVerify || txAfterVerify.status !== "AUTHORIZED") {
      throw new Error(`Expected transaction status to be AUTHORIZED but got: ${txAfterVerify?.status}`);
    }
    console.log(`- Verified Transaction status updated to: ${txAfterVerify.status}`);

    console.log("F. Simulating Razorpay payment.captured webhook delivery...");
    const webhookPayload = {
      id: `evt_e2e_${Date.now()}`,
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: orderId,
            amount: 650000,
          }
        }
      }
    };

    const webhookBodyStr = JSON.stringify(webhookPayload);
    const webhookSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET || "")
      .update(webhookBodyStr)
      .digest("hex");

    const webhookResponse = await fetch("http://localhost:3012/api/webhooks/razorpay", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-razorpay-signature": webhookSignature
      },
      body: webhookBodyStr
    });

    if (!webhookResponse.ok) {
      const errorText = await webhookResponse.text();
      throw new Error(`Webhook verification endpoint failed: ${webhookResponse.status} ${errorText}`);
    }

    console.log("G. Verifying DB final status updates & Audit Logs...");
    const txAfterWebhook = await prisma.transaction.findFirst({
      where: { transactionRequestId: txRequest.id }
    });
    if (!txAfterWebhook || txAfterWebhook.status !== "CAPTURED") {
      throw new Error(`Expected terminal transaction status to be CAPTURED but got: ${txAfterWebhook?.status}`);
    }
    console.log(`- Confirmed: DB Transaction status transitioned to: ${txAfterWebhook.status}`);

    const auditLogs = await prisma.auditLog.findMany({
      where: { transactionRequestId: txRequest.id },
      orderBy: { timestamp: "asc" }
    });

    const hasAllowLog = auditLogs.some(l => l.event === "DECISION_ALLOWED");
    const hasOrderLog = auditLogs.some(l => l.event === "RAZORPAY_ORDER_CREATED");
    const hasVerifyLog = auditLogs.some(l => l.event === "PAYMENT_VERIFICATION_SUCCESS");
    const hasCaptureLog = auditLogs.some(l => l.event === "PAYMENT_CAPTURED");

    if (!hasAllowLog || !hasOrderLog || !hasVerifyLog || !hasCaptureLog) {
      throw new Error("Audit log trail is missing required payment state events!");
    }
    console.log("- Passed: Case 1 audit log chain completed successfully.");

    // ----------------------------------------------------
    // TEST CASE 2: OVER-LIMIT PATH (BLOCK)
    // ----------------------------------------------------
    console.log("\n=== TEST CASE 2: OVER-LIMIT PATH (BLOCK) ===");
    
    const largeProductSnapshot = {
      items: [
        { productId: "prod_1", name: "Alphafly 3 Running Shoes", price: 15000, qty: 1 },
        { productId: "prod_2", name: "Vaporfly 3 Running Shoes", price: 12000, qty: 1 }
      ]
    };
    const largeAmountPaise = 2700000;
    const largeCartHash = gateway.computeCartHash(largeProductSnapshot, largeAmountPaise);

    const blockConsent = await prisma.consent.create({
      data: {
        customerId,
        cartId: `cart_large_${customerId}`,
        productSnapshot: largeProductSnapshot,
        cartHash: largeCartHash,
        amountPaise: largeAmountPaise,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000)
      }
    });

    await gateway.confirmConsent(blockConsent.id);
    const blockTxRequest = await gateway.createTransactionRequest({
      customerId,
      agentId,
      actionType,
      cartId: `cart_large_${customerId}`,
      consentId: blockConsent.id
    });

    ordersCreateCallCount = 0;

    console.log("B. Requesting payment for over-limit request...");
    const blockPaymentRes = await gateway.requestPayment(blockTxRequest.id);
    console.log(`- Governance verdict: ${blockPaymentRes.verdict} (Expected: BLOCK)`);
    console.log(`- Verdict Reason: "${blockPaymentRes.reason}"`);

    if (blockPaymentRes.verdict !== "BLOCK") {
      throw new Error(`Governance failed: expected BLOCK but got ${blockPaymentRes.verdict}`);
    }
    if (ordersCreateCallCount !== 0) {
      throw new Error(`Security Violation: Razorpay orders.create was called ${ordersCreateCallCount} times for BLOCKED verdict!`);
    }
    console.log("- Passed: Case 2 over-limit block and zero-calls Razorpay restriction verified.");

    // ----------------------------------------------------
    // TEST CASE 3: EXPIRED CONSENT REJECTION AT APPROVAL
    // ----------------------------------------------------
    console.log("\n=== TEST CASE 3: EXPIRED CONSENT REJECTION AT APPROVAL ===");

    const approveConsent = await prisma.consent.create({
      data: {
        customerId,
        cartId: `cart_approve_${customerId}`,
        productSnapshot: {
          items: [{ productId: "prod_2", name: "Vaporfly 3 Running Shoes", price: 12000, qty: 1 }]
        },
        cartHash: gateway.computeCartHash(
          { items: [{ productId: "prod_2", name: "Vaporfly 3 Running Shoes", price: 12000, qty: 1 }] },
          1200000
        ),
        amountPaise: 1200000,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000)
      }
    });

    await gateway.confirmConsent(approveConsent.id);

    const approveTxRequest = await gateway.createTransactionRequest({
      customerId,
      agentId,
      actionType,
      cartId: `cart_approve_${customerId}`,
      consentId: approveConsent.id
    });

    const approvePaymentRes = await gateway.requestPayment(approveTxRequest.id);
    console.log(`- Governance verdict: ${approvePaymentRes.verdict} (Expected: NEEDS_APPROVAL)`);

    // Simulate consent expiration
    await prisma.consent.update({
      where: { id: approveConsent.id },
      data: {
        expiresAt: new Date(Date.now() - 60 * 60 * 1000)
      }
    });

    ordersCreateCallCount = 0;

    const approveResponse = await fetch(`http://localhost:3012/api/approvals/${approveTxRequest.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });

    console.log(`- HTTP Response status: ${approveResponse.status} (Expected: 400)`);
    const approveResult = await approveResponse.json();
    console.log(`- Error returned: "${approveResult.error}"`);

    if (approveResponse.status !== 400) {
      throw new Error(`Expected HTTP status 400 but got ${approveResponse.status}`);
    }
    if (ordersCreateCallCount !== 0) {
      throw new Error(`Security Violation: Razorpay orders.create was called ${ordersCreateCallCount} times for expired consent approval!`);
    }
    console.log("- Passed: Case 3 expired consent approval block successfully caught and rejected.");

    console.log(`\n=== ITERATION #${iterationNum} PASSED SUCCESSFULLY ===`);
  } finally {
    razorpay.orders.create = originalOrdersCreate;
  }
}

async function main() {
  process.env.PORT = "3012";
  await import("../../src/index.js");
  console.log("=== STARTING PHASE 1 E2E INTEGRATION TEST SUITE ===");
  console.log("Running E2E flow sequential iterations (spec requirement)...");

  await runE2EIteration(1);
  await runE2EIteration(2);

  console.log("\n======================================================");
  console.log("=== ALL PHASE 1 INTEGRATION TESTS PASSED RELIABLY ===");
  console.log("======================================================");
  process.exit(0);
}

main().catch(err => {
  console.error("E2E Integration Test failed:", err);
  process.exit(1);
});
