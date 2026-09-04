import "dotenv/config";
import crypto from "crypto";
import { prisma, razorpay, requestConsent, createTransactionRequest, requestPayment } from "../src/gateway.js";
import { auditLogRepository } from "../src/audit-log.js";

async function main() {
  console.log("================================================================================");
  console.log("       LIVE ENDPOINT DE-RISKING: REAL RAZORPAY ORDER, CALLBACK & WEBHOOK        ");
  console.log("================================================================================");

  const serverUrl = "http://localhost:3000";

  // 1. Create a real Razorpay Order via requestPayment
  console.log("1. Creating real Razorpay order through governed gateway...");
  const cartId = "cart_derisk_live";
  const consent = await requestConsent("cust_derisk_live", cartId, "prod_3", "Pegasus 41 Running Shoes");
  await prisma.consent.update({ where: { id: consent.consentId }, data: { status: "CONFIRMED" } });

  const txReq = await createTransactionRequest({
    customerId: "cust_derisk_live",
    agentId: "agent_revenue",
    actionType: "CREATE_ORDER",
    cartId,
    consentId: consent.consentId,
  });

  const paymentRes = await requestPayment(txReq.id);
  console.log(`- Governance Verdict : ${paymentRes.verdict}`);
  console.log(`- Real Razorpay Order : ${paymentRes.orderId}`);
  assert(paymentRes.verdict === "ALLOW", "Must return ALLOW");
  assert(!!paymentRes.orderId && paymentRes.orderId.startsWith("order_"), "Must return real order ID");

  const realOrderId = paymentRes.orderId!;
  const simulatedPaymentId = `pay_live_test_${Date.now()}`;

  // 2. Test Real Browser Callback HMAC Verification: POST /api/payments/verify
  console.log("\n2. Testing POST /api/payments/verify with real HMAC-SHA256 signature...");
  const keySecret = process.env.RAZORPAY_KEY_SECRET || "";
  assert(!!keySecret, "RAZORPAY_KEY_SECRET must be configured in .env");

  // Compute valid client signature over order_id|payment_id
  const payloadToSign = `${realOrderId}|${simulatedPaymentId}`;
  const validClientSignature = crypto
    .createHmac("sha256", keySecret)
    .update(payloadToSign)
    .digest("hex");

  const verifyRes = await fetch(`${serverUrl}/api/payments/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      razorpay_order_id: realOrderId,
      razorpay_payment_id: simulatedPaymentId,
      razorpay_signature: validClientSignature,
    }),
  });

  const verifyData: any = await verifyRes.json();
  console.log(`- /api/payments/verify Status: ${verifyRes.status}`);
  console.log(`- /api/payments/verify Response:`, verifyData);
  assert(verifyRes.status === 200, `/api/payments/verify should return 200 (got: ${verifyRes.status})`);
  assert(verifyData.status === "success" || verifyData.status === "verified", "Response status should be success/verified");

  // Check DB state transition
  const txAfterVerify = await prisma.transaction.findFirst({
    where: { transactionRequestId: txReq.id },
  });
  console.log(`- DB Transaction Status after verification: ${txAfterVerify?.status} (Expected: AUTHORIZED)`);
  assert(txAfterVerify?.status === "AUTHORIZED", "Transaction must be in AUTHORIZED status");

  // 3. Test Real Webhook Delivery & Idempotency: POST /api/webhooks/razorpay
  console.log("\n3. Testing POST /api/webhooks/razorpay with real HMAC-SHA256 signature...");
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || "";
  assert(!!webhookSecret, "RAZORPAY_WEBHOOK_SECRET must be configured in .env");

  const webhookPayload = JSON.stringify({
    entity: "event",
    account_id: "acc_guardpay_test",
    event: "payment.captured",
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: simulatedPaymentId,
          order_id: realOrderId,
          amount: txReq.amountPaise,
          currency: "INR",
          status: "captured",
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
    id: `event_derisk_${Date.now()}`,
  });

  const webhookSignature = crypto
    .createHmac("sha256", webhookSecret)
    .update(webhookPayload)
    .digest("hex");

  const webhookRes = await fetch(`${serverUrl}/api/webhooks/razorpay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-razorpay-signature": webhookSignature,
    },
    body: webhookPayload,
  });

  const webhookData: any = await webhookRes.json();
  console.log(`- /api/webhooks/razorpay Status: ${webhookRes.status}`);
  console.log(`- /api/webhooks/razorpay Response:`, webhookData);
  assert(webhookRes.status === 200, `Webhook endpoint should return 200 (got: ${webhookRes.status})`);
  assert(webhookData.status === "processed", "Webhook response status should be 'processed'");

  // Check DB final state
  const txFinal = await prisma.transaction.findFirst({
    where: { transactionRequestId: txReq.id },
  });
  console.log(`- DB Transaction Final Status: ${txFinal?.status} (Expected: CAPTURED)`);
  assert(txFinal?.status === "CAPTURED", "Transaction must be in CAPTURED status");

  // 4. Verify Audit Chain
  const chainCheck = await auditLogRepository.verifyChain();
  console.log(`- Cryptographic Audit Chain Valid: ${chainCheck.isValid}`);
  assert(chainCheck.isValid === true, "Audit chain must remain 100% valid");

  console.log("\n================================================================================");
  console.log("       ALL ENDPOINTS DE-RISKED & CONFIRMED WORKING AGAINST LIVE SERVER!         ");
  console.log("================================================================================");
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`\n✖ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Live de-risking test failed:", err);
  process.exit(1);
});
