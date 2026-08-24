# Project Status
## Phase 1
- [x] 1.1 Scaffolding
- [ ] 1.2 Database
- [ ] 1.3 Razorpay integration
- [ ] 1.4 Internal agent tools
- [ ] 1.5 Governance Engine
- [ ] 1.6 Revenue Agent
- [ ] 1.7 Minimal approval UI
- [ ] 1.8 Minimal audit trail UI
- [ ] 1.9 End-to-end integration test

## Current Task
1.2 — Core database schema

## Tests
- `/health` local check: 200 OK
- Tunnel: verified reachable, `/health` returns 200 via ngrok

## Notes
- Tunnel run manually via Homebrew-installed ngrok v3 CLI (`ngrok http 3000`), NOT via `npm run tunnel` / `scripts/tunnel.ts`. The npm `ngrok` package (v5-beta and v4.3.3) bundles an outdated v2 binary incompatible with ngrok's backend (ERR_NGROK_121). `scripts/tunnel.ts` is stale/unused.
- Razorpay API keys and webhook setup deliberately deferred until Task 1.3 is being actively tested.

## Blockers
None