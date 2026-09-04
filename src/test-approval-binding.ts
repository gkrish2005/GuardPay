import "dotenv/config";
import { prisma, razorpay, requestPayment } from "./gateway.js";

// 1. Setup in-process spy on razorpay.orders.create
let ordersCreateCallCount = 0;
const originalOrdersCreate = razorpay.orders.create.bind(razorpay.orders);
razorpay.orders.create = async function (params: any) {
  ordersCreateCallCount++;
  // Call original mock/real orders API
  return await originalOrdersCreate(params);
};

// 2. Launch Express server in-process on a custom test port
process.env.PORT = "3005";
console.log("[TEST INITIALIZATION] Starting in-process test server on port 3005...");
import "./index.js";

async function main() {
  console.log("=== STARTING APPROVAL SNAPSHOT BINDING & EXPIRATION TESTS ===");

  const customerId = "cust_approve_test";
  const agentId = "agent_test_123";
  const actionType = "CREATE_ORDER";

  // Setup policy: maxAmount = ₹20,000, approvalThreshold = ₹10,000
  console.log("\n1. Configuring test agent and policy rules...");
  await prisma.agent.upsert({
    where: { id: agentId },
    update: { permissions: { CREATE_ORDER: { enabled: true } } },
    create: { id: agentId, name: "Approval Test Agent", permissions: { CREATE_ORDER: { enabled: true } } }
  });

  await prisma.policy.deleteMany({ where: { agentId } });
  await prisma.policy.create({
    data: {
      agentId,
      actionType,
      maxAmount: 2000000,
      approvalThreshold: 1000000,
      dailyTxLimit: 10,
      dailyValueLimit: 10000000,
      maxDiscountPercent: 50,
      version: 1
    }
  });

  // Helper to seed a valid consent and NEEDS_APPROVAL transaction request
  async function seedApprovalRequest(amountPaise: number, items: any[]): Promise<{ txRequestId: string; consentId: string }> {
    const cartId = `cart_approve_${Date.now()}`;
    const consent = await prisma.consent.create({
      data: {
        customerId,
        cartId,
        productSnapshot: { items },
        cartHash: "dummy_cart_hash",
        amountPaise,
        status: "CONFIRMED",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000)
      }
    });

    const txRequest = await prisma.transactionRequest.create({
      data: {
        agentId,
        customerId,
        actionType,
        amountPaise,
        cartSnapshot: { items },
        consentId: consent.id
      }
    });

    // Run gateway requestPayment (evaluates governance, creates Decision and Approval)
    await requestPayment(txRequest.id);

    return { txRequestId: txRequest.id, consentId: consent.id };
  }

  // Helper to trigger merchant approval endpoint on test port 3005
  async function approveRequest(txRequestId: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`http://localhost:3005/api/approvals/${txRequestId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    const status = res.status;
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status, body };
  }

  // ----------------------------------------------------
  // Test Case 1: Snapshot Tampering Rejection
  // ----------------------------------------------------
  console.log("\n[TEST CASE 1] Running Snapshot Tampering Rejection Test...");
  ordersCreateCallCount = 0;

  // Seed ₹12,000 request (exceeds ₹10,000 threshold -> NEEDS_APPROVAL)
  const items1 = [{ productId: "prod_2", name: "Premium Racing Shoe", price: 12000, qty: 1 }];
  const { txRequestId: txReqId1, consentId: consentId1 } = await seedApprovalRequest(1200000, items1);

  // Verify Approval record created
  const approval1 = await prisma.approval.findUnique({
    where: { transactionRequestId: txReqId1 }
  });
  assert(approval1 !== null, "Approval record should be created in DB");
  assert(approval1?.status === "PENDING", "Approval record should initially be PENDING");

  // Mutate database cartSnapshot directly to simulate mid-flight tampering
  console.log("- Directly modifying cartSnapshot in DB to simulate tampering...");
  await prisma.transactionRequest.update({
    where: { id: txReqId1 },
    data: {
      cartSnapshot: {
        items: [{ productId: "prod_2", name: "Premium Racing Shoe", price: 50, qty: 1 }] // mutated price to ₹50
      }
    }
  });

  // Attempt approval
  const resApp1 = await approveRequest(txReqId1);
  console.log(`- Response: ${resApp1.status} (Body: ${JSON.stringify(resApp1.body)})`);
  assert(resApp1.status === 400, "Should be rejected with 400 Bad Request");
  assert(resApp1.body?.error?.includes("Approval hash mismatch"), "Error message should report hash mismatch");

  // Verify DB state
  const approvalAfter1 = await prisma.approval.findUnique({
    where: { transactionRequestId: txReqId1 }
  });
  assert(approvalAfter1?.status === "REJECTED", "Approval status must be transitioned to REJECTED");

  // Assert no Razorpay order or Transaction was created (spy count assertion)
  assert(ordersCreateCallCount === 0, "No Razorpay orders must be created on hash mismatch");
  const txCount1 = await prisma.transaction.count({
    where: { transactionRequestId: txReqId1 }
  });
  assert(txCount1 === 0, "No Transaction record should be created on hash mismatch");
  console.log("- Passed: Snapshot tampering rejected successfully.");

  // ----------------------------------------------------
  // Test Case 2: Expiration Rejection
  // ----------------------------------------------------
  console.log("\n[TEST CASE 2] Running Expiration Rejection Test...");
  ordersCreateCallCount = 0;

  const items2 = [{ productId: "prod_2", name: "Premium Racing Shoe", price: 12000, qty: 1 }];
  const { txRequestId: txReqId2, consentId: consentId2 } = await seedApprovalRequest(1200000, items2);

  // Directly mutate Approval.expiresAt in database to a past date
  console.log("- Mutating Approval expiresAt to past date...");
  await prisma.approval.update({
    where: { transactionRequestId: txReqId2 },
    data: { expiresAt: new Date(Date.now() - 5 * 60 * 1000) } // 5 minutes in the past
  });

  // Attempt approval
  const resApp2 = await approveRequest(txReqId2);
  console.log(`- Response: ${resApp2.status} (Body: ${JSON.stringify(resApp2.body)})`);
  assert(resApp2.status === 400, "Should be rejected with 400 Bad Request");
  assert(resApp2.body?.error?.includes("Approval has expired"), "Error message should report expired approval");

  // Verify DB state
  const approvalAfter2 = await prisma.approval.findUnique({
    where: { transactionRequestId: txReqId2 }
  });
  assert(approvalAfter2?.status === "EXPIRED", "Approval status must transition to EXPIRED");

  // Assert no order or Transaction was created (spy count assertion)
  assert(ordersCreateCallCount === 0, "No Razorpay orders must be created on expiration rejection");
  const txCount2 = await prisma.transaction.count({
    where: { transactionRequestId: txReqId2 }
  });
  assert(txCount2 === 0, "No Transaction record should be created on expiration rejection");
  console.log("- Passed: Expired approval rejected successfully.");

  // ----------------------------------------------------
  // Test Case 3: Re-execution Block
  // ----------------------------------------------------
  console.log("\n[TEST CASE 3] Running Re-execution Block Test...");
  ordersCreateCallCount = 0;

  const items3 = [{ productId: "prod_2", name: "Premium Racing Shoe", price: 12000, qty: 1 }];
  const { txRequestId: txReqId3, consentId: consentId3 } = await seedApprovalRequest(1200000, items3);

  // 1. Approve successfully the first time
  console.log("- Sending first approval request...");
  const resApp3_1 = await approveRequest(txReqId3);
  console.log(`- First approve status: ${resApp3_1.status}`);
  assert(resApp3_1.status === 200, "First approval should succeed");

  // Verify DB state
  const approvalAfter3_1 = await prisma.approval.findUnique({
    where: { transactionRequestId: txReqId3 }
  });
  assert(approvalAfter3_1?.status === "APPROVED", "Approval status should transition to APPROVED");
  assert(ordersCreateCallCount === 1, "Exactly 1 Razorpay order must be created");

  // Mutate cart snapshot in DB to simulate mid-flight tampering after approval
  console.log("- Mutating the cart snapshot in database after approval...");
  await prisma.transactionRequest.update({
    where: { id: txReqId3 },
    data: {
      cartSnapshot: {
        items: [{ productId: "prod_1", name: "Premium Racing Shoe", price: 10, qty: 1 }] // tampered price
      }
    }
  });

  // 2. Attempt approval again
  console.log("- Sending second approval request (re-execution)...");
  const resApp3_2 = await approveRequest(txReqId3);
  console.log(`- Second approve status: ${resApp3_2.status} (Body: ${JSON.stringify(resApp3_2.body)})`);
  assert(resApp3_2.status === 400, "Second approval should be rejected");
  assert(resApp3_2.body?.error?.includes("Approval has already been processed"), "Error should report already processed");

  // Verify DB state remains unchanged
  const approvalAfter3_2 = await prisma.approval.findUnique({
    where: { transactionRequestId: txReqId3 }
  });
  assert(approvalAfter3_2?.status === "APPROVED", "Approval status must remain APPROVED");
  assert(ordersCreateCallCount === 1, "No duplicate Razorpay orders should be created");
  console.log("- Passed: Re-execution rejected successfully.");

  // Clean up
  await prisma.transaction.deleteMany({ where: { transactionRequestId: { in: [txReqId1, txReqId2, txReqId3] } } });
  await prisma.decision.deleteMany({ where: { transactionRequestId: { in: [txReqId1, txReqId2, txReqId3] } } });
  await prisma.approval.deleteMany({ where: { transactionRequestId: { in: [txReqId1, txReqId2, txReqId3] } } });
  await prisma.transactionRequest.deleteMany({ where: { id: { in: [txReqId1, txReqId2, txReqId3] } } });
  await prisma.consent.deleteMany({ where: { id: { in: [consentId1, consentId2, consentId3] } } });

  // Restore original Razorpay order creation function
  razorpay.orders.create = originalOrdersCreate;

  console.log("\n=== ALL APPROVAL SNAPSHOT BINDING & EXPIRATION TESTS PASSED ===");
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
