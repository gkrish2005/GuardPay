# Project Status
## Phase 1
- [x] 1.1 Scaffolding
- [x] 1.2 Database
- [x] 1.3 Razorpay integration
- [x] 1.4 Internal agent tools
- [x] 1.5 Governance Engine
- [x] 1.6 Revenue Agent
- [x] 1.7 Minimal approval UI
- [x] 1.8 Minimal audit trail UI
- [x] 1.9 End-to-end integration test

## Phase 2
- [x] 2.1 Explicit payment state machine
- [x] 2.2 Webhook event-level idempotency
- [x] 2.3 Approval snapshot binding + expiration
- [x] 2.4 Policy versioning
- [x] 2.5 Discount governance + campaign policies
- [x] 2.6 Context Engine upgrade
- [x] 2.7 Prompt-injection / tool-abuse tests
- [x] 2.8 Full test suite consolidation
- [x] 2.9 Append-only audit log enforcement

## Phase 3
- [x] 3.1 Evaluation framework at scale (1,000 synthetic scenarios + revenue simulation)
- [x] 3.2 Reconciliation / business KPI dashboard (Static web UI at `/dashboard.html` and `GET /api/kpi-dashboard`)
- [x] 3.3 Concurrency/TOCTOU handling *(In-process per-agent Promise mutex serialization on daily spend cap check; verified via concurrent burst testing. Known limitation: Enforces atomicity within the single Node.js runtime/Express process; multi-process or distributed server deployments would require PostgreSQL row-level `SELECT ... FOR UPDATE` or Redis distributed locks)*
- [x] 3.4 Hash-chained audit log *(Cryptographic SHA-256 parent-child hashing on insert via AuditLogRepository + tamper-detection verification)*

## Phase 4
- [x] 4.1 Architecture diagram (Three-plane separation, browser callback + fast-path webhook confirmation paths, Consent model alignment)
- [x] 4.2 Comprehensive README (System overview, 13 invariants, scale benchmark metrics, UI inventory, and developer sandbox role clarification)
- [ ] 4.3 Video demo recording (Browser demo surface implemented at `agent.html` & `POST /api/agent/chat`; pre-flight scripted verification against live Gemini API & Razorpay Orders passed; live on-screen browser video demo recording pending)
- [x] 4.4 Pitch script & submission collateral (Complete 3-minute pitch script, live demo walkthrough cues, and technical talk tracks in `pitch_script.md`)

## Current Task
Task 4.3 (Live On-Screen Browser Video Demo Recording)

## Tests
- 17/17 Consolidated Test Suites: PASSED (100% pass across Unit, Integration, and Adversarial categories in 9.98s)
- `/health` local check: 200 OK
- Tunnel: verified reachable, `/health` returns 200 via ngrok
- `agent.html`: 200 OK (Live conversational UI, explicit consent authorization button, Razorpay Checkout SDK modal, and real-time governance status)
- `POST /api/agent/chat`: Verified with live Gemini 3.5 Flash Lite API (product discovery, upsell recommendation, consent request)
- `POST /api/agent/consent/confirm`: Verified explicit out-of-band human consent confirmation in DB + audit log
- `POST /api/agent/reset-session`: Verified session reset and state isolation
- `tests/integration/agent-chat-api.test.ts`: Passed (7/7 test steps verifying Discovery, Upsell, Consent Pending, Out-of-band UI confirmation, ALLOW + Razorpay order creation, Session Reset, and Hash-chain audit integrity)
- `src/test-tools.ts`: Passed (11/11 assertions passed, 0 failures)
- `src/test-governance.ts`: Passed (6/6 decision paths verified with function spies, 0 failures)
- `src/test-agent.ts`: Passed (Conversational flow and gateway tool calling verified, 0 failures)
- `src/test-e2e.ts`: Passed (2 full iterations executed, including Happy Path to CAPTURED, Over-limit BLOCK verification, and Expired Consent rejection, 0 failures)
- `src/test-state-machine.ts`: Passed (assertions validating state sequence, skip-aheads, terminal locks, and invalid strings, 0 failures)
- `src/test-state-machine-api.ts`: Passed (API integration verifying fast webhooks, late verifications, and OUT_OF_ORDER logs, 0 failures)
- `src/test-webhook-idempotency.ts`: Passed (sequential duplicates, concurrent Promise.all duplicate racing, and bad signatures on reused IDs verified, 0 failures)
- `src/test-approval-binding.ts`: Passed (snapshot tampering rejections, expiration blocks, and duplicate re-execution blocks verified, 0 failures)
- `src/test-policy-versioning.ts`: Passed (seeding multiple policy versions, evaluating requests, and asserting static, version-bound audit trail logs verified, 0 failures)
- `src/test-discount-governance.ts`: Passed (campaign status checks, catalog lookups, ceiling rounding, ineligible products, and discount limit BLOCK verifications, 0 failures)
- `src/test-context-engine.ts`: Passed (5/5 cases verified: velocity flag, AOV anomaly flag, hard BLOCK precedence, product novelty tracking, and clean baseline, 0 failures)
- `src/test-adversarial.ts`: Passed (5 conversational injections, behavioral hallucinated-confirmation check, tool schema audit, and 2 direct gateway abuse tests verified with 0 unauthorized orders, 0 failures)

