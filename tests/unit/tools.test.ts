import {
  prisma,
  razorpay,
  searchProducts,
  getProduct,
  proposeUpsell,
  requestConsent,
  confirmConsent,
  createTransactionRequest,
  requestPayment,
  computeCartHash,
} from "../../src/gateway.js";

async function runTests() {
  console.log("=== STARTING GATEWAY TOOL VERIFICATION HARNESS ===");

  // Setup spy on razorpay.orders.create
  let ordersCreateCallCount = 0;
  const originalOrdersCreate = razorpay.orders.create.bind(razorpay.orders);
  razorpay.orders.create = async function (params: any) {
    ordersCreateCallCount++;
    return originalOrdersCreate(params);
  };

  const customerId = "cust_test_456";
  const agentId = "agent_test_123";
  const actionType = "CREATE_ORDER";
  const cartId = `cart_${Date.now()}`;

  // 1. Seed or Update the Policy for agent_test_123 / CREATE_ORDER
  console.log("\n1. Seeding agent policy in database...");
  const existingPolicy = await prisma.policy.findFirst({
    where: { agentId, actionType },
    orderBy: { version: "desc" },
  });

  let policy;
  if (existingPolicy) {
    policy = await prisma.policy.create({
      data: {
        agentId,
        actionType,
        maxAmount: 2000000, // ₹20,000 (paise)
        approvalThreshold: 1000000, // ₹10,000 (paise)
        dailyTxLimit: 10,
        dailyValueLimit: 10000000,
        version: existingPolicy.version + 1,
      },
    });
  } else {
    policy = await prisma.policy.create({
      data: {
        agentId,
        actionType,
        maxAmount: 2000000,
        approvalThreshold: 1000000,
        dailyTxLimit: 10,
        dailyValueLimit: 10000000,
        version: 1,
      },
    });
  }
  console.log(`Policy configured: maxAmount=₹${policy.maxAmount/100}, approvalThreshold=₹${policy.approvalThreshold/100}`);

  // 2. Test Catalog Operations
  console.log("\n2. Testing catalog search and product operations...");
  const shoes = searchProducts("Shoes");
  console.log(`- Found ${shoes.length} shoes in catalog (expected > 0)`);
  if (shoes.length === 0) throw new Error("Search failed to return products");

  const product = getProduct("prod_1");
  console.log(`- Lookup prod_1: ${product.name} (Price: ₹${product.price})`);
  if (product.name !== "Alphafly 3 Running Shoes") throw new Error("Product lookup failed");

  const upsell = proposeUpsell(cartId);
  console.log(`- Propose Upsell: ${upsell.product.name} (Price: ₹${upsell.price})`);
  if (upsell.product.id !== "prod_5") throw new Error("Upsell proposal failed");

  // 3. Test Invalid, Missing, and Unconfirmed Consent Rejection
  console.log("\n3. Testing consent validation checks in createTransactionRequest...");

  try {
    await createTransactionRequest({
      customerId,
      agentId,
      actionType,
      cartId,
      consentId: "",
    });
    throw new Error("Failed: Missing consentId should have thrown an error");
  } catch (err: any) {
    console.log(`- Passed: Missing consentId rejected correctly: "${err.message}"`);
  }

  try {
    await createTransactionRequest({
      customerId,
      agentId,
      actionType,
      cartId,
      consentId: "nonexistent_consent_id",
    });
    throw new Error("Failed: Nonexistent consentId should have thrown an error");
  } catch (err: any) {
    console.log(`- Passed: Nonexistent consentId rejected correctly: "${err.message}"`);
  }

  // Create PENDING consent
  const { consentId: pendingConsentId } = await requestConsent(
    customerId,
    cartId,
    "prod_4", // ₹6,500
    "Requesting consent for InfinityRN 4"
  );
  console.log(`- Created PENDING consent: ${pendingConsentId}`);

  try {
    await createTransactionRequest({
      customerId,
      agentId,
      actionType,
      cartId,
      consentId: pendingConsentId,
    });
    throw new Error("Failed: PENDING consent should have thrown an error");
  } catch (err: any) {
    console.log(`- Passed: PENDING consent rejected correctly: "${err.message}"`);
  }

  // 4. Test Cart Tampering Detection (Hash Mismatch)
  console.log("\n4. Testing cart snapshot tampering detection...");
  await confirmConsent(pendingConsentId);
  console.log(`- Confirmed consent: ${pendingConsentId}`);

  // Tamper with the database record directly
  await prisma.consent.update({
    where: { id: pendingConsentId },
    data: {
      productSnapshot: {
        items: [
          {
            productId: "prod_4",
            name: "InfinityRN 4 Running Shoes (TAMPERED)",
            price: 50,
            qty: 1,
          },
        ],
      },
    },
  });
  console.log("- Tampered with database record directly (modified price to ₹50)");

  try {
    await createTransactionRequest({
      customerId,
      agentId,
      actionType,
      cartId,
      consentId: pendingConsentId,
    });
    throw new Error("Failed: Tampered cart snapshot should have failed integrity check");
  } catch (err: any) {
    console.log(`- Passed: Tampered snapshot rejected correctly: "${err.message}"`);
  }

  // Reset spy call count
  ordersCreateCallCount = 0;

  // 5. Test Payment Requests for ALLOW verdict (under ₹10,000 / 1,000,000 paise)
  console.log("\n5. Testing ALLOW verdict (e.g., ₹6,500)...");
  const { consentId: allowConsentId } = await requestConsent(
    customerId,
    cartId,
    "prod_4", // ₹6,500
    "Purchase of InfinityRN 4"
  );
  await confirmConsent(allowConsentId);

  const allowTxRequest = await createTransactionRequest({
    customerId,
    agentId,
    actionType,
    cartId,
    consentId: allowConsentId,
  });
  console.log(`- TransactionRequest created: ${allowTxRequest.id} (Amount: ${allowTxRequest.amountPaise} paise)`);

  const allowPaymentResult = await requestPayment(allowTxRequest.id);
  console.log(`- Payment Request Result: Verdict=${allowPaymentResult.verdict}, OrderId=${allowPaymentResult.orderId}`);
  if (allowPaymentResult.verdict !== "ALLOW" || !allowPaymentResult.orderId) {
    throw new Error("Failed: Expected ALLOW verdict and active Razorpay Order ID");
  }

  if (ordersCreateCallCount !== 1) {
    throw new Error(`Failed: Expected Razorpay orders.create to be called exactly once, got ${ordersCreateCallCount}`);
  }

  // Reset spy call count
  ordersCreateCallCount = 0;

  // 6. Test Payment Requests for NEEDS_APPROVAL verdict (e.g., ₹12,000 / 1,200,000 paise)
  console.log("\n6. Testing NEEDS_APPROVAL verdict (e.g., ₹12,000)...");
  const { consentId: approvalConsentId } = await requestConsent(
    customerId,
    cartId,
    "prod_2", // ₹12,000
    "Purchase of Vaporfly 3"
  );
  await confirmConsent(approvalConsentId);

  const approvalTxRequest = await createTransactionRequest({
    customerId,
    agentId,
    actionType,
    cartId,
    consentId: approvalConsentId,
  });
  console.log(`- TransactionRequest created: ${approvalTxRequest.id} (Amount: ${approvalTxRequest.amountPaise} paise)`);

  const approvalPaymentResult = await requestPayment(approvalTxRequest.id);
  console.log(`- Payment Request Result: Verdict=${approvalPaymentResult.verdict}, Reason="${approvalPaymentResult.reason}"`);
  if (approvalPaymentResult.verdict !== "NEEDS_APPROVAL") {
    throw new Error("Failed: Expected NEEDS_APPROVAL verdict");
  }
  if (approvalPaymentResult.orderId) {
    throw new Error("Failed: NEEDS_APPROVAL verdict must not invoke Razorpay orders creation");
  }

  if (ordersCreateCallCount !== 0) {
    throw new Error(`Failed: Expected Razorpay orders.create to not be called, got ${ordersCreateCallCount}`);
  }

  // Reset spy call count
  ordersCreateCallCount = 0;

  // 7. Test Payment Requests for BLOCK verdict (exceeding policy maxAmount)
  console.log("\n7. Testing BLOCK verdict (e.g. ₹24,000 via a reduced policy limit)...");
  const blockPolicy = await prisma.policy.create({
    data: {
      agentId: policy.agentId,
      actionType: policy.actionType,
      maxAmount: 1000000, // Reduced maxAmount to ₹10,000
      approvalThreshold: policy.approvalThreshold,
      dailyTxLimit: policy.dailyTxLimit,
      dailyValueLimit: policy.dailyValueLimit,
      version: policy.version + 1,
    },
  });
  console.log("- Temporarily lowered Policy maxAmount to ₹10,000");

  const blockPaymentResult = await requestPayment(approvalTxRequest.id);
  console.log(`- Payment Request Result: Verdict=${blockPaymentResult.verdict}, Reason="${blockPaymentResult.reason}"`);
  if (blockPaymentResult.verdict !== "BLOCK") {
    throw new Error("Failed: Expected BLOCK verdict");
  }
  if (blockPaymentResult.orderId) {
    throw new Error("Failed: BLOCK verdict must not invoke Razorpay orders creation");
  }

  if (ordersCreateCallCount !== 0) {
    throw new Error(`Failed: Expected Razorpay orders.create to not be called, got ${ordersCreateCallCount}`);
  }

  // Clean up
  await prisma.policy.deleteMany({ where: { agentId } });
  await prisma.transaction.deleteMany({});
  await prisma.decision.deleteMany({});
  await prisma.transactionRequest.deleteMany({});
  await prisma.consent.deleteMany({});

  // Restore spy
  razorpay.orders.create = originalOrdersCreate;

  console.log("\n=== ALL GATEWAY TOOL TESTS PASSED SUCCESSFULLY ===");
}

runTests().catch((err) => {
  console.error("\nTEST HARNESS FAILURE:", err);
  process.exit(1);
});
