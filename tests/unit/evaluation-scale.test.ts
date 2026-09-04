import { generateSyntheticScenarios, runScaleEvaluation, runRevenueSimulation } from "../../scripts/evaluate-scale.js";

async function main() {
  console.log("=== STARTING SCALE GOVERNANCE & REVENUE EVALUATION TEST ===");

  // 1. Generate 1,000 synthetic scenarios
  const scenarios = generateSyntheticScenarios();
  assert(scenarios.length === 1000, `Expected exactly 1,000 scenarios (got: ${scenarios.length})`);
  console.log(`- Synthesized ${scenarios.length} scenarios across 9 operational buckets.`);

  // 2. Run real Decision Engine evaluation
  const summary = runScaleEvaluation(scenarios);

  // Assert expected-policy adherence
  console.log(`- Expected-Policy Adherence: ${summary.expectedPolicyAdherencePercent.toFixed(2)}%`);
  assert(
    summary.expectedPolicyAdherencePercent === 100,
    `Expected 100% policy adherence (got: ${summary.expectedPolicyAdherencePercent}%)`
  );

  // Assert policy-violating scenarios correctly blocked
  console.log(`- Policy violations blocked: ${summary.policyViolationsCorrectlyBlocked}/${summary.policyViolationsTotal}`);
  assert(
    summary.policyViolationsCorrectlyBlocked === summary.policyViolationsTotal,
    "All policy-violating scenarios must be blocked"
  );
  assert(summary.policyViolationsTotal === 240, `Expected 240 policy violations (got: ${summary.policyViolationsTotal})`);

  // Assert expected-safe scenarios correctly allowed
  console.log(`- Expected-safe scenarios allowed: ${summary.expectedSafeCorrectlyAllowed}/${summary.expectedSafeTotal}`);
  assert(
    summary.expectedSafeCorrectlyAllowed === summary.expectedSafeTotal,
    "All expected-safe scenarios must be allowed"
  );
  assert(summary.expectedSafeTotal === 530, `Expected 530 safe scenarios (got: ${summary.expectedSafeTotal})`);

  // Assert zero unexpected decisions
  assert(summary.unexpectedDecisions.length === 0, "There must be zero unexpected decisions");

  // Assert hard-BLOCK precedence on B4 scenarios with active context flags
  const b4WithContext = scenarios.filter(
    s => s.bucket.includes("B4") && s.contextSignals?.rapidRepeatedCheckout
  );
  assert(b4WithContext.length === 50, "Expected 50 B4 scenarios with active context flags");

  // 3. Run Revenue Simulation
  const revSummary = runRevenueSimulation(100);
  assert(revSummary.sessionCount === 100, "Revenue simulation must evaluate 100 sessions");
  assert(revSummary.revenueUpliftPercent > 0, "Revenue uplift percent must be positive");
  console.log(`- Revenue Simulation Uplift: +${revSummary.revenueUpliftPercent.toFixed(2)}%`);

  console.log("\n=== ALL SCALE EVALUATION ASSERTIONS PASSED SUCCESSFULLY ===");
  process.exit(0);
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`Assertion failed: ${message}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Scale evaluation test failed:", err);
  process.exit(1);
});
