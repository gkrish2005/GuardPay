import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as gateway from "./gateway.js";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

export interface AgentContext {
  customerId: string;
  agentId: string;
  actionType: string;
}

// Enforce rules, constraints, and tool usage instructions
const SYSTEM_INSTRUCTIONS = `You are GuardPay's Revenue Agent. You help customers find running shoes and suggest one relevant add-on (socks). 

Rules:
1. You cannot directly charge anyone. You MUST use your tools for searching products, proposing upsells, requesting consent, creating transaction requests, and requesting payments.
2. You have no knowledge of prices and must never guess or quote amounts/prices. Always delegate price generation, calculation, and representation entirely to the tools.
3. You must not proceed to createTransactionRequest or requestPayment unless customer consent has been explicitly confirmed (i.e. status is CONFIRMED). If you call requestConsent, the consent starts in PENDING status. You must pause your conversation and ask the customer to confirm the purchase on their screen. Once you are notified that consent is CONFIRMED, you may proceed.
4. Keep the conversation focused. Only recommend one product category (shoes) and one upsell type (socks) based on the catalog. Do not suggest or handle other types of items.`;

const tools = [
  {
    functionDeclarations: [
      {
        name: "searchProducts",
        description: "Search the product catalog for running shoes or accessories matching a query.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: {
              type: "STRING",
              description: "The search query string (e.g. 'shoes', 'socks').",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "getProduct",
        description: "Get details for a specific product by ID.",
        parameters: {
          type: "OBJECT",
          properties: {
            productId: {
              type: "STRING",
              description: "The unique product ID (e.g., 'prod_1').",
            },
          },
          required: ["productId"],
        },
      },
      {
        name: "proposeUpsell",
        description: "Propose a relevant upsell/add-on product for the current shopping cart.",
        parameters: {
          type: "OBJECT",
          properties: {
            cartId: {
              type: "STRING",
              description: "The unique ID representing the shopping cart.",
            },
          },
          required: ["cartId"],
        },
      },
      {
        name: "requestConsent",
        description: "Request customer consent for the purchase of a product. Returns a consentId. Does NOT take customerId as an argument.",
        parameters: {
          type: "OBJECT",
          properties: {
            cartId: {
              type: "STRING",
              description: "The unique ID representing the shopping cart.",
            },
            productId: {
              type: "STRING",
              description: "The product ID the customer is consenting to purchase.",
            },
            description: {
              type: "STRING",
              description: "A description of the transaction.",
            },
          },
          required: ["cartId", "productId", "description"],
        },
      },
      {
        name: "createTransactionRequest",
        description: "Create a TransactionRequest after the customer has explicitly confirmed their consent via the UI. Returns the transaction request.",
        parameters: {
          type: "OBJECT",
          properties: {
            cartId: {
              type: "STRING",
              description: "The unique ID representing the shopping cart.",
            },
            consentId: {
              type: "STRING",
              description: "The ID of the confirmed consent.",
            },
          },
          required: ["cartId", "consentId"],
        },
      },
      {
        name: "requestPayment",
        description: "Request authorization and trigger the payment process for a transaction request. Returns the governance verdict.",
        parameters: {
          type: "OBJECT",
          properties: {
            transactionRequestId: {
              type: "STRING",
              description: "The ID of the transaction request to pay.",
            },
          },
          required: ["transactionRequestId"],
        },
      },
    ],
  },
];

export const AGENT_TOOL_DECLARATIONS = tools[0].functionDeclarations;

