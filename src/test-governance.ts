import { prisma, razorpay, requestConsent, confirmConsent, createTransactionRequest, requestPayment } from "./gateway.js";

async function runGovernanceTests() {
  console.log("=== STARTING GOVERNANCE ENGINE UNIT TEST HARNESS ===");

  const customerId = "cust_gov_test";
  const agentId = "agent_test_123";
  const actionType = "CREATE_ORDER";
  const cartId = `cart_gov_${Date.now()}`;

  // Spy setup on razorpay.orders.create
  let ordersCreateCallCount = 0;
  const originalOrdersCreate = razorpay.orders.create.bind(razorpay.orders);
  razorpay.orders.create = async function (params: any) {
    ordersCreateCallCount++;
    return originalOrdersCreate(params);
  };

  // 0. Clean up old test data to ensure clean slate (especially for daily limit test)
  console.log("\n0. Cleaning up old test data...");
  const oldRequests = await prisma.transactionRequest.findMany({
    where: { agentId },
    select: { id: true }
  });
  const oldRequestIds = oldRequests.map(r => r.id);

  if (oldRequestIds.length > 0) {
    await prisma.transaction.deleteMany({
      where: { transactionRequestId: { in: oldRequestIds } }
    });
    await prisma.decision.deleteMany({
      where: { transactionRequestId: { in: oldRequestIds } }
    });
    await prisma.transactionRequest.deleteMany({
      where: { id: { in: oldRequestIds } }
    });
  }
  await prisma.policy.deleteMany({
    where: { agentId }
  });

  // 1. Seed/Update Agent
  console.log("\n1. Seeding agent permissions...");
  const agent = await prisma.agent.upsert({
    where: { id: agentId },
    update: {
      name: "Test Commerce Agent",
      permissions: {
        CREATE_ORDER: { enabled: true }
      }
    },
    create: {
      id: agentId,
      name: "Test Commerce Agent",
      permissions: {
        CREATE_ORDER: { enabled: true }
      }
    }
  });
  console.log(`Agent configured: id=${agent.id}, CREATE_ORDER enabled=true`);

  // 2. Seed/Update Policy
  console.log("\n2. Seeding policy rules...");
  const policy = await prisma.policy.create({
    data: {
      id: "policy_test_123",
      agentId,
      actionType,
      maxAmount: 2000000, // ₹20,000
      approvalThreshold: 1000000, // ₹10,000
      dailyTxLimit: 10,
      dailyValueLimit: 10000000, // ₹100,000
    }
  });
  console.log(`Policy configured: maxAmount=₹${policy.maxAmount/100}, approvalThreshold=₹${policy.approvalThreshold/100}, dailyValueLimit=₹${policy.dailyValueLimit/100}`);

  // Test Case A: within-limit -> ALLOW (e.g. ₹6,500)
  console.log("\nTest Case A: within-limit -> ALLOW (e.g. ₹6,500)...");
  ordersCreateCallCount = 0;
  const custA = "cust_gov_a";
  const { consentId: consentA } = await requestConsent(custA, cartId, "prod_4", "ALLOW test");
  await confirmConsent(consentA);
  const reqA = await createTransactionRequest({ customerId: custA, agentId, actionType, cartId, consentId: consentA });
  const resA = await requestPayment(reqA.id);
  console.log(`- Verdict: ${resA.verdict}, Reason: "${resA.reason}"`);
  if (resA.verdict !== "ALLOW" || ordersCreateCallCount !== 1) {
    throw new Error(`Failed Test Case A: Expected ALLOW and 1 Razorpay call, got ${resA.verdict} and ${ordersCreateCallCount} calls`);
  }
  console.log(`- Asserted: razorpay.orders.create invoked exactly ${ordersCreateCallCount} time`);

  // Test Case B: over absolute limit -> BLOCK (e.g. ₹25,000)
  console.log("\nTest Case B: over absolute limit -> BLOCK (e.g. ₹25,000)...");
  ordersCreateCallCount = 0;
  
  const custB = "cust_gov_b";
  // Seed a custom Consent and TransactionRequest to bypass catalog limit
  const customConsent = await prisma.consent.create({
    data: {
      customerId: custB,
      cartId,
      productSnapshot: { items: [{ productId: "prod_custom", name: "Custom Expensive Item", price: 25000, qty: 1 }] },
      cartHash: "hash_custom_b",
      amountPaise: 2500000, // ₹25,000
      status: "CONFIRMED",
    }
  });
  const reqB = await prisma.transactionRequest.create({
    data: {
      agentId,
      customerId: custB,
      actionType,
      amountPaise: 2500000,
      cartSnapshot: customConsent.productSnapshot as any,
      consentId: customConsent.id
    }
  });
  const resB = await requestPayment(reqB.id);
  console.log(`- Verdict: ${resB.verdict}, Reason: "${resB.reason}"`);
  if (resB.verdict !== "BLOCK" || ordersCreateCallCount !== 0) {
    throw new Error(`Failed Test Case B: Expected BLOCK and 0 Razorpay calls, got ${resB.verdict} and ${ordersCreateCallCount} calls`);
  }
  console.log(`- Asserted: razorpay.orders.create invoked exactly ${ordersCreateCallCount} times`);

  // Test Case C: missing consent -> BLOCK (e.g. ₹6,500)
  console.log("\nTest Case C: missing consent -> BLOCK (e.g. ₹6,500)...");
  ordersCreateCallCount = 0;
  const custC = "cust_gov_c";
  // Seed a transaction request directly without a consentId
  const reqC = await prisma.transactionRequest.create({
    data: {
      agentId,
      customerId: custC,
      actionType,
      amountPaise: 650000, // ₹6,500
      cartSnapshot: { items: [{ productId: "prod_4", name: "InfinityRN 4", price: 6500, qty: 1 }] },
      consentId: null // Missing Consent!
    }
  });
  const resC = await requestPayment(reqC.id);
  console.log(`- Verdict: ${resC.verdict}, Reason: "${resC.reason}"`);
  if (resC.verdict !== "BLOCK" || ordersCreateCallCount !== 0) {
    throw new Error(`Failed Test Case C: Expected BLOCK and 0 Razorpay calls, got ${resC.verdict} and ${ordersCreateCallCount} calls`);
  }
  console.log(`- Asserted: razorpay.orders.create invoked exactly ${ordersCreateCallCount} times`);

  // Test Case D: above approval threshold -> NEEDS_APPROVAL (e.g. ₹12,000)
  console.log("\nTest Case D: above approval threshold -> NEEDS_APPROVAL (e.g. ₹12,000)...");
  ordersCreateCallCount = 0;
  const custD = "cust_gov_d";
  const { consentId: consentD } = await requestConsent(custD, cartId, "prod_2", "NEEDS_APPROVAL test");
  await confirmConsent(consentD);
  const reqD = await createTransactionRequest({ customerId: custD, agentId, actionType, cartId, consentId: consentD });
  const resD = await requestPayment(reqD.id);
  console.log(`- Verdict: ${resD.verdict}, Reason: "${resD.reason}"`);
  if (resD.verdict !== "NEEDS_APPROVAL" || ordersCreateCallCount !== 0) {
    throw new Error(`Failed Test Case D: Expected NEEDS_APPROVAL and 0 Razorpay calls, got ${resD.verdict} and ${ordersCreateCallCount} calls`);
  }
  console.log(`- Asserted: razorpay.orders.create invoked exactly ${ordersCreateCallCount} times`);

  // Test Case E: agent permissions disabled -> BLOCK (e.g. ₹6,500)
  console.log("\nTest Case E: agent permissions disabled -> BLOCK (e.g. ₹6,500)...");
  ordersCreateCallCount = 0;
  
  // Disable CREATE_ORDER permission for this agent
  await prisma.agent.update({
    where: { id: agentId },
    data: {
      permissions: {
        CREATE_ORDER: { enabled: false }
      }
    }
  });

  const custE = "cust_gov_e";
  const { consentId: consentE } = await requestConsent(custE, cartId, "prod_4", "Agent disabled test");
  await confirmConsent(consentE);
  const reqE = await createTransactionRequest({ customerId: custE, agentId, actionType, cartId, consentId: consentE });
  const resE = await requestPayment(reqE.id);
  console.log(`- Verdict: ${resE.verdict}, Reason: "${resE.reason}"`);
  
  // Re-enable permission to keep DB clean
  await prisma.agent.update({
    where: { id: agentId },
    data: {
      permissions: {
        CREATE_ORDER: { enabled: true }
      }
    }
  });

  if (resE.verdict !== "BLOCK" || ordersCreateCallCount !== 0) {
    throw new Error(`Failed Test Case E: Expected BLOCK and 0 Razorpay calls, got ${resE.verdict} and ${ordersCreateCallCount} calls`);
  }
  console.log(`- Asserted: razorpay.orders.create invoked exactly ${ordersCreateCallCount} times`);

  // Test Case F: daily value cap exceeded -> BLOCK
  console.log("\nTest Case F: daily value cap exceeded -> BLOCK...");
  ordersCreateCallCount = 0;
  
  // Temporarily configure policy dailyValueLimit to ₹15,000 (1,500,000 paise) (write new version)
  const latestPolicyF = await prisma.policy.findFirst({
    where: { agentId, actionType },
    orderBy: { version: "desc" }
  });
  if (!latestPolicyF) throw new Error("Policy not found");

  const policyF2 = await prisma.policy.create({
    data: {
      agentId: latestPolicyF.agentId,
      actionType: latestPolicyF.actionType,
      maxAmount: latestPolicyF.maxAmount,
      approvalThreshold: latestPolicyF.approvalThreshold,
      dailyTxLimit: latestPolicyF.dailyTxLimit,
      dailyValueLimit: 1500000, // ₹15,000
      maxDiscountPercent: latestPolicyF.maxDiscountPercent,
      version: latestPolicyF.version + 1
    }
  });
  console.log("- Temporarily set policy daily value limit to ₹15,000");

  const custF = "cust_gov_f";
  // Request 1: ₹8,000 -> Should ALLOW (Daily total 0 + 8,000 = 8,000 <= 15,000)
  const { consentId: consentF1 } = await requestConsent(custF, cartId, "prod_3", "Daily limit test 1"); // ₹8,000
  await confirmConsent(consentF1);
  const reqF1 = await createTransactionRequest({ customerId: custF, agentId, actionType, cartId, consentId: consentF1 });
  const resF1 = await requestPayment(reqF1.id);
  console.log(`- Request 1 (₹8,000) Verdict: ${resF1.verdict}`);
  if (resF1.verdict !== "ALLOW") {
    throw new Error(`Failed Request 1: Expected ALLOW, got ${resF1.verdict}`);
  }

  // Request 2: ₹3,000 -> Should BLOCK (Daily total 8,000 + 3,000 = 11,000 > 10,000 limit) - wait, threshold is now ₹15,000. Wait! Actually we need to make it exceed ₹15,000.
  // Wait, ₹8,000 + ₹8,000 = ₹16,000 (which exceeds the ₹15,000 limit)!
  // So Request 2 should be ₹8,000 (800,000 paise). Let's keep it as ₹8,000! Wait, let's keep the customReqF2 amount as 800000 paise (₹8,000) so that 8,000 + 8,000 = 16,000 > 15,000.
  const { consentId: consentF2 } = await requestConsent(custF, cartId, "prod_7", "Daily limit test 2");
  await confirmConsent(consentF2);
  const reqF2 = await createTransactionRequest({ customerId: custF, agentId, actionType, cartId, consentId: consentF2 });
  
  // Custom seed to make it exactly ₹8,000 for limit test (exceeds ₹15,000 total)
  const customReqF2 = await prisma.transactionRequest.create({
    data: {
      agentId,
      customerId: custF,
      actionType,
      amountPaise: 800000, // ₹8,000 (exceeds limit: 8000 + 8000 = 16000 > 15000)
      cartSnapshot: reqF2.cartSnapshot as any,
      consentId: consentF2
    }
  });

  const resF2 = await requestPayment(customReqF2.id);
  console.log(`- Request 2 (₹8,000) Verdict: ${resF2.verdict}, Reason: "${resF2.reason}"`);
  
  // Restore Policy
  await prisma.policy.create({
    data: {
      agentId: latestPolicyF.agentId,
      actionType: latestPolicyF.actionType,
      maxAmount: latestPolicyF.maxAmount,
      approvalThreshold: latestPolicyF.approvalThreshold,
      dailyTxLimit: latestPolicyF.dailyTxLimit,
      dailyValueLimit: 10000000, // Restore back to ₹100,000
      maxDiscountPercent: latestPolicyF.maxDiscountPercent,
      version: policyF2.version + 1
    }
  });

  if (resF2.verdict !== "BLOCK" || ordersCreateCallCount !== 1) { // 1 call from Request 1, 0 from Request 2
    throw new Error(`Failed Test Case F: Expected BLOCK and 1 total Razorpay call, got ${resF2.verdict} and ${ordersCreateCallCount} total calls`);
  }
  console.log(`- Asserted: Request 2 blocked correctly and did not invoke razorpay.orders.create`);

  console.log("\n=== ALL GOVERNANCE ENGINE TESTS PASSED SUCCESSFULLY ===");
}

runGovernanceTests().catch((err) => {
  console.error("\nTEST HARNESS FAILURE:", err);
  process.exit(1);
});
