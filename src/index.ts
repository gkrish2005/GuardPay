import "dotenv/config";
import express from "express";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`GuardPay server listening on http://localhost:${PORT}`);
});
