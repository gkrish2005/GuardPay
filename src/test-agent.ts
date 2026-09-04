import "dotenv/config";
import { prisma, confirmConsent } from "./gateway.js";
import * as gateway from "./gateway.js";
import { startAgentChat, runAgentTurn, AgentContext } from "./agent.js";

async function runTestAgent() {
  console.log("=== STARTING REVENUE AGENT CONVERSATIONAL HARNESS ===");

  const customerId = "cust_test_456";
  const agentId = "agent_test_123";
  const actionType = "CREATE_ORDER";
  const cartId = `cart_agent_${Date.now()}`;

  const context: AgentContext = {
    customerId,
    agentId,
    actionType,
  };

  // 1. Seed Agent & Policy in the database
  console.log("\n1. Seeding agent and policy in database...");
  
  // Clean old test data
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

  // Upsert Agent
  await prisma.agent.upsert({
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

  // Create Policy
  await prisma.policy.create({
    data: {
      id: "policy_agent_123",
      agentId,
      actionType,
      maxAmount: 2000000, // ₹20,000
      approvalThreshold: 1000000, // ₹10,000
      dailyTxLimit: 10,
      dailyValueLimit: 10000000, // ₹100,000
    }
  });

  console.log("- Database seeded successfully (Agent & Policy rules active)");

  // 2. Check for GEMINI_API_KEY to decide between Real LLM or Simulated execution
  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey) {
    console.log("\n2. GEMINI_API_KEY detected. Starting Real LLM Conversation...");
    try {
      const chat = startAgentChat();

      // Turn 1: Customer states intent
      const turn1Msg = "Hey! I am looking for some high-cushion running shoes.";
      console.log(`\n[CUSTOMER]: ${turn1Msg}`);
      
      const turn1Reply = await runAgentTurn(chat, turn1Msg, context);
      console.log(`[AGENT]: ${turn1Reply}`);

      // Turn 2: Customer agrees to purchase shoe and upsell
      const turn2Msg = "Awesome, let's go ahead and buy them!";
      console.log(`\n[CUSTOMER]: ${turn2Msg}`);

      // Callback to simulate out-of-band customer confirmation
      const onConsentRequested = async (consentId: string) => {
        console.log(`\n[SYSTEM UI]: Seeding pending consent ID: ${consentId}`);
        console.log("[SIMULATION]: Customer clicks the 'Confirm purchase of ₹7,300' button in their browser...");
        await confirmConsent(consentId);
        console.log("[SYSTEM UI]: Consent status updated to CONFIRMED in DB.\n");
      };

      const turn2Reply = await runAgentTurn(chat, turn2Msg, context, onConsentRequested);
      console.log(`[AGENT]: ${turn2Reply}`);

      // Turn 3: Customer agrees to add socks and check out
      const turn3Msg = "Yes, please add the socks and let's proceed with the purchase.";
      console.log(`\n[CUSTOMER]: ${turn3Msg}`);
      const turn3Reply = await runAgentTurn(chat, turn3Msg, context, onConsentRequested);
      console.log(`[AGENT]: ${turn3Reply}`);

      // Turn 4: Customer confirms consent signed and asks to proceed
      const turn4Msg = "I have confirmed the consent on my screen. Please proceed with the payment.";
      console.log(`\n[CUSTOMER]: ${turn4Msg}`);
      const turn4Reply = await runAgentTurn(chat, turn4Msg, context, onConsentRequested);
      console.log(`[AGENT]: ${turn4Reply}`);

    } catch (err: any) {
      console.error("Real LLM execution failed:", err.message || err);
      process.exit(1);
    }
  } else {
    console.log("\n2. [WARNING]: GEMINI_API_KEY is not defined in your environment.");
    console.log("Starting Simulated Conversational Agent Loop to verify the Tool Gateway & Governance flow...");

    // Simulate flow programmatically using the same gateway handlers
    const handlers = {
      searchProducts: (query: string) => {
        console.log(`[AGENT TOOL CALL] Executing function "searchProducts" with args: {"query":"${query}"}`);
        const res = gateway.searchProducts(query);
        console.log(`[AGENT TOOL RESPONSE] "searchProducts" output:`, JSON.stringify(res));
        return res;
      },
      proposeUpsell: (cartId: string) => {
        console.log(`[AGENT TOOL CALL] Executing function "proposeUpsell" with args: {"cartId":"${cartId}"}`);
        const res = gateway.proposeUpsell(cartId);
        console.log(`[AGENT TOOL RESPONSE] "proposeUpsell" output:`, JSON.stringify(res));
        return res;
      },
      requestConsent: async (cartId: string, productId: string, description: string) => {
        console.log(`[AGENT TOOL CALL] Executing function "requestConsent" with args: {"cartId":"${cartId}","productId":"${productId}","description":"${description}"}`);
        const res = await gateway.requestConsent(customerId, cartId, productId, description);
        console.log(`[AGENT TOOL RESPONSE] "requestConsent" output:`, JSON.stringify(res));
        return res;
      },
      createTransactionRequest: async (cartId: string, consentId: string) => {
        console.log(`[AGENT TOOL CALL] Executing function "createTransactionRequest" with args: {"cartId":"${cartId}","consentId":"${consentId}"}`);
        const res = await gateway.createTransactionRequest({
          customerId,
          agentId,
          actionType,
          cartId,
          consentId,
        });
        console.log(`[AGENT TOOL RESPONSE] "createTransactionRequest" output:`, JSON.stringify(res));
        return res;
      },
      requestPayment: async (transactionRequestId: string) => {
        console.log(`[AGENT TOOL CALL] Executing function "requestPayment" with args: {"transactionRequestId":"${transactionRequestId}"}`);
        const res = await gateway.requestPayment(transactionRequestId);
        console.log(`[AGENT TOOL RESPONSE] "requestPayment" output:`, JSON.stringify(res));
        return res;
      }
    };

    // Dialogue Simulation
    console.log("\n[CUSTOMER]: Hey! I am looking for some high-cushion running shoes.");
    
    // Agent Tooling
    const products = handlers.searchProducts("high-cushion");
    const mainProduct = products[0]; // prod_4 (InfinityRN 4)
    console.log(`[AGENT]: I found the ${mainProduct.name} which is excellent for high-cushion support.`);

    const upsell = handlers.proposeUpsell(cartId);
    console.log(`[AGENT]: I also recommend adding ${upsell.product.name} to complete your setup. Would you like to proceed with the purchase?`);

    console.log("\n[CUSTOMER]: Awesome, let's go ahead and buy them!");

    // requestConsent (initially seeds PENDING consent in DB)
    const consentRes = await handlers.requestConsent(cartId, mainProduct.id, `Purchase of ${mainProduct.name} and ${upsell.product.name}`);
    const consentId = consentRes.consentId;

    console.log(`\n[AGENT]: Perfect. I have generated a consent request. Please confirm the payment on your screen.`);
    
    // Out-of-band UI confirmation simulation
    console.log(`\n[SYSTEM UI]: Seeding pending consent ID: ${consentId}`);
    console.log("[SIMULATION]: Customer clicks the 'Confirm purchase of ₹7,300' button in their browser...");
    await confirmConsent(consentId);
    console.log("[SYSTEM UI]: Consent status updated to CONFIRMED in DB.\n");

    // Agent proceeds to request payment
    console.log(`[AGENT]: Thank you. Consent has been confirmed. I am now creating the transaction request.`);
    const txReq = await handlers.createTransactionRequest(cartId, consentId);
    
    const paymentRes = await handlers.requestPayment(txReq.id);
    console.log(`[AGENT]: Payment request completed. Status is ${paymentRes.verdict}. ${paymentRes.verdict === "ALLOW" ? `Order ID: ${paymentRes.orderId}` : ""}`);
  }

  // 3. Confirm Database State
  console.log("\n3. Verifying Final Database Records...");
  const decisions = await prisma.decision.findMany({
    orderBy: { decidedAt: "desc" },
    take: 1,
  });
  console.log("Last Decision Verdict:", decisions[0]?.verdict, "(Expected: ALLOW)");
  console.log("Last Decision Reason:", decisions[0]?.reason);

  const transactions = await prisma.transaction.findMany({
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  console.log("Last Transaction Status:", transactions[0]?.status, "(Expected: CREATED)");
  console.log("Last Transaction Order ID:", transactions[0]?.razorpayOrderId);

  const auditLogs = await prisma.auditLog.findMany({
    where: {
      transactionRequestId: transactions[0]?.transactionRequestId,
    },
    orderBy: { timestamp: "desc" },
  });
  console.log("Recent Audit Logs for this Transaction Request:");
  auditLogs.forEach(log => {
    console.log(`- Event: ${log.event}, Actor: ${log.actor}`);
  });

  console.log("\n=== CONVERSATIONAL HARNESS RUN COMPLETED SUCCESSFULLY ===");
}

runTestAgent().catch((err) => {
  console.error("Test Harness failed:", err);
  process.exit(1);
});
