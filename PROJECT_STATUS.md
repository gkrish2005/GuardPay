# Project Status

## Phase 1

- [ ] 1.1 Scaffolding (blocked: ngrok authtoken required for tunnel output check)
- [ ] 1.2 Database
- [ ] 1.3 Razorpay integration
- [ ] 1.4 Internal agent tools
- [ ] 1.5 Governance Engine
- [ ] 1.6 Revenue Agent
- [ ] 1.7 Minimal approval UI
- [ ] 1.8 Minimal audit trail UI
- [ ] 1.9 End-to-end integration test

## Current Task

1.1 — Project scaffolding (awaiting NGROK_AUTHTOKEN to complete tunnel output check)

## Tests

- `/health` local check: 200 OK
- ngrok tunnel: not verified (NGROK_AUTHTOKEN not configured)

## Blockers

- **ngrok authtoken required:** ngrok v3+ requires a free account authtoken. Add `NGROK_AUTHTOKEN` to `.env`, run `npm run tunnel`, then paste the tunnel URL into the Razorpay dashboard webhook config.
