import "dotenv/config";
import ngrok from "ngrok";

const PORT = Number(process.env.PORT) || 3000;

async function startTunnel(): Promise<void> {
  const authtoken = process.env.NGROK_AUTHTOKEN;
  if (!authtoken) {
    console.error(
      "NGROK_AUTHTOKEN is required. Sign up at https://dashboard.ngrok.com/signup",
    );
    console.error(
      "Then add your authtoken to .env: NGROK_AUTHTOKEN=<your-token>",
    );
    process.exit(1);
  }

  await ngrok.authtoken(authtoken);

  const url = await ngrok.connect({
    addr: PORT,
    proto: "http",
  });

  console.log(`ngrok tunnel active: ${url} -> http://localhost:${PORT}`);
  console.log("Configure this URL in the Razorpay dashboard webhook settings.");
}

startTunnel().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Failed to start ngrok tunnel:", message);
  process.exit(1);
});
