import { runAgentTurn, AgentContext } from "../../src/agent.js";
import { prisma } from "../../src/db.js";
import { computeCartHash, createTransactionRequest } from "../../src/gateway.js";

async function main() {
  console.log("=== STARTING CONSENT GATING & HARD SESSION BOUNDARY TESTS ===");

  const context: AgentContext = {
    customerId: "cust_gate_test",
    agentId: "agent_revenue",
    actionType: "CREATE_ORDER",
  };

  // Seed agent and policy
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

  // -------------------------------------------------------------------------
  // TEST 1: runAgentTurn MUST halt immediately after requestConsent
  // -------------------------------------------------------------------------
  console.log("\n1. Testing that runAgentTurn halts immediately after requestConsent...");

  let toolExecutedNames: string[] = [];
  let capturedConsentId: string | null = null;

  // Mock chat session that returns requestConsent, then attempts to follow up with createTransactionRequest in the same turn
  const mockChatChainedAttempt = {
    sendMessage: async (payload: any) => {
      if (typeof payload === "string") {
        // First LLM call: returns requestConsent
        return {
          response: {
            functionCalls: () => [
              {
                name: "requestConsent",
                args: {
                  cartId: "cart_gate_test",
                  productId: "prod_3",
                  description: "Purchase of Pegasus 41 Running Shoes",
                },
              },
            ],
            text: () => "",
          },
        };
      } else {
        // If Gemini was called back with tool output and attempted to call createTransactionRequest
        return {
          response: {
            functionCalls: () => [
              {
                name: "createTransactionRequest",
                args: {
                  cartId: "cart_gate_test",
                  consentId: capturedConsentId || "pending_consent",
                },
              },
            ],
            text: () => "",
          },
        };
      }
    },
  };

  const reply = await runAgentTurn(
    mockChatChainedAttempt,
    "Prepare Pegasus 41 order",
    context,
    async (consentId: string) => {
      capturedConsentId = consentId;
    },
    (evt) => {
      toolExecutedNames.push(evt.name);
    }
  );

  console.log(`- Executed tools in this turn:`, toolExecutedNames);
  console.log(`- Captured consent ID:`, capturedConsentId);
  console.log(`- Agent response: "${reply.trim()}"`);

  assert(toolExecutedNames.length === 1, "Exactly one tool must be executed in this turn");
  assert(toolExecutedNames[0] === "requestConsent", "Only requestConsent may execute in this turn");
  assert(!toolExecutedNames.includes("createTransactionRequest"), "createTransactionRequest MUST NOT execute in the same turn as requestConsent");
  assert(!toolExecutedNames.includes("requestPayment"), "requestPayment MUST NOT execute in the same turn as requestConsent");
  assert(!!capturedConsentId, "Must have captured valid consent ID");

  // Verify DB state: Consent must be PENDING
  const consentRecord = await prisma.consent.findUnique({ where: { id: capturedConsentId! } });
  assert(consentRecord?.status === "PENDING", "Consent in database must be PENDING");
  console.log("✔ Passed: Hard consent gate stops turn execution and keeps status PENDING.");

  // -------------------------------------------------------------------------
  // TEST 2: createTransactionRequest on PENDING consent throws error
  // -------------------------------------------------------------------------
  console.log("\n2. Testing that createTransactionRequest rejects PENDING consent...");

  let caughtError: string | null = null;
  try {
    await createTransactionRequest({
      customerId: "cust_gate_test",
      agentId: "agent_revenue",
      actionType: "CREATE_ORDER",
      cartId: "cart_gate_test",
      consentId: capturedConsentId!,
    });
  } catch (err: any) {
    caughtError = err.message;
  }

  console.log(`- Caught expected rejection: "${caughtError}"`);
  assert(!!caughtError && caughtError.includes("Consent is not confirmed"), "Must reject createTransactionRequest on PENDING consent");
  console.log("✔ Passed: Gateway strictly enforces CONFIRMED consent status.");

  // -------------------------------------------------------------------------
  // TEST 3: Batch injection defense: [requestConsent, createTransactionRequest] in same batch
  // -------------------------------------------------------------------------
  console.log("\n3. Testing batch tool call defense (preventing simultaneous consent + transaction in 1 batch)...");

  let batchExecutedTools: string[] = [];
  const mockChatBatchAttempt = {
    sendMessage: async (payload: any) => {
      if (typeof payload === "string") {
        return {
          response: {
            functionCalls: () => [
              {
                name: "requestConsent",
                args: {
                  cartId: "cart_gate_test_2",
                  productId: "prod_3",
                  description: "Purchase of Pegasus 41 Running Shoes",
                },
              },
              {
                name: "createTransactionRequest",
                args: {
                  cartId: "cart_gate_test_2",
                  consentId: "cmtn_unconfirmed",
                },
              },
            ],
            text: () => "",
          },
        };
      }
      return {
        response: {
          functionCalls: () => [],
          text: () => "Order prepared.",
        },
      };
    },
  };

  await runAgentTurn(
    mockChatBatchAttempt,
    "Batch attack attempt",
    context,
    undefined,
    (evt) => {
      if (!evt.error) {
        batchExecutedTools.push(evt.name);
      }
    }
  );

  console.log(`- Successful tools executed from batch:`, batchExecutedTools);
  assert(batchExecutedTools.length === 1 && batchExecutedTools[0] === "requestConsent", "Only requestConsent may succeed in batched call");
  console.log("✔ Passed: Batch tool call injection prevented.");

  console.log("\n=== ALL CONSENT GATING TESTS PASSED SUCCESSFULLY ===");
  process.exit(0);
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`\n✖ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Consent gating test failed:", err);
  process.exit(1);
});
