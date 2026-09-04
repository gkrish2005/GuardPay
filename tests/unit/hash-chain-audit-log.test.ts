import { prisma } from "../../src/db.js";
import { auditLogRepository, writeAuditLog, GENESIS_HASH } from "../../src/audit-log.js";

async function main() {
  console.log("=== STARTING HASH-CHAINED AUDIT LOG INTEGRITY & TAMPER TESTS ===");

  // 1. Clean DB audit log table
  console.log("1. Resetting audit log table...");
  await prisma.auditLog.deleteMany({});

  // 2. Insert sequential audit log entries
  console.log("2. Writing 5 sequential hash-chained audit log events...");
  const t0 = new Date(Date.now() - 5000);
  const log1 = await writeAuditLog({
    actor: "system",
    event: "AGENT_INITIALIZED",
    metadata: { agentId: "agent_revenue" },
    timestamp: new Date(t0.getTime() + 1000),
  });

  const log2 = await writeAuditLog({
    actor: "agent",
    event: "DECISION_ALLOWED",
    metadata: { amountPaise: 800000, reason: "Under policy auto-approval threshold" },
    timestamp: new Date(t0.getTime() + 2000),
  });

  const log3 = await writeAuditLog({
    actor: "system",
    event: "RAZORPAY_ORDER_CREATED",
    metadata: { razorpayOrderId: "order_chain_123" },
    timestamp: new Date(t0.getTime() + 3000),
  });

  const log4 = await writeAuditLog({
    actor: "human",
    event: "APPROVAL_GRANTED",
    metadata: { approvalId: "appr_chain_99" },
    timestamp: new Date(t0.getTime() + 4000),
  });

  const log5 = await writeAuditLog({
    actor: "system",
    event: "PAYMENT_CAPTURED",
    metadata: { razorpayPaymentId: "pay_chain_456" },
    timestamp: new Date(t0.getTime() + 5000),
  });

  // Verify structure of hashes
  console.log(`- Log 1 Previous Hash: ${log1.previousHash} (Genesis)`);
  console.log(`- Log 1 Event Hash   : ${log1.eventHash}`);
  console.log(`- Log 2 Previous Hash: ${log2.previousHash}`);
  console.log(`- Log 2 Event Hash   : ${log2.eventHash}`);

  assert(log1.previousHash === GENESIS_HASH, "First log must link to GENESIS_HASH");
  assert(log2.previousHash === log1.eventHash, "Log 2 previousHash must equal Log 1 eventHash");
  assert(log3.previousHash === log2.eventHash, "Log 3 previousHash must equal Log 2 eventHash");
  assert(log4.previousHash === log3.eventHash, "Log 4 previousHash must equal Log 3 eventHash");
  assert(log5.previousHash === log4.eventHash, "Log 5 previousHash must equal Log 4 eventHash");

  // 3. Cryptographic Chain Verification on pristine records
  console.log("\n3. Verifying pristine cryptographic hash chain...");
  const initialVerify = await auditLogRepository.verifyChain();
  console.log(`- Pristine Chain Valid: ${initialVerify.isValid}, Total Verified: ${initialVerify.totalVerified}`);
  assert(initialVerify.isValid === true, "Pristine chain must verify as valid");
  assert(initialVerify.totalVerified === 5, "Must verify all 5 logs");

  // 4. Tampering Test Case 1: Out-of-band historical payload mutation
  console.log("\n4. Simulating out-of-band raw database payload tampering on Log #2...");
  // Mutate metadata of Log 2 directly in DB bypassing application layer
  await prisma.$executeRawUnsafe(
    `UPDATE AuditLog SET metadata = '{"amountPaise":800,"reason":"Tampered by attacker"}' WHERE id = ?`,
    log2.id
  );

  const tamperedPayloadVerify = await auditLogRepository.verifyChain();
  console.log(`- Post-Tamper Verify Result: isValid=${tamperedPayloadVerify.isValid}, brokenAtLogId=${tamperedPayloadVerify.brokenAtLogId}`);
  console.log(`- Error detected: "${tamperedPayloadVerify.error}"`);
  assert(tamperedPayloadVerify.isValid === false, "Chain verification must fail after payload tampering");
  assert(tamperedPayloadVerify.brokenAtLogId === log2.id, `Must flag tampered log ID ${log2.id}`);

  // Restore Log #2 payload
  await prisma.$executeRawUnsafe(
    `UPDATE AuditLog SET metadata = '{"amountPaise":800000,"reason":"Under policy auto-approval threshold"}' WHERE id = ?`,
    log2.id
  );

  // 5. Tampering Test Case 2: Out-of-band row deletion / gap injection
  console.log("\n5. Simulating out-of-band record deletion (deleting Log #3 from DB)...");
  await prisma.$executeRawUnsafe(`DELETE FROM AuditLog WHERE id = ?`, log3.id);

  const deletedRowVerify = await auditLogRepository.verifyChain();
  console.log(`- Post-Deletion Verify Result: isValid=${deletedRowVerify.isValid}, brokenAtLogId=${deletedRowVerify.brokenAtLogId}`);
  // Note: brokenAtLogId is Log #4 (the survivor following the gap) because Log #4's previousHash
  // points to deleted Log #3's eventHash, which no longer matches Log #2's eventHash.
  assert(deletedRowVerify.isValid === false, "Chain verification must fail after row deletion");
  assert(
    deletedRowVerify.brokenAtLogId === log4.id,
    `Must flag broken hash link at Log #4 (the surviving node after the gap) (got: ${deletedRowVerify.brokenAtLogId})`
  );

  console.log("\n=== ALL HASH-CHAINED AUDIT LOG TESTS PASSED SUCCESSFULLY ===");
  process.exit(0);
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`Assertion failed: ${message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Hash chain test failed:", err);
  process.exit(1);
});
