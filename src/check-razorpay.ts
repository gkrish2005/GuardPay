import Razorpay from "razorpay";
import dotenv from "dotenv";
dotenv.config();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || "",
  key_secret: process.env.RAZORPAY_KEY_SECRET || "",
});

async function main() {
  console.log("Fetching latest payments from Razorpay...");
  try {
    const payments = await razorpay.payments.all({
      count: 10
    });
    console.log("=== Latest 10 Payments ===");
    const items = payments.items || [];
    for (const item of items) {
      console.log(`- ID: ${item.id}`);
      console.log(`  Amount: ${Number(item.amount) / 100} ${item.currency}`);
      console.log(`  Status: ${item.status}`);
      console.log(`  Order ID: ${item.order_id}`);
      console.log(`  Method: ${item.method}`);
      console.log(`  Error Code: ${item.error_code}`);
      console.log(`  Error Description: ${item.error_description}`);
      console.log(`  Created At: ${new Date(item.created_at * 1000).toLocaleString()}`);
      console.log(`  Card Brand: ${item.card?.network || 'N/A'}`);
      console.log(`  Card Type: ${item.card?.type || 'N/A'}`);
      console.log("------------------------");
    }
  } catch (err: any) {
    console.error("Error fetching payments:", err.message || err);
  }
}

main().catch(console.error);
