import "dotenv/config";
import { prisma, razorpay, requestPayment, requestConsent, confirmConsent, createTransactionRequest } from "../../src/gateway.js";

// 1. Setup in-process spy on razorpay.orders.create
let ordersCreateCallCount = 0;
const originalOrdersCreate = razorpay.orders.create.bind(razorpay.orders);
razorpay.orders.create = async function (params: any) {
  ordersCreateCallCount++;
  return await originalOrdersCreate(params);
};

async function main() {
  process.env.PORT = "3007";
  await import("../../src/index.js");
  console.log("=== STARTING DISCOUNT GOVERNANCE TESTS ===");

  const customerId = "cust_discount_test";
  const agentId = "agent_discount_123";
  const actionType = "CREATE_ORDER";

  // Cleanup old data
  console.log("1. Cleaning up database tables...");
  await prisma.campaign.deleteMany({});
  await prisma.cartCampaign.deleteMany({});
  await prisma.policy.deleteMany({ where: { agentId } });
  await prisma.agent.upsert({
    where: { id: agentId },
    update: { permissions: { CREATE_ORDER: { enabled: true } } },
    create: { id: agentId, name: "Discount Agent", permissions: { CREATE_ORDER: { enabled: true } } }
  });

  // Seed policy: maxAmount = ₹20,000, maxDiscountPercent = 15%
  await prisma.policy.create({
    data: {
      agentId,
      actionType,
      maxAmount: 2000000,
      approvalThreshold: 1000000,
      dailyTxLimit: 10,
      dailyValueLimit: 10000000,
      maxDiscountPercent: 15,
      version: 1
    }
  });

  // Seed Campaigns
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000);

  console.log("2. Seeding campaign configurations...");
  await prisma.campaign.create({
    data: { code: "SAVE10", discountPercent: 10, allowedProductIds: ["prod_1", "prod_5"], isActive: true, expiresAt: future }
  });
  await prisma.campaign.create({
    data: { code: "SAVE80", discountPercent: 80, allowedProductIds: ["prod_1", "prod_5"], isActive: true, expiresAt: future }
  });
  await prisma.campaign.create({
    data: { code: "EXPIRED10", discountPercent: 10, allowedProductIds: ["prod_1", "prod_5"], isActive: true, expiresAt: past }
  });
  await prisma.campaign.create({
    data: { code: "INACTIVE10", discountPercent: 10, allowedProductIds: ["prod_1", "prod_5"], isActive: false, expiresAt: future }
  });

  // Helper to post campaign binding
  async function applyCampaignToCart(cartId: string, campaignCode: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`http://localhost:3007/api/carts/${cartId}/campaign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ campaignCode })
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
  // Test Case 1: 10% Discount ALLOWs
  // ----------------------------------------------------
  console.log("\n[TEST CASE 1] Running 10% Discount ALLOWs Test...");
  ordersCreateCallCount = 0;
  const cartId1 = `cart_discount_c1_${Date.now()}`;

  const applyRes1 = await applyCampaignToCart(cartId1, "SAVE10");
  assert(applyRes1.status === 200, "Should apply SAVE10 campaign to cart successfully");

  const { consentId: cId1 } = await requestConsent(customerId, cartId1, "prod_5", "Purchase of upsell socks");
  const consentRecord1 = await prisma.consent.findUnique({ where: { id: cId1 } });
  assert(consentRecord1?.amountPaise === 72000, `Expected amount to be 72,000 paise (got ${consentRecord1?.amountPaise})`);
  assert(consentRecord1?.campaignCode === "SAVE10", "Consent should record applied campaign code");

  await confirmConsent(cId1);
  const txReq1 = await createTransactionRequest({ customerId, agentId, actionType, cartId: cartId1, consentId: cId1 });
  const paymentRes1 = await requestPayment(txReq1.id);
  console.log(`- Result: Verdict=${paymentRes1.verdict}, Reason="${paymentRes1.reason}"`);
  assert(paymentRes1.verdict === "ALLOW", "Should ALLOW 10% discount request");
  assert(ordersCreateCallCount === 1, "Exactly 1 Razorpay order must be created");

  // ----------------------------------------------------
  // Test Case 2: 80% Discount BLOCKs
  // ----------------------------------------------------
  console.log("\n[TEST CASE 2] Running 80% Discount BLOCKs Test...");
  ordersCreateCallCount = 0;
  const cartId2 = `cart_discount_c2_${Date.now()}`;

  const applyRes2 = await applyCampaignToCart(cartId2, "SAVE80");
  assert(applyRes2.status === 200, "Should apply SAVE80 campaign to cart successfully");

  const { consentId: cId2 } = await requestConsent(customerId, cartId2, "prod_5", "Purchase of upsell socks");
  const consentRecord2 = await prisma.consent.findUnique({ where: { id: cId2 } });
  assert(consentRecord2?.amountPaise === 16000, `Expected amount to be 16,000 paise (got ${consentRecord2?.amountPaise})`);

  await confirmConsent(cId2);
  const txReq2 = await createTransactionRequest({ customerId, agentId, actionType, cartId: cartId2, consentId: cId2 });
  const paymentRes2 = await requestPayment(txReq2.id);
  console.log(`- Result: Verdict=${paymentRes2.verdict}, Reason="${paymentRes2.reason}"`);
  assert(paymentRes2.verdict === "BLOCK", "Should BLOCK 80% discount request");
  assert(paymentRes2.reason.includes("Discount percent exceeds policy limit"), "Blocked reason should report discount cap limit");
  assert(ordersCreateCallCount === 0, "No Razorpay orders must be created");

  // ----------------------------------------------------
  // Test Case 3: Ineligible Upsell Product Rejection
  // ----------------------------------------------------
  console.log("\n[TEST CASE 3] Running Ineligible Upsell Product Rejection Test...");
  ordersCreateCallCount = 0;
  const cartId3 = `cart_discount_c3_${Date.now()}`;

  const applyRes3 = await applyCampaignToCart(cartId3, "SAVE10");
  assert(applyRes3.status === 200, "Should apply SAVE10 campaign successfully");

  let test3Error: any = null;
  const consentCountBefore3 = await prisma.consent.count();
  try {
    await requestConsent(customerId, cartId3, "prod_2", "Purchase of racing shoe");
  } catch (err: any) {
    test3Error = err;
  }

  assert(test3Error !== null, "Should throw product ineligible error");
  assert(test3Error.message.includes("Product is not eligible for this campaign"), `Expected product eligibility message (got: "${test3Error.message}")`);
  
  const consentCountAfter3 = await prisma.consent.count();
  assert(consentCountBefore3 === consentCountAfter3, "No Consent row must be created in DB");
  assert(ordersCreateCallCount === 0, "No Razorpay orders must be created");
  console.log("- Passed: Ineligible product blocked successfully.");

  // ----------------------------------------------------
  // Test Case 4: Nonexistent Campaign Code Rejection
  // ----------------------------------------------------
  console.log("\n[TEST CASE 4] Running Nonexistent Campaign Code Rejection Test...");
  ordersCreateCallCount = 0;
  const cartId4 = `cart_discount_c4_${Date.now()}`;

  const consentCountBefore4 = await prisma.consent.count();
  const applyRes4 = await applyCampaignToCart(cartId4, "FAKECODE");
  console.log(`- Response: ${applyRes4.status} (Body: ${JSON.stringify(applyRes4.body)})`);
  assert(applyRes4.status === 400, "Applying invalid campaign must return 400");
  assert(applyRes4.body?.error?.includes("Campaign code not found"), "Error must state campaign code not found");

  const consentCountAfter4 = await prisma.consent.count();
  assert(consentCountBefore4 === consentCountAfter4, "No Consent row must be created in DB");
  assert(ordersCreateCallCount === 0, "No Razorpay orders must be created");
  console.log("- Passed: Nonexistent campaign code rejected successfully.");

  // ----------------------------------------------------
  // Test Case 5: Expired Campaign Rejection
  // ----------------------------------------------------
  console.log("\n[TEST CASE 5] Running Expired Campaign Rejection Test...");
  ordersCreateCallCount = 0;
  const cartId5 = `cart_discount_c5_${Date.now()}`;

  const consentCountBefore5 = await prisma.consent.count();
  const applyRes5 = await applyCampaignToCart(cartId5, "EXPIRED10");
  console.log(`- Response: ${applyRes5.status} (Body: ${JSON.stringify(applyRes5.body)})`);
  assert(applyRes5.status === 400, "Applying expired campaign must return 400");
  assert(applyRes5.body?.error?.includes("Campaign has expired or is inactive"), "Error must state campaign expired/inactive");

  const consentCountAfter5 = await prisma.consent.count();
  assert(consentCountBefore5 === consentCountAfter5, "No Consent row must be created in DB");
  assert(ordersCreateCallCount === 0, "No Razorpay orders must be created");
  console.log("- Passed: Expired campaign rejected successfully.");

  // ----------------------------------------------------
  // Test Case 6: Inactive Campaign Rejection
  // ----------------------------------------------------
  console.log("\n[TEST CASE 6] Running Inactive Campaign Rejection Test...");
  ordersCreateCallCount = 0;
  const cartId6 = `cart_discount_c6_${Date.now()}`;

  const consentCountBefore6 = await prisma.consent.count();
  const applyRes6 = await applyCampaignToCart(cartId6, "INACTIVE10");
  console.log(`- Response: ${applyRes6.status} (Body: ${JSON.stringify(applyRes6.body)})`);
  assert(applyRes6.status === 400, "Applying inactive campaign must return 400");
  assert(applyRes6.body?.error?.includes("Campaign has expired or is inactive"), "Error must state campaign expired/inactive");

  const consentCountAfter6 = await prisma.consent.count();
  assert(consentCountBefore6 === consentCountAfter6, "No Consent row must be created in DB");
  assert(ordersCreateCallCount === 0, "No Razorpay orders must be created");
  console.log("- Passed: Inactive campaign rejected successfully.");

  // Clean up
  console.log("\nCleaning up database entries...");
  await prisma.campaign.deleteMany({});
  await prisma.cartCampaign.deleteMany({});
  await prisma.policy.deleteMany({ where: { agentId } });
  await prisma.consent.deleteMany({ where: { customerId } });
  await prisma.transactionRequest.deleteMany({ where: { customerId } });

  razorpay.orders.create = originalOrdersCreate;

  console.log("\n=== ALL DISCOUNT GOVERNANCE TESTS PASSED SUCCESSFULLY ===");
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
