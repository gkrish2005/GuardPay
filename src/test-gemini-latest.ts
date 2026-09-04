import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  const genAI = new GoogleGenerativeAI(apiKey || "");

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
    const result = await model.generateContent("Hello! Who are you?");
    console.log("Success with gemini-flash-latest:", result.response.text());
  } catch (err: any) {
    console.error("Failed with gemini-flash-latest:", err.message || err);
  }
}

main().catch(console.error);
