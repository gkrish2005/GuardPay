import { prisma } from "../../src/gateway.js";
import { canTransition, transitionTransaction } from "../../src/state-machine.js";

async function runTests() {
  console.log("=== STARTING PAYMENT STATE MACHINE UNIT TESTS ===");

  // ----------------------------------------------------
  // Part 1: canTransition() Pure Logic Assertions
  // ----------------------------------------------------
  console.log("\n1. Testing canTransition() pure logic rules...");

  // Valid sequential transitions
  assert(canTransition("CREATED", "CHECKOUT_OPENED"), "CREATED -> CHECKOUT_OPENED should be allowed");
  assert(canTransition("CHECKOUT_OPENED", "AUTHORIZED"), "CHECKOUT_OPENED -> AUTHORIZED should be allowed");
  assert(canTransition("AUTHORIZED", "CAPTURED"), "AUTHORIZED -> CAPTURED should be allowed");

  // Valid skip-ahead transitions (webhook races)
  assert(canTransition("CREATED", "CAPTURED"), "CREATED -> CAPTURED skip-ahead should be allowed");
  assert(canTransition("CREATED", "AUTHORIZED"), "CREATED -> AUTHORIZED skip-ahead should be allowed");
  assert(canTransition("CHECKOUT_OPENED", "CAPTURED"), "CHECKOUT_OPENED -> CAPTURED skip-ahead should be allowed");

  // Valid failed transitions
  assert(canTransition("CREATED", "FAILED"), "CREATED -> FAILED should be allowed");
  assert(canTransition("CHECKOUT_OPENED", "FAILED"), "CHECKOUT_OPENED -> FAILED should be allowed");
  assert(canTransition("AUTHORIZED", "FAILED"), "AUTHORIZED -> FAILED should be allowed");

  // Invalid backward transitions
  assert(!canTransition("AUTHORIZED", "CHECKOUT_OPENED"), "AUTHORIZED -> CHECKOUT_OPENED should be blocked");
  assert(!canTransition("CAPTURED", "AUTHORIZED"), "CAPTURED -> AUTHORIZED should be blocked");
  assert(!canTransition("CAPTURED", "CREATED"), "CAPTURED -> CREATED should be blocked");

  // Terminal state constraints
  assert(!canTransition("CAPTURED", "FAILED"), "CAPTURED -> FAILED should be blocked");
  assert(!canTransition("FAILED", "CAPTURED"), "FAILED -> CAPTURED should be blocked");

  // Invalid / unknown state strings
  assert(!canTransition("CREATED", "REFUNDED"), "CREATED -> REFUNDED (unknown state) should be blocked");
  assert(!canTransition("INVALID_STATE", "CREATED"), "INVALID_STATE -> CREATED should be blocked");

  // No-op / Replays
  assert(canTransition("CAPTURED", "CAPTURED"), "CAPTURED -> CAPTURED (replays) should be allowed (no-op)");
  assert(canTransition("FAILED", "FAILED"), "FAILED -> FAILED (replays) should be allowed (no-op)");

  console.log("- Passed: All canTransition() pure assertions succeeded.");

  // ----------------------------------------------------
  // Part 2: DB-level transitionTransaction() Assertions
  // ----------------------------------------------------
  console.log("\n2. Testing DB-level transitionTransaction() helper...");

  const txRequest = await prisma.transactionRequest.create({
    data: {
      agentId: "agent_state_test",
      customerId: "cust_state_test",
      actionType: "CREATE_ORDER",
      amountPaise: 1000,
      cartSnapshot: {}
    }
  });

  const transaction = await prisma.transaction.create({
    data: {
      transactionRequestId: txRequest.id,
      razorpayOrderId: `order_state_test_${Date.now()}`,
      status: "CREATED"
    }
  });

  console.log(`- Created test Transaction ID: ${transaction.id} in state: ${transaction.status}`);

  // Test transition to CHECKOUT_OPENED
  await prisma.$transaction(async (tx) => {
    const updated = await transitionTransaction(tx, transaction.id, "CHECKOUT_OPENED");
    assert(updated.status === "CHECKOUT_OPENED", "Transaction should transition to CHECKOUT_OPENED");
  });
  console.log("- Passed: CREATED -> CHECKOUT_OPENED succeeded in DB");

  // Test skip-ahead to CAPTURED
  await prisma.$transaction(async (tx) => {
    const updated = await transitionTransaction(tx, transaction.id, "CAPTURED", "pay_test_state_123");
    assert(updated.status === "CAPTURED", "Transaction should transition to CAPTURED");
    assert(updated.razorpayPaymentId === "pay_test_state_123", "Transaction paymentId should update");
  });
  console.log("- Passed: CHECKOUT_OPENED -> CAPTURED (skip-ahead) succeeded in DB");

  // Test backward transition rejection (should throw)
  let threw = false;
  try {
    await prisma.$transaction(async (tx) => {
      await transitionTransaction(tx, transaction.id, "AUTHORIZED");
    });
  } catch (error: any) {
    threw = true;
    assert(error.message.includes("Invalid state transition"), "Expected invalid transition error");
  }
  assert(threw, "Out-of-order transition from CAPTURED to AUTHORIZED should fail and throw");
  console.log("- Passed: CAPTURED -> AUTHORIZED backward transition correctly rejected");

  // Verify DB state remains CAPTURED
  const finalTx = await prisma.transaction.findUnique({
    where: { id: transaction.id }
  });
  assert(finalTx?.status === "CAPTURED", "DB status should remain CAPTURED");
  console.log("- Passed: DB transaction remains CAPTURED");

  // Clean up
  await prisma.transaction.delete({ where: { id: transaction.id } });
  await prisma.transactionRequest.delete({ where: { id: txRequest.id } });

  console.log("\n=== ALL PAYMENT STATE MACHINE UNIT TESTS PASSED ===");
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`Assertion failed: ${message}`);
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error("Test Harness failed:", err);
  process.exit(1);
});
