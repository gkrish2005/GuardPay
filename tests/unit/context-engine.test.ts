import "dotenv/config";
import { prisma, razorpay, requestPayment, requestConsent, confirmConsent, createTransactionRequest } from "../../src/gateway.js";

// 1. Setup in-process spy on razorpay.orders.create
let ordersCreateCallCount = 0;
const originalOrdersCreate = razorpay.orders.create.bind(razorpay.orders);
razorpay.orders.create = async function (params: any) {
  ordersCreateCallCount++;
  return await originalOrdersCreate(params);
};

// 2. Launch Express server in-process on a custom test port
process.env.PORT = "3008";
console.log("[TEST INITIALIZATION] Starting in-process test server on port 3008...");
import "../../src/index.js";

async function main() {
  console.log("=== STARTING CONTEXT ENGINE TESTS ===");

  const agentId = "agent_context_123";
  const actionType = "CREATE_ORDER";

  // Setup: Clean up database and seed agent
  console.log("1. Setting up database tables and agent...");
  await prisma.policy.deleteMany({ where: { agentId } });
  await prisma.agent.upsert({
    where: { id: agentId },
    update: { permissions: { CREATE_ORDER: { enabled: true } } },
    create: { id: agentId, name: "Context Agent", permissions: { CREATE_ORDER: { enabled: true } } }
  });

  // Seed standard policy: maxAmount = ₹20,000, approvalThreshold = ₹10,000, maxDiscountPercent = 15
  await prisma.policy.create({
    data: {
      agentId,
      actionType,
      maxAmount: 2000000,        // ₹20,000
      approvalThreshold: 1000000, // ₹10,000
      dailyTxLimit: 20,
      dailyValueLimit: 10000000,
      maxDiscountPercent: 15,
      version: 1
    }
  });

  // ----------------------------------------------------
  // Test Case 1: Rapid Repeated Checkout Velocity Flag
  // ----------------------------------------------------
  console.log("\n[TEST CASE 1] Running Rapid Repeated Checkout Velocity Flag Test...");
  ordersCreateCallCount = 0;
  const customerId1 = `cust_ctx_c1_${Date.now()}`;

  // Seed 3 prior requests via official gateway pipeline within the rolling 5-minute window
  for (let i = 1; i <= 3; i++) {
    const cartId = `cart_c1_${i}_${Date.now()}`;
    const { consentId } = await requestConsent(customerId1, cartId, "prod_5", "Socks purchase");
    await confirmConsent(consentId);
    await createTransactionRequest({ customerId: customerId1, agentId, actionType, cartId, consentId });
  }

  // 4th request created via official gateway pipeline (total count in rolling 5 mins = 4 > 3)
  const cartId1_4 = `cart_c1_4_${Date.now()}`;
  const { consentId: cId1_4 } = await requestConsent(customerId1, cartId1_4, "prod_5", "Socks purchase 4");
  await confirmConsent(cId1_4);
  const txReq1_4 = await createTransactionRequest({ customerId: customerId1, agentId, actionType, cartId: cartId1_4, consentId: cId1_4 });

  const res1 = await requestPayment(txReq1_4.id);
  console.log(`- Result: Verdict=${res1.verdict}, Reason="${res1.reason}"`);
  assert(res1.verdict === "NEEDS_APPROVAL", "Should escalate to NEEDS_APPROVAL due to rapid checkout velocity");
  assert(res1.reason === "Rapid repeated checkout velocity detected", `Expected velocity reason (got: "${res1.reason}")`);
  assert(ordersCreateCallCount === 0, "No Razorpay orders must be created on NEEDS_APPROVAL");

  const dec1 = await prisma.decision.findFirst({ where: { transactionRequestId: txReq1_4.id } });
  const signals1 = (dec1?.signalsChecked as any)?.contextSignals;
  assert(signals1?.rapidRepeatedCheckout === true, "contextSignals.rapidRepeatedCheckout must be true");
  assert(signals1?.recentCheckoutCount === 4, `recentCheckoutCount must be 4 (got ${signals1?.recentCheckoutCount})`);
  console.log("- Passed: Rapid repeated checkout velocity detected and handled.");

  // ----------------------------------------------------
  // Test Case 2: Unusual Order Amount vs History Flag
  // ----------------------------------------------------
  console.log("\n[TEST CASE 2] Running Unusual Order Amount vs History Flag Test...");
  ordersCreateCallCount = 0;
  const customerId2 = `cust_ctx_c2_${Date.now()}`;

  // Seed 2 historical CAPTURED transactions of ₹1,000 (100,000 paise) each for baseline
  for (let i = 1; i <= 2; i++) {
    const consent = await prisma.consent.create({
      data: {
        customerId: customerId2,
        cartId: `cart_hist_${i}`,
        productSnapshot: { items: [{ productId: "prod_5", name: "Dry-Fit Cushion Running Socks", price: 800, qty: 1 }] },
        cartHash: `hash_hist_${i}`,
        amountPaise: 100000,
        status: "CONFIRMED"
      }
    });
    const txReq = await prisma.transactionRequest.create({
      data: {
        agentId,
        customerId: customerId2,
        actionType,
        amountPaise: 100000,
        cartSnapshot: { items: [{ productId: "prod_5", name: "Dry-Fit Cushion Running Socks", price: 800, qty: 1 }] },
        consentId: consent.id
      }
    });
    await prisma.transaction.create({
      data: {
        transactionRequestId: txReq.id,
        status: "CAPTURED",
        razorpayOrderId: `order_hist_${i}_${Date.now()}`
      }
    });
  }

  // Submit new request for ₹6,500 (InfinityRN 4 Running Shoes). Baseline AOV = ₹1,000. ₹6,500 is 6.5x AOV (> 3x spike threshold)
  const cartId2_new = `cart_c2_new_${Date.now()}`;
  const { consentId: cId2_new } = await requestConsent(customerId2, cartId2_new, "prod_4", "Purchase of shoes");
  await confirmConsent(cId2_new);
  const txReq2_new = await createTransactionRequest({ customerId: customerId2, agentId, actionType, cartId: cartId2_new, consentId: cId2_new });

  const res2 = await requestPayment(txReq2_new.id);
  console.log(`- Result: Verdict=${res2.verdict}, Reason="${res2.reason}"`);
  assert(res2.verdict === "NEEDS_APPROVAL", "Should escalate to NEEDS_APPROVAL due to unusual order amount spike");
  assert(res2.reason === "Order amount significantly exceeds customer historical average", `Expected AOV spike reason (got: "${res2.reason}")`);
  assert(ordersCreateCallCount === 0, "No Razorpay orders must be created");

  const dec2 = await prisma.decision.findFirst({ where: { transactionRequestId: txReq2_new.id } });
  const signals2 = (dec2?.signalsChecked as any)?.contextSignals;
  assert(signals2?.unusualOrderAmount === true, "contextSignals.unusualOrderAmount must be true");
  assert(signals2?.historicalAverageAmountPaise === 100000, `historicalAverageAmountPaise should be 100000 (got ${signals2?.historicalAverageAmountPaise})`);
  console.log("- Passed: Unusual order amount vs history anomaly detected and escalated.");

  // ----------------------------------------------------
  // Test Case 3: Hard BLOCK Overrides Context Signals
  // ----------------------------------------------------
  console.log("\n[TEST CASE 3] Running Hard BLOCK Overrides Context Signals Test...");
  ordersCreateCallCount = 0;
  const customerId3 = `cust_ctx_c3_${Date.now()}`;

  // Independently seed 3 prior requests for customerId3 in rolling 5 mins
  for (let i = 1; i <= 3; i++) {
    const cartId = `cart_c3_${i}_${Date.now()}`;
    const { consentId } = await requestConsent(customerId3, cartId, "prod_5", "Socks purchase");
    await confirmConsent(consentId);
    await createTransactionRequest({ customerId: customerId3, agentId, actionType, cartId, consentId });
  }

  // 4th request: Triggers velocity (count = 4 > 3) AND exceeds absolute maxAmount of ₹20,000 (amount = ₹25,000)
  const consent3_over = await prisma.consent.create({
    data: {
      customerId: customerId3,
      cartId: `cart_c3_over_${Date.now()}`,
      productSnapshot: { items: [{ productId: "prod_1", name: "Alphafly 3 Running Shoes", price: 25000, qty: 1 }] },
      cartHash: "hash_c3_over",
      amountPaise: 2500000, // ₹25,000 > policy.maxAmount of ₹20,000
      status: "CONFIRMED"
    }
  });
  const txReq3_over = await prisma.transactionRequest.create({
    data: {
      agentId,
      customerId: customerId3,
      actionType,
      amountPaise: 2500000,
      cartSnapshot: { items: [{ productId: "prod_1", name: "Alphafly 3 Running Shoes", price: 25000, qty: 1 }] },
      consentId: consent3_over.id
    }
  });

  const res3 = await requestPayment(txReq3_over.id);
  console.log(`- Result: Verdict=${res3.verdict}, Reason="${res3.reason}"`);
  assert(res3.verdict === "BLOCK", "Over-limit request MUST be BLOCKed even when velocity flag is active");
  assert(res3.reason === "Exceeds absolute agent limit", `Expected maxAmount reason (got: "${res3.reason}")`);
  assert(ordersCreateCallCount === 0, "No Razorpay orders must be created");

  const dec3 = await prisma.decision.findFirst({ where: { transactionRequestId: txReq3_over.id } });
  const signals3 = (dec3?.signalsChecked as any)?.contextSignals;
  assert(signals3?.rapidRepeatedCheckout === true, "contextSignals.rapidRepeatedCheckout must still be recorded as true");
  console.log("- Passed: Hard BLOCK priority verified. Over-limit request is blocked, not sent to human approvals.");

  // ----------------------------------------------------
  // Test Case 4: New Product Novelty Tracking
  // ----------------------------------------------------
  console.log("\n[TEST CASE 4] Running New Product Novelty Tracking Test...");
  ordersCreateCallCount = 0;
  const customerId4 = `cust_ctx_c4_${Date.now()}`;

  // Seed historical purchase of prod_1
  const consent4_hist = await prisma.consent.create({
    data: {
      customerId: customerId4,
      cartId: `cart_c4_hist`,
      productSnapshot: { items: [{ productId: "prod_1", name: "Alphafly 3 Running Shoes", price: 15000, qty: 1 }] },
      cartHash: "hash_c4_hist",
      amountPaise: 1500000,
      status: "CONFIRMED"
    }
  });
  const txReq4_hist = await prisma.transactionRequest.create({
    data: {
      agentId,
      customerId: customerId4,
      actionType,
      amountPaise: 1500000,
      cartSnapshot: { items: [{ productId: "prod_1", name: "Alphafly 3 Running Shoes", price: 15000, qty: 1 }] },
      consentId: consent4_hist.id
    }
  });
  await prisma.transaction.create({
    data: {
      transactionRequestId: txReq4_hist.id,
      status: "CAPTURED",
      razorpayOrderId: `order_c4_${Date.now()}`
    }
  });

  // Submit new request for prod_5 (Socks - first time purchasing this product)
  const cartId4_new = `cart_c4_new_${Date.now()}`;
  const { consentId: cId4_new } = await requestConsent(customerId4, cartId4_new, "prod_5", "Purchase of socks");
  await confirmConsent(cId4_new);
  const txReq4_new = await createTransactionRequest({ customerId: customerId4, agentId, actionType, cartId: cartId4_new, consentId: cId4_new });

  await requestPayment(txReq4_new.id);
  const dec4 = await prisma.decision.findFirst({ where: { transactionRequestId: txReq4_new.id } });
  const signals4 = (dec4?.signalsChecked as any)?.contextSignals;
  assert(signals4?.isNewProductForCustomer === true, "isNewProductForCustomer must be true for first-time product purchase");
  assert(signals4?.newProductIds?.includes("prod_5"), "newProductIds must contain prod_5");
  console.log("- Passed: New product novelty correctly flagged and recorded in decision context.");

  // ----------------------------------------------------
  // Test Case 5: Clean Baseline (No Anomaly Signals -> ALLOW)
  // ----------------------------------------------------
  console.log("\n[TEST CASE 5] Running Clean Baseline Test...");
  ordersCreateCallCount = 0;
  const customerId5 = `cust_ctx_c5_${Date.now()}`;

  // Seed 2 historical purchases of prod_4 at ₹6,500
  for (let i = 1; i <= 2; i++) {
    const consent = await prisma.consent.create({
      data: {
        customerId: customerId5,
        cartId: `cart_c5_hist_${i}`,
        productSnapshot: { items: [{ productId: "prod_4", name: "InfinityRN 4 Running Shoes", price: 6500, qty: 1 }] },
        cartHash: `hash_c5_hist_${i}`,
        amountPaise: 650000,
        status: "CONFIRMED"
      }
    });
    const txReq = await prisma.transactionRequest.create({
      data: {
        agentId,
        customerId: customerId5,
        actionType,
        amountPaise: 650000,
        cartSnapshot: { items: [{ productId: "prod_4", name: "InfinityRN 4 Running Shoes", price: 6500, qty: 1 }] },
        consentId: consent.id
      }
    });
    await prisma.transaction.create({
      data: {
        transactionRequestId: txReq.id,
        status: "CAPTURED",
        razorpayOrderId: `order_c5_hist_${i}_${Date.now()}`
      }
    });
  }

  // Normal request for prod_4 (₹6,500) matching historical average and within approval threshold
  const cartId5_new = `cart_c5_new_${Date.now()}`;
  const { consentId: cId5_new } = await requestConsent(customerId5, cartId5_new, "prod_4", "Repurchase of shoes");
  await confirmConsent(cId5_new);
  const txReq5_new = await createTransactionRequest({ customerId: customerId5, agentId, actionType, cartId: cartId5_new, consentId: cId5_new });

  const res5 = await requestPayment(txReq5_new.id);
  console.log(`- Result: Verdict=${res5.verdict}, Reason="${res5.reason}"`);
  assert(res5.verdict === "ALLOW", "Clean baseline request under threshold must be ALLOWed");
  assert(res5.reason === "Under policy auto-approval threshold", `Expected auto-approval reason (got: "${res5.reason}")`);
  assert(ordersCreateCallCount === 1, "Exactly 1 Razorpay order must be created for ALLOW verdict");

  const dec5 = await prisma.decision.findFirst({ where: { transactionRequestId: txReq5_new.id } });
  const signals5 = (dec5?.signalsChecked as any)?.contextSignals;
  assert(signals5?.rapidRepeatedCheckout === false, "rapidRepeatedCheckout must be false");
  assert(signals5?.unusualOrderAmount === false, "unusualOrderAmount must be false");
  assert(signals5?.isNewProductForCustomer === false, "isNewProductForCustomer must be false (repurchase)");
  console.log("- Passed: Clean baseline evaluated and auto-approved without friction.");

  // Clean up
  console.log("\nCleaning up database entries...");
  await prisma.policy.deleteMany({ where: { agentId } });
  await prisma.transaction.deleteMany({});
  await prisma.decision.deleteMany({});
  await prisma.transactionRequest.deleteMany({});
  await prisma.consent.deleteMany({});

  // Restore spy
  razorpay.orders.create = originalOrdersCreate;

  console.log("\n=== ALL CONTEXT ENGINE TESTS PASSED SUCCESSFULLY ===");
  process.exit(0);
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`Assertion failed: ${message}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Test Harness failed:", err);
  process.exit(1);
});
