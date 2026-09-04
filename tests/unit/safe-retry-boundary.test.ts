import { runAgentTurn, AgentContext } from "../../src/agent.js";
import { prisma } from "../../src/db.js";
import { computeCartHash } from "../../src/gateway.js";

async function main() {
  console.log("=== STARTING SAFE RETRY BOUNDARY TESTS ===");

  const context: AgentContext = {
    customerId: "cust_retry_test",
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
  // TEST 1: Transient 503 on initial message (before tools) retries safely
  // -------------------------------------------------------------------------
  console.log("\n1. Testing retry on initial turn before tool execution...");
  let initialCallCount = 0;
  const mockChatInitialFail = {
    sendMessage: async (msg: any) => {
      initialCallCount++;
      if (initialCallCount === 1) {
        throw new Error("[GoogleGenerativeAI Error]: 503 Service Unavailable");
      }
      return {
        response: {
          functionCalls: () => [],
          text: () => "Here are the running shoes you requested.",
        },
      };
    },
  };

  const reply1 = await runAgentTurn(mockChatInitialFail, "Search running shoes", context);
  console.log(`- Calls made: ${initialCallCount} (1 failure + 1 retry = 2)`);
  console.log(`- Final reply: "${reply1}"`);
  assert(initialCallCount === 2, "Must retry once on initial 503 failure");
  assert(reply1.includes("running shoes"), "Must return successful response on retry");
  console.log("✔ Passed: Initial message retries safely.");

  // -------------------------------------------------------------------------
  // TEST 2: Side-effecting tool executes, then Gemini fails -> tool must NOT replay
  // -------------------------------------------------------------------------
  console.log("\n2. Testing safe boundary when Gemini fails AFTER side-effecting tool execution...");
  
  let toolExecutionCount = 0;
  let secondGeminiCallCount = 0;

  const productSnapshot = { items: [{ productId: "prod_3", name: "Pegasus 41", price: 8000, qty: 1 }] };
  const amountPaise = 800000;
  const cartHash = computeCartHash(productSnapshot, amountPaise);

  // Create a consent in DB for testing
  const consent = await prisma.consent.create({
    data: {
      customerId: "cust_retry_test",
      cartId: "cart_retry_test",
      amountPaise,
      productSnapshot,
      cartHash,
      status: "CONFIRMED",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    },
  });

  const mockChatToolFail = {
    sendMessage: async (payload: any) => {
      if (typeof payload === "string") {
        // First call: returns createTransactionRequest tool call
        return {
          response: {
            functionCalls: () => [
              {
                name: "createTransactionRequest",
                args: {
                  cartId: "cart_retry_test",
                  consentId: consent.id,
                },
              },
            ],
            text: () => "",
          },
        };
      } else {
        // Second call (with tool results): Gemini throws persistent 503 error
        secondGeminiCallCount++;
        throw new Error("[GoogleGenerativeAI Error]: 503 Service Unavailable - High Demand");
      }
    },
  };

  const executedEvents: any[] = [];
  const reply2 = await runAgentTurn(
    mockChatToolFail,
    "Execute order",
    context,
    undefined,
    (evt) => {
      toolExecutionCount++;
      executedEvents.push(evt);
    }
  );

  console.log(`- Tool execution count: ${toolExecutionCount}`);
  console.log(`- Second Gemini call attempts: ${secondGeminiCallCount}`);
  console.log(`- Fallback synthesized response: "${reply2}"`);

  assert(toolExecutionCount === 1, "Side-effecting tool must be executed EXACTLY once");
  assert(executedEvents[0].name === "createTransactionRequest", "Must be createTransactionRequest tool");
  assert(!!executedEvents[0].output?.id, "Tool output must be valid");
  assert(reply2.includes("transaction request"), "Must synthesize fallback response from tool state");
  console.log("✔ Passed: Side-effecting tools are never replayed on post-tool Gemini errors.");

  console.log("\n=== ALL SAFE RETRY BOUNDARY TESTS PASSED SUCCESSFULLY ===");
  process.exit(0);
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`\n✖ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Safe retry boundary test failed:", err);
  process.exit(1);
});
