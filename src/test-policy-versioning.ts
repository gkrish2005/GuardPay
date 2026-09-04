import "dotenv/config";
import { prisma, requestPayment } from "./gateway.js";

// Launch Express server in-process on a custom test port
process.env.PORT = "3006";
console.log("[TEST INITIALIZATION] Starting in-process test server on port 3006...");
import "./index.js";

async function main() {
  console.log("=== STARTING POLICY VERSIONING TESTS ===");

  const customerId = "cust_version_test";
  const agentId = "agent_version_123";
  const actionType = "CREATE_ORDER";

  // Setup: Delete any existing policies for clean runs (avoid unique constraint conflicts)
  console.log("1. Cleaning up existing policy database entries and setting up Agent...");
  await prisma.policy.deleteMany({
    where: { agentId }
  });
  await prisma.agent.upsert({
    where: { id: agentId },
    update: { permissions: { CREATE_ORDER: { enabled: true } } },
    create: { id: agentId, name: "Versioning Test Agent", permissions: { CREATE_ORDER: { enabled: true } } }
  });

  // ----------------------------------------------------
  // Step 2: Seed Policy Version 1 (maxAmount = ₹20,000, approvalThreshold = ₹10,000)
  // ----------------------------------------------------
  console.log("\n2. Seeding Policy Version 1 (maxAmount = ₹20,000)...");
  const policyV1 = await prisma.policy.create({
    data: {
      agentId,
      actionType,
      maxAmount: 2000000,       // ₹20,000
      approvalThreshold: 1000000, // ₹10,000
      dailyTxLimit: 10,
      dailyValueLimit: 10000000,
      version: 1
    }
  });
  console.log(`- Policy Version 1 created: ID=${policyV1.id}, Version=${policyV1.version}`);

  // ----------------------------------------------------
  // Step 3: Create and evaluate TransactionRequest 1 (₹12,000)
  // ----------------------------------------------------
  console.log("\n3. Evaluating Request 1 (₹12,000) against Policy Version 1...");
  const consent1 = await prisma.consent.create({
    data: {
      customerId,
      cartId: `cart_v1_${Date.now()}`,
      productSnapshot: { items: [{ name: "Running Shoes", price: 12000, qty: 1 }] },
      cartHash: "dummy_cart_hash_1",
      amountPaise: 1200000,
      status: "CONFIRMED",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000)
    }
  });

  const txRequest1 = await prisma.transactionRequest.create({
    data: {
      agentId,
      customerId,
      actionType,
      amountPaise: 1200000, // ₹12,000
      cartSnapshot: { items: [{ name: "Running Shoes", price: 12000, qty: 1 }] },
      consentId: consent1.id
    }
  });

  const res1 = await requestPayment(txRequest1.id);
  console.log(`- Result: Verdict=${res1.verdict}, Reason="${res1.reason}"`);
  assert(res1.verdict === "NEEDS_APPROVAL", "Should require approval (₹12k is above ₹10k auto-threshold but below ₹20k limit)");

  // Assert Decision is correctly bound to policy version 1
  const decision1 = await prisma.decision.findFirst({
    where: { transactionRequestId: txRequest1.id }
  });
  assert(decision1 !== null, "Decision 1 should exist");
  assert(decision1?.policyVersion === 1, `Decision 1 policyVersion should be 1 (got ${decision1?.policyVersion})`);
  assert((decision1?.signalsChecked as any)?.maxAmount === 2000000, "Decision 1 signals check must preserve ₹20k limit");

  // Fetch audit logs timeline API to verify Request 1
  const apiRes1 = await fetch("http://localhost:3006/api/audit-logs");
  assert(apiRes1.ok, "Audit log endpoint should return 200");
  const logs1 = await apiRes1.json() as any[];
  const logForReq1_firstRead = logs1.find((l: any) => l.transactionRequestId === txRequest1.id && l.event === "DECISION_NEEDS_APPROVAL");
  assert(logForReq1_firstRead !== undefined, "Audit log for request 1 should exist");
  assert(logForReq1_firstRead.metadata?.policyVersion === 1, "Request 1 log must initially render policyVersion 1");
  console.log("- Passed: Request 1 verified successfully under Version 1 rules.");

  // ----------------------------------------------------
  // Step 4: Seed Policy Version 2 (maxAmount = ₹10,000)
  // ----------------------------------------------------
  console.log("\n4. Seeding Policy Version 2 (maxAmount = ₹10,000, version = 2)...");
  const policyV2 = await prisma.policy.create({
    data: {
      agentId,
      actionType,
      maxAmount: 1000000,         // ₹10,000 (reduced limit)
      approvalThreshold: 500000,  // ₹5,000
      dailyTxLimit: 10,
      dailyValueLimit: 10000000,
      version: 2
    }
  });
  console.log(`- Policy Version 2 created: ID=${policyV2.id}, Version=${policyV2.version}`);

  // ----------------------------------------------------
  // Step 5: RETROACTIVE IMMUTABILITY CHECK
  // Fetch Request 1's decision and audit log a SECOND time after Version 2 has been created.
  // We must prove that Decision 1 and its Audit Log still explain themselves using Version 1 parameters.
  // ----------------------------------------------------
  console.log("\n5. [RETROACTIVE CHECK] Re-fetching Request 1 logs after Policy Version 2 creation...");
  const decision1_secondRead = await prisma.decision.findFirst({
    where: { transactionRequestId: txRequest1.id }
  });
  assert(decision1_secondRead?.policyVersion === 1, `Retroactive Check: Decision 1 policyVersion must remain 1 (got ${decision1_secondRead?.policyVersion})`);
  assert((decision1_secondRead?.signalsChecked as any)?.maxAmount === 2000000, "Retroactive Check: Decision 1 signals check must preserve original ₹20k limit");

  const apiRes1_secondRead = await fetch("http://localhost:3006/api/audit-logs");
  assert(apiRes1_secondRead.ok, "Audit log endpoint should return 200");
  const logs1_secondRead = await apiRes1_secondRead.json() as any[];
  const logForReq1_secondRead = logs1_secondRead.find((l: any) => l.transactionRequestId === txRequest1.id && l.event === "DECISION_NEEDS_APPROVAL");
  assert(logForReq1_secondRead.metadata?.policyVersion === 1, `Retroactive Check: Request 1 log metadata must still render policyVersion 1 (got ${logForReq1_secondRead.metadata?.policyVersion})`);
  assert(logForReq1_secondRead.metadata?.policyId === policyV1.id, "Retroactive Check: Request 1 log must still reference policy ID of Version 1");
  console.log("- Passed: Retroactive check confirmed. Historical log and decision values remain unmodified by policy update.");

  // ----------------------------------------------------
  // Step 6: Create and evaluate TransactionRequest 2 (₹12,000)
  // ----------------------------------------------------
  console.log("\n6. Evaluating Request 2 (₹12,000) against Policy Version 2...");
  const consent2 = await prisma.consent.create({
    data: {
      customerId,
      cartId: `cart_v2_${Date.now()}`,
      productSnapshot: { items: [{ name: "Running Shoes", price: 12000, qty: 1 }] },
      cartHash: "dummy_cart_hash_2",
      amountPaise: 1200000,
      status: "CONFIRMED",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000)
    }
  });

  const txRequest2 = await prisma.transactionRequest.create({
    data: {
      agentId,
      customerId,
      actionType,
      amountPaise: 1200000, // ₹12,000
      cartSnapshot: { items: [{ name: "Running Shoes", price: 12000, qty: 1 }] },
      consentId: consent2.id
    }
  });

  const res2 = await requestPayment(txRequest2.id);
  console.log(`- Result: Verdict=${res2.verdict}, Reason="${res2.reason}"`);
  assert(res2.verdict === "BLOCK", "Should be blocked (₹12k exceeds new ₹10k max limit)");

  // Assert Decision 2 is correctly bound to policy version 2
  const decision2 = await prisma.decision.findFirst({
    where: { transactionRequestId: txRequest2.id }
  });
  assert(decision2 !== null, "Decision 2 should exist");
  assert(decision2?.policyVersion === 2, `Decision 2 policyVersion should be 2 (got ${decision2?.policyVersion})`);
  assert((decision2?.signalsChecked as any)?.maxAmount === 1000000, "Decision 2 signals check must reflect new ₹10k limit");

  // Fetch final audit logs
  const apiResFinal = await fetch("http://localhost:3006/api/audit-logs");
  assert(apiResFinal.ok, "Audit log endpoint should return 200");
  const logsFinal = await apiResFinal.json() as any[];
  const logForReq2 = logsFinal.find((l: any) => l.transactionRequestId === txRequest2.id && l.event === "DECISION_BLOCKED");

  assert(logForReq2 !== undefined, "Audit log for request 2 should exist");
  assert(logForReq2.metadata?.policyVersion === 2, `Request 2 log must statically render policyVersion 2 (got ${logForReq2.metadata?.policyVersion})`);
  console.log("- Passed: Request 2 verified successfully under Version 2 rules.");

  // Clean up
  console.log("\nCleaning up database records...");
  await prisma.decision.deleteMany({ where: { transactionRequestId: { in: [txRequest1.id, txRequest2.id] } } });
  await prisma.transactionRequest.deleteMany({ where: { id: { in: [txRequest1.id, txRequest2.id] } } });
  await prisma.policy.deleteMany({ where: { agentId } });
  await prisma.consent.deleteMany({ where: { id: { in: [consent1.id, consent2.id] } } });

  console.log("\n=== ALL POLICY VERSIONING TESTS PASSED SUCCESSFULLY ===");
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
