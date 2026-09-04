import "dotenv/config";
process.env.MOCK_LLM = "true";
process.env.PORT = "3016";
import { prisma } from "../../src/db.js";
import { auditLogRepository } from "../../src/audit-log.js";

async function main() {
  await import("../../src/index.js");
  console.log("=== STARTING AGENT CHAT API INTEGRATION TESTS ===");

  const serverUrl = "http://localhost:3016";

  // 1. Seed pristine state for the demo agent & policy
  console.log("1. Seeding agent and policy...");
  await prisma.agent.upsert({
    where: { id: "agent_revenue" },
    update: { permissions: { CREATE_ORDER: { enabled: true } } },
    create: { id: "agent_revenue", name: "GuardPay Revenue Agent", permissions: { CREATE_ORDER: { enabled: true } } },
  });

  await prisma.policy.upsert({
    where: { agentId_actionType_version: { agentId: "agent_revenue", actionType: "CREATE_ORDER", version: 1 } },
    update: { maxAmount: 2000000, approvalThreshold: 1000000, dailyTxLimit: 100, dailyValueLimit: 10000000, maxDiscountPercent: 15 },
    create: { agentId: "agent_revenue", actionType: "CREATE_ORDER", maxAmount: 2000000, approvalThreshold: 1000000, dailyTxLimit: 100, dailyValueLimit: 10000000, maxDiscountPercent: 15, version: 1 },
  });

  await prisma.campaign.upsert({
    where: { code: "SUMMER10" },
    update: { discountPercent: 10, isActive: true, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
    create: { code: "SUMMER10", discountPercent: 10, allowedProductIds: ["prod_1", "prod_2", "prod_3", "prod_4", "prod_5"], isActive: true, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  });

  await prisma.cartCampaign.upsert({
    where: { cartId: "cart_demo_user" },
    update: { campaignCode: "SUMMER10" },
    create: { cartId: "cart_demo_user", campaignCode: "SUMMER10" },
  });

  // 2. Test POST /api/agent/chat - Turn 1 (Discovery)
  console.log("\n2. Testing POST /api/agent/chat (Turn 1: Discovery)...");
  const turn1Res = await fetch(`${serverUrl}/api/agent/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Hi! I'm looking for daily road running shoes under ₹10,000 for customer cust_demo_1 in cart_demo_user.",
    }),
  });

  const turn1Data: any = await turn1Res.json();
  console.log(`- Status: ${turn1Res.status}, Session ID: ${turn1Data.sessionId}`);
  console.log(`- Agent Response: "${turn1Data.response.trim()}"`);
  assert(turn1Res.status === 200, "Turn 1 must return 200");
  assert(!!turn1Data.sessionId, "Must return a valid sessionId");
  assert(!!turn1Data.response, "Must return agent response text");
  const sessionId = turn1Data.sessionId;

  // 3. Test POST /api/agent/chat - Turn 2 (Accept Pegasus + Socks Upsell)
  console.log("\n3. Testing POST /api/agent/chat (Turn 2: Upsell & Request Consent)...");
  const turn2Res = await fetch(`${serverUrl}/api/agent/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      message: "The Pegasus 41 looks great! Please also add the recommended running socks to my cart and prepare my order.",
    }),
  });

  const turn2Data: any = await turn2Res.json();
  console.log(`- Status: ${turn2Res.status}`);
  console.log(`- Consent Required:`, turn2Data.consentRequired);
  assert(turn2Res.status === 200, "Turn 2 must return 200");
  assert(!!turn2Data.consentRequired, "Must return consentRequired object");
  assert(turn2Data.consentRequired.status === "PENDING", "Consent status must be PENDING");
  assert(turn2Data.governanceDecision === null, "Turn 2 must NOT execute payment or governance decision");
  const consentId = turn2Data.consentRequired.consentId;

  // 4a. Test Security: Reject consent confirm without sessionId or with mismatched consentId
  console.log(`\n4a. Testing security rejections on POST /api/agent/consent/confirm...`);
  const noSessionRes = await fetch(`${serverUrl}/api/agent/consent/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ consentId }),
  });
  assert(noSessionRes.status === 400, "Must reject consent confirmation without sessionId");

  const mismatchRes = await fetch(`${serverUrl}/api/agent/consent/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, consentId: "cmtn_unrelated_consent" }),
  });
  assert(mismatchRes.status === 400, "Must reject mismatched consentId for session");

  // 4b. Test POST /api/agent/consent/confirm - Legitimate Explicit UI Click
  console.log(`\n4b. Testing POST /api/agent/consent/confirm for Consent ID: ${consentId}...`);
  const confirmRes = await fetch(`${serverUrl}/api/agent/consent/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      consentId,
    }),
  });

  const confirmData: any = await confirmRes.json();
  console.log(`- Confirm Status: ${confirmRes.status}, Response:`, confirmData);
  assert(confirmRes.status === 200, "Consent confirm must return 200");
  assert(confirmData.status === "CONFIRMED", "Consent status must be CONFIRMED");

  // Verify DB status
  const dbConsent = await prisma.consent.findUnique({ where: { id: consentId } });
  assert(dbConsent?.status === "CONFIRMED", "Database record must be CONFIRMED");

  // 5. Test POST /api/agent/chat - Turn 3 (Execute Payment with Confirmed Consent)
  console.log("\n5. Testing POST /api/agent/chat (Turn 3: Execute Payment)...");
  const turn3Res = await fetch(`${serverUrl}/api/agent/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      message: `I have confirmed the consent on my screen (Consent ID: ${consentId}). Please execute my payment.`,
    }),
  });

  const turn3Data: any = await turn3Res.json();
  console.log(`- Status: ${turn3Res.status}`);
  console.log(`- Governance Decision:`, turn3Data.governanceDecision);
  assert(turn3Res.status === 200, "Turn 3 must return 200");
  assert(turn3Data.governanceDecision?.verdict === "ALLOW", "Verdict must be ALLOW");
  assert(!!turn3Data.governanceDecision?.orderId, "Must create Razorpay Order");

  // 6. Test POST /api/agent/reset-session
  console.log("\n6. Testing POST /api/agent/reset-session...");
  const resetRes = await fetch(`${serverUrl}/api/agent/reset-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  const resetData: any = await resetRes.json();
  assert(resetRes.status === 200, "Reset session must return 200");
  assert(resetData.sessionId !== sessionId, "Must return new session ID");

  // 7. Verify Hash Chain
  console.log("\n7. Verifying Cryptographic Audit Ledger Integrity...");
  const chainCheck = await auditLogRepository.verifyChain();
  assert(chainCheck.isValid === true, "Audit chain must be 100% valid");
  console.log(`- Chain Valid: true, Total Verified: ${chainCheck.totalVerified}`);

  console.log("\n=== ALL AGENT CHAT API INTEGRATION TESTS PASSED SUCCESSFULLY ===");
  process.exit(0);
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`\n✖ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Agent chat API test failed:", err);
  process.exit(1);
});
