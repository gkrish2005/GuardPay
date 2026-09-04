import { prisma, razorpay, requestPayment, requestConsent, createTransactionRequest } from "../../src/gateway.js";

async function main() {
  console.log("=== STARTING CONCURRENCY & TOCTOU DAILY SPEND CAP TESTS ===");

  // 1. Clean up relevant tables
  console.log("1. Setting up database environment...");
  await prisma.transaction.deleteMany({});
  await prisma.decision.deleteMany({});
  await prisma.approval.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.transactionRequest.deleteMany({});
  await prisma.consent.deleteMany({});
  await prisma.policy.deleteMany({});
  await prisma.agent.deleteMany({});

  // 2. Seed Agent & Policy with strict Daily Cap of ₹15,000 (1,500,000 paise)
  const agent = await prisma.agent.create({
    data: {
      id: "agent_concurrency",
      name: "Concurrency Test Agent",
      permissions: {
        CREATE_ORDER: { enabled: true },
      },
    },
  });

  const policy = await prisma.policy.create({
    data: {
      agentId: agent.id,
      actionType: "CREATE_ORDER",
      maxAmount: 2000000, // ₹20,000
      approvalThreshold: 1000000, // ₹10,000
      dailyTxLimit: 100,
      dailyValueLimit: 1500000, // ₹15,000 DAILY CAP
      maxDiscountPercent: 15,
      version: 1,
    },
  });

  console.log(`- Policy created: Daily Cap = ₹15,000, Max Single Order = ₹20,000, Approval Threshold = ₹10,000`);

  // Stub Razorpay orders.create
  let orderCounter = 1;
  razorpay.orders.create = (async (params: any) => {
    return {
      id: `order_conc_${orderCounter++}`,
      amount: params.amount,
      currency: params.currency,
      status: "created",
    };
  }) as any;

  // 3. Prepare two ₹8,000 requests (800,000 paise each)
  // Individually each is below ₹10,000 threshold and ₹20,000 max.
  // Combined (₹16,000) they exceed the ₹15,000 daily cap.
  console.log("\n2. Creating two ₹8,000 transaction requests...");
  const cart1 = {
    items: [{ productId: "prod_3", name: "Pegasus 41 Running Shoes", price: 8000, qty: 1 }],
  };
  const cart2 = {
    items: [{ productId: "prod_3", name: "Pegasus 41 Running Shoes", price: 8000, qty: 1 }],
  };

  const consent1 = await requestConsent("cust_c1", "cart_c1", "prod_3", "Pegasus 41 Running Shoes");
  await prisma.consent.update({ where: { id: consent1.consentId }, data: { status: "CONFIRMED" } });
  const req1 = await createTransactionRequest({
    customerId: "cust_c1",
    agentId: agent.id,
    actionType: "CREATE_ORDER",
    cartId: "cart_c1",
    consentId: consent1.consentId,
  });

  const consent2 = await requestConsent("cust_c2", "cart_c2", "prod_3", "Pegasus 41 Running Shoes");
  await prisma.consent.update({ where: { id: consent2.consentId }, data: { status: "CONFIRMED" } });
  const req2 = await createTransactionRequest({
    customerId: "cust_c2",
    agentId: agent.id,
    actionType: "CREATE_ORDER",
    cartId: "cart_c2",
    consentId: consent2.consentId,
  });

  // 4. Fire both requests simultaneously
  console.log("\n3. Firing 2 concurrent requestPayment() calls simultaneously...");
  const [res1, res2] = await Promise.all([
    requestPayment(req1.id),
    requestPayment(req2.id),
  ]);

  console.log(`- Request 1 Result: Verdict=${res1.verdict}, Reason="${res1.reason}"`);
  console.log(`- Request 2 Result: Verdict=${res2.verdict}, Reason="${res2.reason}"`);

  const verdicts = [res1.verdict, res2.verdict];
  const allowCount = verdicts.filter((v) => v === "ALLOW").length;
  const blockCount = verdicts.filter((v) => v === "BLOCK").length;

  assert(allowCount === 1, `Expected exactly 1 ALLOW under concurrency, got: ${allowCount}`);
  assert(blockCount === 1, `Expected exactly 1 BLOCK under concurrency, got: ${blockCount}`);

  const blockedRes = res1.verdict === "BLOCK" ? res1 : res2;
  assert(
    blockedRes.reason === "Daily value cap exceeded",
    `Expected BLOCK reason "Daily value cap exceeded", got "${blockedRes.reason}"`
  );
  console.log("- Passed: 2-way simultaneous race condition prevented. Exactly one request allowed, one blocked on daily cap.");

  // 5. 5-way Simultaneous Burst Test
  // Reset daily cap to ₹20,000 (2,000,000 paise), fire 5 simultaneous requests of ₹8,000 each
  console.log("\n4. Running 5-way simultaneous burst test (5 x Pegasus 41 at ₹8,000 vs ₹20,000 cap)...");
  await prisma.policy.update({
    where: { id: policy.id },
    data: { dailyValueLimit: 2000000 }, // ₹20,000 cap (exactly 2 x ₹8,000 will fit)
  });
  // Clear decisions/transactions from previous test to reset daily sum
  await prisma.transaction.deleteMany({});
  await prisma.decision.deleteMany({});

  const burstReqs = [];
  for (let i = 1; i <= 5; i++) {
    const c = await requestConsent(`cust_burst_${i}`, `cart_burst_${i}`, "prod_3", "Pegasus 41");
    await prisma.consent.update({ where: { id: c.consentId }, data: { status: "CONFIRMED" } });
    const req = await createTransactionRequest({
      customerId: `cust_burst_${i}`,
      agentId: agent.id,
      actionType: "CREATE_ORDER",
      cartId: `cart_burst_${i}`,
      consentId: c.consentId,
    });
    burstReqs.push(req);
  }

  const burstResults = await Promise.all(burstReqs.map((r) => requestPayment(r.id)));
  const burstAllows = burstResults.filter((r) => r.verdict === "ALLOW").length;
  const burstBlocks = burstResults.filter((r) => r.verdict === "BLOCK").length;

  console.log(`- 5-Way Burst Outcomes: ${burstAllows} ALLOWs, ${burstBlocks} BLOCKs`);
  burstResults.forEach((r, idx) => {
    console.log(`  [Req ${idx + 1}] Verdict=${r.verdict}, Reason="${r.reason}"`);
  });

  assert(burstAllows === 2, `Expected exactly 2 ALLOWs (2 x ₹4,000 = ₹8,000 <= ₹10,000), got: ${burstAllows}`);
  assert(burstBlocks === 3, `Expected exactly 3 BLOCKs, got: ${burstBlocks}`);

  console.log("- Passed: 5-way burst serialized perfectly. Total allowed spend = ₹8,000 <= ₹10,000 cap.");

  console.log("\n=== ALL CONCURRENCY & TOCTOU TESTS PASSED SUCCESSFULLY ===");
  process.exit(0);
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`Assertion failed: ${message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Concurrency test failed:", err);
  process.exit(1);
});
