import { prisma } from "../src/db.js";
import { writeAuditLog } from "../src/audit-log.js";

export async function resetAndSeedDemoDatabase() {
  console.log("================================================================================");
  console.log("                  GUARDPAY DEMO DATABASE RESET & SEEDING                        ");
  console.log("================================================================================");

  // 1. Full atomic wipe across all 11 tables in the schema
  console.log("1. Performing full atomic wipe across all 11 database tables...");
  await prisma.transaction.deleteMany({});
  await prisma.decision.deleteMany({});
  await prisma.approval.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.transactionRequest.deleteMany({});
  await prisma.consent.deleteMany({});
  await prisma.cartCampaign.deleteMany({});
  await prisma.campaign.deleteMany({});
  await prisma.webhookEvent.deleteMany({});
  await prisma.policy.deleteMany({});
  await prisma.agent.deleteMany({});
  console.log("- All 11 database tables completely cleared.");

  // 2. Seed Primary Revenue Agent
  console.log("\n2. Seeding Revenue Agent...");
  const agent = await prisma.agent.create({
    data: {
      id: "agent_revenue",
      name: "GuardPay Revenue Agent",
      permissions: {
        CREATE_ORDER: { enabled: true },
      },
    },
  });
  console.log(`- Agent created: ID="${agent.id}", Name="${agent.name}"`);

  // 3. Seed Authoritative Policy Version 1
  console.log("\n3. Seeding Policy Version 1...");
  const policy = await prisma.policy.create({
    data: {
      agentId: agent.id,
      actionType: "CREATE_ORDER",
      maxAmount: 2000000,          // ₹20,000 hard ceiling
      approvalThreshold: 1000000,  // ₹10,000 auto-approval threshold (> ₹10k triggers NEEDS_APPROVAL)
      dailyTxLimit: 100,
      dailyValueLimit: 10000000,   // ₹100,000 daily spend cap
      maxDiscountPercent: 15,      // 15% maximum discount
      version: 1,
    },
  });
  console.log(`- Policy seeded:
    • Max Single Order Amount : ₹20,000 (2,000,000 paise)
    • Auto-Approval Threshold : ₹10,000 (1,000,000 paise) -> Orders > ₹10k escalate to NEEDS_APPROVAL
    • Daily Spend Cap         : ₹100,000 (10,000,000 paise)
    • Max Discount Allowed    : 15%
    • Policy Version          : 1`);

  // 4. Seed Master Campaign & Active Cart Binding
  console.log("\n4. Seeding Master Campaign Definition (SUMMER10) & Cart Binding...");
  const campaignExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days in future
  const campaign = await prisma.campaign.create({
    data: {
      code: "SUMMER10",
      discountPercent: 10,
      allowedProductIds: ["prod_1", "prod_2", "prod_3", "prod_4", "prod_5", "prod_6", "prod_7", "prod_8"],
      isActive: true,
      expiresAt: campaignExpiry,
    },
  });

  const cartCampaign = await prisma.cartCampaign.create({
    data: {
      cartId: "cart_demo_user",
      campaignCode: campaign.code,
    },
  });
  console.log(`- Campaign created: Code="${campaign.code}", Discount=${campaign.discountPercent}%, Active=${campaign.isActive}, Expires=${campaign.expiresAt.toISOString()}`);
  console.log(`- Cart bound: CartId="${cartCampaign.cartId}", Campaign="${cartCampaign.campaignCode}"`);

  // 5. Seed Genesis Audit Log Entry to Initialize Cryptographic Hash Chain
  console.log("\n5. Initializing Cryptographic Audit Chain with Genesis Block...");
  const genesisLog = await writeAuditLog({
    actor: "system",
    event: "SYSTEM_INITIALIZED",
    metadata: {
      environment: "production-demo",
      activeAgent: agent.id,
      policyVersion: policy.version,
      autoApprovalLimitPaise: policy.approvalThreshold,
      maxOrderLimitPaise: policy.maxAmount,
    },
  });
  console.log(`- Genesis Audit Log created: ID=${genesisLog.id}`);
  console.log(`  • Previous Hash : ${genesisLog.previousHash} (Genesis)`);
  console.log(`  • Event Hash    : ${genesisLog.eventHash}`);

  // 6. Post-Reset Database Table Counts Verification
  console.log("\n6. Verifying Post-Reset Database State & Table Counts...");
  const tableCounts = {
    agents: await prisma.agent.count(),
    policies: await prisma.policy.count(),
    campaigns: await prisma.campaign.count(),
    cartCampaigns: await prisma.cartCampaign.count(),
    auditLogs: await prisma.auditLog.count(),
    consents: await prisma.consent.count(),
    transactionRequests: await prisma.transactionRequest.count(),
    decisions: await prisma.decision.count(),
    approvals: await prisma.approval.count(),
    transactions: await prisma.transaction.count(),
    webhookEvents: await prisma.webhookEvent.count(),
  };

  console.table(tableCounts);

  console.log("\n================================================================================");
  console.log("          DEMO DATABASE RESET COMPLETE — PRISTINE AND READY FOR RECORDING       ");
  console.log("================================================================================");

  return { agent, policy, campaign, cartCampaign, genesisLog, tableCounts };
}

// Execute if run directly from CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  resetAndSeedDemoDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Database reset failed:", err);
      process.exit(1);
    });
}
