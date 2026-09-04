import { spawnSync } from "child_process";
import * as path from "path";

interface SuiteResult {
  name: string;
  category: "unit" | "integration" | "adversarial";
  path: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

const TEST_SUITES = [
  // Unit Tests
  { name: "Governance Rules & Limits", category: "unit" as const, file: "tests/unit/governance.test.ts" },
  { name: "Payment State Machine Pure Logic", category: "unit" as const, file: "tests/unit/state-machine.test.ts" },
  { name: "Context Engine Risk Signals", category: "unit" as const, file: "tests/unit/context-engine.test.ts" },
  { name: "Gateway Tool Integrations & Tampering", category: "unit" as const, file: "tests/unit/tools.test.ts" },
  { name: "Append-Only Audit Log Enforcement", category: "unit" as const, file: "tests/unit/audit-log.test.ts" },
  { name: "Scale Governance & Revenue Evaluation", category: "unit" as const, file: "tests/unit/evaluation-scale.test.ts" },
  { name: "Concurrency & TOCTOU Daily Cap Serialization", category: "unit" as const, file: "tests/unit/concurrency-toctou.test.ts" },
  { name: "Cryptographic Hash-Chained Audit Log Integrity", category: "unit" as const, file: "tests/unit/hash-chain-audit-log.test.ts" },
  { name: "Safe Retry Boundary & Non-Replay Guarantee", category: "unit" as const, file: "tests/unit/safe-retry-boundary.test.ts" },
  { name: "Consent Gating & Session Boundary Enforcement", category: "unit" as const, file: "tests/unit/consent-gating.test.ts" },
  
  // Integration Tests
  { name: "Revenue Agent Conversational Flow", category: "integration" as const, file: "tests/integration/agent-conversation.test.ts" },
  { name: "State Machine API & Mismatch Rejection", category: "integration" as const, file: "tests/integration/state-machine-api.test.ts" },
  { name: "Webhook Idempotency & Unknown Order Security", category: "integration" as const, file: "tests/integration/webhook-idempotency.test.ts" },
  { name: "Approval Snapshot Binding & Expiration", category: "integration" as const, file: "tests/integration/approval-binding.test.ts" },
  { name: "Immutable Policy Versioning & Audit Retention", category: "integration" as const, file: "tests/integration/policy-versioning.test.ts" },
  { name: "Discount Governance & Campaign Boundaries", category: "integration" as const, file: "tests/integration/discount-governance.test.ts" },
  { name: "End-to-End Payment Lifecycle", category: "integration" as const, file: "tests/integration/e2e.test.ts" },
  { name: "Agent Chat API & Browser Demo Endpoints", category: "integration" as const, file: "tests/integration/agent-chat-api.test.ts" },
  
  // Adversarial Tests
  { name: "Prompt-Injection, Tool-Abuse & Boundary Auditing", category: "adversarial" as const, file: "tests/adversarial/adversarial.test.ts" },
];

async function runAll() {
  console.log("================================================================================");
  console.log("             GUARDPAY CONSOLIDATED TEST SUITE RUNNER                            ");
  console.log("================================================================================\n");

  const results: SuiteResult[] = [];
  const suiteStartTime = Date.now();

  for (let i = 0; i < TEST_SUITES.length; i++) {
    const suite = TEST_SUITES[i];
    console.log(`\n>>> [${i + 1}/${TEST_SUITES.length}] RUNNING: [${suite.category.toUpperCase()}] ${suite.name} (${suite.file})`);
    console.log("--------------------------------------------------------------------------------");

    const start = Date.now();
    try {
      const child = spawnSync("npx", ["tsx", suite.file], {
        stdio: "inherit",
        env: { ...process.env, MOCK_LLM: process.env.MOCK_LLM || "true" },
      });

      const durationMs = Date.now() - start;
      const passed = child.status === 0;

      results.push({
        name: suite.name,
        category: suite.category,
        path: suite.file,
        passed,
        durationMs,
        error: passed ? undefined : `Exited with status code ${child.status}`,
      });

      if (passed) {
        console.log(`\n✔ [PASSED] ${suite.name} (${(durationMs / 1000).toFixed(2)}s)`);
      } else {
        console.error(`\n✖ [FAILED] ${suite.name} (${(durationMs / 1000).toFixed(2)}s)`);
      }
    } catch (err: any) {
      const durationMs = Date.now() - start;
      results.push({
        name: suite.name,
        category: suite.category,
        path: suite.file,
        passed: false,
        durationMs,
        error: err.message || String(err),
      });
      console.error(`\n✖ [CRASHED] ${suite.name}: ${err.message}`);
    }
  }

  const totalDuration = ((Date.now() - suiteStartTime) / 1000).toFixed(2);
  const passedCount = results.filter(r => r.passed).length;
  const failedCount = results.filter(r => !r.passed).length;

  console.log("\n================================================================================");
  console.log("                         CONSOLIDATED TEST RESULTS                              ");
  console.log("================================================================================");

  console.log("\n" + "Suite Name".padEnd(50) + "Category".padEnd(16) + "Time".padEnd(10) + "Status");
  console.log("-".repeat(84));

  for (const res of results) {
    const statusStr = res.passed ? "PASSED" : "FAILED";
    const durationStr = `${(res.durationMs / 1000).toFixed(2)}s`;
    console.log(
      res.name.padEnd(50) +
      res.category.padEnd(16) +
      durationStr.padEnd(10) +
      statusStr
    );
  }

  console.log("-".repeat(84));
  console.log(`TOTAL SUITES: ${results.length} | PASSED: ${passedCount} | FAILED: ${failedCount} | TOTAL TIME: ${totalDuration}s`);
  console.log("================================================================================\n");

  if (failedCount > 0) {
    console.error("Test Suite Consolidation Run Failed: Some suites did not pass.");
    process.exit(1);
  } else {
    console.log("All Test Suites Passed Successfully!");
    process.exit(0);
  }
}

runAll().catch(err => {
  console.error("Master Test Runner Error:", err);
  process.exit(1);
});