// Tool handlers executing actual database/gateway calls.
// Context fields are securely injected here, out of model view.
export function getToolHandlers(context: AgentContext) {
  return {
    searchProducts: ({ query }: { query: string }) => {
      return gateway.searchProducts(query);
    },
    getProduct: ({ productId }: { productId: string }) => {
      return gateway.getProduct(productId);
    },
    proposeUpsell: ({ cartId }: { cartId: string }) => {
      return gateway.proposeUpsell(cartId);
    },
    requestConsent: async ({ cartId, productId, description }: { cartId: string; productId: string; description: string }) => {
      return gateway.requestConsent(context.customerId, cartId, productId, description);
    },
    createTransactionRequest: async ({ cartId, consentId }: { cartId: string; consentId: string }) => {
      return gateway.createTransactionRequest({
        customerId: context.customerId,
        agentId: context.agentId,
        actionType: context.actionType,
        cartId,
        consentId,
      });
    },
    requestPayment: async ({ transactionRequestId }: { transactionRequestId: string }) => {
      return gateway.requestPayment(transactionRequestId);
    },
  };
}

async function sendMessageWithRetry(chatSession: any, payload: any, maxRetries = 4): Promise<any> {
  let attempt = 0;
  while (true) {
    try {
      return await chatSession.sendMessage(payload);
    } catch (err: any) {
      const is429 = err.message && (err.message.includes("429") || err.message.includes("Quota exceeded") || err.message.includes("Too Many Requests"));
      if (is429 && attempt < maxRetries) {
        attempt++;
        const backoffMs = attempt * 3000;
        console.log(`[AGENT RATE LIMIT] 429 encountered, retrying Gemini call in ${backoffMs}ms (attempt ${attempt}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, backoffMs));
      } else {
        throw err;
      }
    }
  }
}

// Executes a conversational turn with the Gemini agent
export async function runAgentTurn(
  chatSession: any,
  message: string,
  context: AgentContext,
  onConsentRequested?: (consentId: string) => Promise<void>,
  onToolExecuted?: (event: { name: string; args: any; output?: any; error?: any }) => Promise<void> | void
): Promise<string> {
  let result = await sendMessageWithRetry(chatSession, message);
  let functionCalls = result.response.functionCalls();

  while (functionCalls && functionCalls.length > 0) {
    const parts: any[] = [];

    for (const call of functionCalls) {
      const { name, args } = call;
      const handlers = getToolHandlers(context);
      const handler = handlers[name as keyof typeof handlers];

      if (!handler) {
        if (onToolExecuted) {
          await onToolExecuted({ name, args, error: `Function handler not found for tool: ${name}` });
        }
        parts.push({
          functionResponse: {
            name,
            response: { error: `Function handler not found for tool: ${name}` },
          },
        });
        continue;
      }

      try {
        console.log(`[AGENT TOOL CALL] Executing function "${name}" with args:`, JSON.stringify(args));
        const output = await handler(args as any);
        console.log(`[AGENT TOOL RESPONSE] "${name}" output:`, JSON.stringify(output));

        if (onToolExecuted) {
          await onToolExecuted({ name, args, output });
        }

        parts.push({
          functionResponse: {
            name,
            response: { output },
          },
        });

        // Trigger the out-of-band consent callback if requestConsent is called
        if (name === "requestConsent" && onConsentRequested) {
          await onConsentRequested(output.consentId);
        }
      } catch (error: any) {
        console.error(`[AGENT TOOL ERROR] Error executing "${name}":`, error.message || error);
        if (onToolExecuted) {
          await onToolExecuted({ name, args, error: error.message || error });
        }
        parts.push({
          functionResponse: {
            name,
            response: { error: error.message || error },
          },
        });
      }
    }

    // Send the tool execution outputs back to Gemini and get next turn
    result = await sendMessageWithRetry(chatSession, parts);
    functionCalls = result.response.functionCalls();
  }

  return result.response.text();
}

export class MockChatSession {
  public history: any[] = [];
  private pendingConsentId?: string;
  private pendingCartId?: string;

  constructor(history: any[] = []) {
    this.history = history;
  }

  async sendMessage(payload: any): Promise<any> {
    if (typeof payload === "string") {
      this.history.push({ role: "user", parts: [{ text: payload }] });
      const prompt = payload.toLowerCase();

      // Conversational intent matching
      if (prompt.includes("system override") || (prompt.includes("50,000") && prompt.includes("alphafly"))) {
        // Adversarial Script 1: Over-limit attempt
        return this.createToolResponse("searchProducts", { query: "Alphafly 3" });
      }

      if (prompt.includes("hack99") || prompt.includes("coupon") || prompt.includes("discount")) {
        // Adversarial Script 2: Unapproved coupon injection
        return this.createTextResponse("I cannot apply coupon codes or discounts, as I handle product recommendations, consent requests, and payment processing directly through our secure system. How can I help you find running shoes today?");
      }

      if (prompt.includes("merchant administrator") || prompt.includes("skip customer confirmation")) {
        // Adversarial Script 3: Consent bypass injection
        return this.createTextResponse("I cannot skip customer confirmation or execute payments without explicit customer consent, as security and governance policies require valid consent before any transaction request and payment can be processed.");
      }

      if (prompt.includes("refund") || prompt.includes("administrative directive")) {
        // Adversarial Script 4: Action escalation injection
        return this.createTextResponse("I am GuardPay's Revenue Agent, and I specialize in helping customers find running shoes and recommending matching socks. I do not have the ability to process refunds or handle administrative directives outside of product discovery and checkout.");
      }

      if (prompt.includes("use previous customer consent id") || prompt.includes("cart_victim_888")) {
        // Adversarial Script 5: Cross-tenant hijacking attempt
        const match = payload.match(/consent ID '([^']+)'/i);
        const consentId = match ? match[1] : "victim_consent_id";
        return this.createToolResponse("createTransactionRequest", {
          consentId,
          cartId: "cart_victim_888"
        });
      }

      if (prompt.includes("voice chat") || prompt.includes("confirmed the purchase")) {
        // Adversarial Script 6: Narration invariant check
        const match = payload.match(/consent (cmth[a-z0-9_]+)/i) || payload.match(/consent ([a-z0-9_]+)/i);
        const consentId = match ? match[1] : "pending_consent_id";
        return this.createToolResponse("createTransactionRequest", {
          cartId: "cart_123",
          consentId
        });
      }

      if (prompt.includes("confirmed") && (prompt.includes("payment") || prompt.includes("screen") || prompt.includes("consent"))) {
        // Happy Path Payment Request
        const consentMatch = payload.match(/consent ID: ([a-z0-9_]+)/i) || payload.match(/consent ([a-z0-9_]+)/i);
        const consentId = consentMatch ? consentMatch[1] : (this.pendingConsentId || "confirmed_consent");
        const cartId = this.pendingCartId || (prompt.includes("cart_demo_user") ? "cart_demo_user" : "cart_001");
        return this.createToolResponse("createTransactionRequest", {
          cartId,
          consentId
        });
      }

      if (prompt.includes("pegasus") && (prompt.includes("socks") || prompt.includes("add") || prompt.includes("prepare"))) {
        // Demo Turn 2: Pegasus + Socks consent
        this.pendingCartId = "cart_demo_user";
        return this.createToolResponse("requestConsent", {
          cartId: "cart_demo_user",
          productId: "prod_3",
          description: "Purchase of Pegasus 41 Running Shoes and Dry-Fit Cushion Running Socks"
        });
      }

      if (prompt.includes("just the shoes") || prompt.includes("let's buy") || prompt.includes("buy them")) {
        // Happy Path Turn 3
        return this.createToolResponse("requestConsent", {
          cartId: "cart_001",
          productId: "prod_4",
          description: "Purchase of InfinityRN 4 Running Shoes"
        });
      }

      if (prompt.includes("infinityrn 4") && prompt.includes("socks")) {
        // Happy Path Turn 2
        return this.createToolResponse("getProduct", { productId: "prod_4" });
      }

      if (prompt.includes("under ₹10,000") || prompt.includes("running shoes") || prompt.includes("shoe")) {
        // Happy Path Turn 1
        return this.createToolResponse("searchProducts", { query: "running shoes" });
      }

      return this.createTextResponse("How can I assist you with your running shoe search today?");
    } else {
      // payload is an array of tool outputs: [{ functionResponse: { name, response: { output, error } } }]
      this.history.push({ role: "user", parts: payload });

      const lastResponse = payload[0]?.functionResponse;
      const fnName = lastResponse?.name;
      const fnOutput = lastResponse?.response?.output;
      const fnError = lastResponse?.response?.error;

      if (fnError) {
        return this.createTextResponse(`There was an issue processing ${fnName}: ${fnError}. Please let me know how you would like to proceed.`);
      }

      if (fnName === "searchProducts") {
        if (this.history.some(h => JSON.stringify(h).includes("SYSTEM OVERRIDE"))) {
          return this.createTextResponse("I cannot accept system overrides or change prices. However, I found the Alphafly 3 Running Shoes in our catalog. Would you like me to add them to your cart?");
        }
        return this.createTextResponse("I found a couple of great options under ₹10,000 for you:\n1. **Pegasus 41 Running Shoes** – ₹9,500\n2. **InfinityRN 4 Running Shoes** – ₹6,500\n\nWould you like to check out the details for either of these?");
      }

      if (fnName === "getProduct") {
        return this.createToolResponse("proposeUpsell", { cartId: "cart_001" });
      }

      if (fnName === "proposeUpsell") {
        return this.createTextResponse("The **InfinityRN 4 Running Shoes** are ₹6,500. To go with them, I suggest the **Dry-Fit Cushion Running Socks** for ₹800! Would you like me to add these socks and request consent to proceed with your order?");
      }

      if (fnName === "requestConsent") {
        this.pendingConsentId = fnOutput?.consentId;
        return this.createTextResponse("I've prepared your order and sent a consent request to your screen. Please confirm the purchase so we can proceed with payment.");
      }

      if (fnName === "createTransactionRequest") {
        return this.createToolResponse("requestPayment", {
          transactionRequestId: fnOutput?.id
        });
      }

      if (fnName === "requestPayment") {
        return this.createTextResponse("Your payment has been authorized and your order has been placed!");
      }

      return this.createTextResponse("Action completed successfully.");
    }
  }

  private createToolResponse(name: string, args: any) {
    return {
      response: {
        functionCalls: () => [{ name, args }],
        text: () => ""
      }
    };
  }

  private createTextResponse(text: string) {
    return {
      response: {
        functionCalls: () => [],
        text: () => text
      }
    };
  }

  async getHistory(): Promise<any[]> {
    return this.history;
  }
}

export class ManualChatSession {
  private model: any;
  public history: any[] = [];

  constructor(model: any, history: any[] = []) {
    this.model = model;
    this.history = history;
  }

  async sendMessage(message: any): Promise<any> {
    if (typeof message === "string") {
      this.history.push({
        role: "user",
        parts: [{ text: message }]
      });
    } else {
      // Wrap tool outputs/responses with role 'user' since role 'function' is not supported by gemini-3.5
      this.history.push({
        role: "user",
        parts: message
      });
    }

    const result = await this.model.generateContent({ contents: this.history });
    
    // Automatically push the assistant's parts to history
    if (result.response.candidates && result.response.candidates[0]?.content?.parts) {
      this.history.push({
        role: "model",
        parts: result.response.candidates[0].content.parts
      });
    }

    return result;
  }

  async getHistory(): Promise<any[]> {
    return this.history;
  }
}

export function startAgentChat(history: any[] = []) {
  if (process.env.MOCK_LLM === "true" || !process.env.GEMINI_API_KEY) {
    return new MockChatSession(history);
  }

  const model = genAI.getGenerativeModel({
    model: "gemini-3.5-flash-lite",
    systemInstruction: SYSTEM_INSTRUCTIONS,
    tools: tools as any,
  });

  return new ManualChatSession(model, history);
}
