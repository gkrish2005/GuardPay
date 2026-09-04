import "dotenv/config";
import { prisma } from "../../src/gateway.js";
import { auditLogRepository, writeAuditLog } from "../../src/audit-log.js";

async function main() {
  console.log("=== STARTING APPEND-ONLY AUDIT LOG ENFORCEMENT UNIT TESTS ===");

  const testTxReqId = `txreq_audit_test_${Date.now()}`;

  // ----------------------------------------------------
  // Test Case 1: Write Audit Log (Append Operation)
  // ----------------------------------------------------
  console.log("\n[TEST CASE 1] Running Write Audit Log (Append-Only) Test...");
  const log1 = await writeAuditLog({
    transactionRequestId: testTxReqId,
    actor: "system",
    event: "TEST_AUDIT_EVENT_APPEND",
    metadata: { testKey: "testValue", amount: 5000 },
  });

  assert(log1 !== null && log1.id !== undefined, "Audit log must be created with valid ID");
  assert(log1.actor === "system", "Actor must be 'system'");
  assert(log1.event === "TEST_AUDIT_EVENT_APPEND", "Event name must match");
  assert(log1.metadata?.amount === 5000, "Metadata must match");
  console.log(`- Created immutable audit log ID: ${log1.id}`);
  console.log("- Passed: Write/append operation succeeded.");

  // ----------------------------------------------------
  // Test Case 2: Read Audit Logs via Repository
  // ----------------------------------------------------
  console.log("\n[TEST CASE 2] Running Read Operations via Repository...");
  const logs = await auditLogRepository.findMany({ transactionRequestId: testTxReqId });
  assert(logs.length >= 1, "Should find at least 1 audit log for transaction request");
  assert(logs[0].id === log1.id, "Returned log ID must match created log");

  const singleLog = await auditLogRepository.findFirst({ id: log1.id });
  assert(singleLog !== null, "findFirst must return the log");
  assert(singleLog.event === "TEST_AUDIT_EVENT_APPEND", "Event must match");

  const count = await auditLogRepository.count({ transactionRequestId: testTxReqId });
  assert(count >= 1, "Count must be >= 1");
  console.log(`- Successfully retrieved ${logs.length} log(s) for ${testTxReqId}`);
  console.log("- Passed: Read operations verified.");

  // ----------------------------------------------------
  // Test Case 3: Reject UPDATE Operations at Application Layer
  // ----------------------------------------------------
  console.log("\n[TEST CASE 3] Asserting UPDATE Operations are Forbidden...");
  let updateError: any = null;
  try {
    (auditLogRepository as any).update({
      where: { id: log1.id },
      data: { event: "TAMPERED_EVENT" },
    });
  } catch (err: any) {
    updateError = err;
  }
  assert(updateError !== null, "Calling update on auditLogRepository must throw");
  assert(
    updateError.message.includes("AuditLog is append-only: UPDATE operations are forbidden"),
    `Expected forbidden message (got: "${updateError?.message}")`
  );
  console.log(`- Caught expected error on update: "${updateError.message}"`);

  let updateManyError: any = null;
  try {
    (auditLogRepository as any).updateMany({
      where: { transactionRequestId: testTxReqId },
      data: { event: "TAMPERED_EVENT" },
    });
  } catch (err: any) {
    updateManyError = err;
  }
  assert(updateManyError !== null, "Calling updateMany on auditLogRepository must throw");
  assert(
    updateManyError.message.includes("AuditLog is append-only: UPDATE operations are forbidden"),
    `Expected forbidden message (got: "${updateManyError?.message}")`
  );
  console.log(`- Caught expected error on updateMany: "${updateManyError.message}"`);
  console.log("- Passed: UPDATE operations forbidden at application layer.");

  // ----------------------------------------------------
  // Test Case 4: Reject DELETE Operations at Application Layer
  // ----------------------------------------------------
  console.log("\n[TEST CASE 4] Asserting DELETE Operations are Forbidden...");
  let deleteError: any = null;
  try {
    (auditLogRepository as any).delete({
      where: { id: log1.id },
    });
  } catch (err: any) {
    deleteError = err;
  }
  assert(deleteError !== null, "Calling delete on auditLogRepository must throw");
  assert(
    deleteError.message.includes("AuditLog is append-only: DELETE operations are forbidden"),
    `Expected forbidden message (got: "${deleteError?.message}")`
  );
  console.log(`- Caught expected error on delete: "${deleteError.message}"`);

  let deleteManyError: any = null;
  try {
    (auditLogRepository as any).deleteMany({
      where: { transactionRequestId: testTxReqId },
    });
  } catch (err: any) {
    deleteManyError = err;
  }
  assert(deleteManyError !== null, "Calling deleteMany on auditLogRepository must throw");
  assert(
    deleteManyError.message.includes("AuditLog is append-only: DELETE operations are forbidden"),
    `Expected forbidden message (got: "${deleteManyError?.message}")`
  );
  console.log(`- Caught expected error on deleteMany: "${deleteManyError.message}"`);
  console.log("- Passed: DELETE operations forbidden at application layer.");

  // ----------------------------------------------------
  // Test Case 5: Immutability Verification (Original Log Remains Unmodified)
  // ----------------------------------------------------
  console.log("\n[TEST CASE 5] Verifying Audit Log Remains Unmodified...");
  const preservedLog = await auditLogRepository.findFirst({ id: log1.id });
  assert(preservedLog !== null, "Audit log must still exist");
  assert(preservedLog.event === "TEST_AUDIT_EVENT_APPEND", "Audit log event must remain original value");
  assert(preservedLog.actor === "system", "Actor must remain 'system'");
  assert((preservedLog.metadata as any)?.amount === 5000, "Metadata must remain original amount");
  console.log("- Passed: Audit log immutability confirmed.");

  // Clean up test rows
  await prisma.auditLog.deleteMany({ where: { transactionRequestId: testTxReqId } });

  console.log("\n=== ALL APPEND-ONLY AUDIT LOG TESTS PASSED SUCCESSFULLY ===");
  process.exit(0);
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`Assertion failed: ${message}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Audit log test failed:", err);
  process.exit(1);
});