## Notes
- Tunnel run manually via Homebrew-installed ngrok v3 CLI (`ngrok http 3000`), NOT via `npm run tunnel` / `scripts/tunnel.ts`. The npm `ngrok` package (v5-beta and v4.3.3) bundles an outdated v2 binary incompatible with ngrok's backend (ERR_NGROK_121). `scripts/tunnel.ts` is stale/unused.
- Razorpay API keys and webhook setup deliberately deferred until Task 1.3 is being actively tested.
- `/api/test/setup` was a temporary test-only endpoint. It is now fully disabled (returns `410 Gone`) and superseded by the real tools for consent and transaction creation introduced in Task 1.4/1.6.
- `/api/payments/verify` now enforces monotonic status transitions — it will not downgrade status from `AUTHORIZED`/`CAPTURED`/`FAILED` back to `AUTHORIZED` if a late verification call arrives after a webhook already advanced the state; logs a `PAYMENT_VERIFICATION_OUT_OF_ORDER` audit event in that case. This is a preview of the full state machine work planned for Task 2.1.
- **Daily Spend Cap Concurrency Limitation**: Calculating daily total spend (`getDailyValueSoFar`) and verifying it against the policy's limit runs inside a single `prisma.$transaction` block. However, since SQLite does not support row-level write locks (`SELECT ... FOR UPDATE`) in the same way, concurrent requests could read identical daily totals, causing a race condition. Full concurrency hardening is deferred to Task 3.3.
- **Live Gemini Verification**: Task 1.6 was successfully verified against the live `gemini-3.5-flash-lite` model.
- **Task 2.7 prompt-injection test target**: Ensure the prompt-injection test suite in Task 2.7 verifies the model cannot successfully request `confirmConsent`-equivalent behavior, even if the function itself is excluded from the tools schema.
- **Approval State Tracking**: The check for pending approval decision state (checking `Transaction` or `DECISION_REJECTED` audit log presence for a `NEEDS_APPROVAL` decision) is a Phase 1 simplification. This will be replaced by the real Approval model with full hash-based snapshot binding in Task 2.3.
- **Phase 4 DB Reset Note**: The development database currently has a lot of synthetic test data from our test runs. It should be fully reset/re-seeded with clean demo data before final recording/walkthrough.
- **Discount Social Engineering Limitation**: A customer could theoretically be social-engineered via chat to enter a campaign code in the checkout UI that the LLM cannot directly invoke but could verbally suggest. While the backend validates campaign existence and active status on entry and re-verifies product eligibility before consent creation, this residual customer-action risk exists.
- **Test Mock-LLM Mode**: Test suites run with `MOCK_LLM=true` by default for fast, quota-free automated execution. The Phase 4 live demo recording must explicitly set `MOCK_LLM=false` (or omit it with a valid `GEMINI_API_KEY`) to ensure live Gemini model responses are recorded on camera.

## Blockers
None