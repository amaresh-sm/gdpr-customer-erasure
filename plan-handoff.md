# Private plan handoff

- Slug: `gdpr-customer-erasure`
- Task form: additive feature against the frozen PayFlow repository.
- Target band: Hard.
- Public entry points: `POST /v1/customers/:customerId/erasure-requests` and
  `GET /v1/erasure-requests/:requestId` through the API gateway.
- Reference note: the baseline has no privacy workflow. The solution branch adds a durable
  orchestrator and makes existing asynchronous consumers erasure-aware.
- Primary interaction: a delayed provider webhook or replayed event must finish its legitimate
  financial work without rebuilding erased PII.
- Candidate delta: the question branch removes the reference erasure implementation while keeping
  the product baseline, public data-governance policy, API contract, and ordinary tests.
- Agent traps: primary-row deletion; present-state-only purge; blanket cascade; consumer-only
  tombstone.
- Visible selection: existing PayFlow contract and regression tests, which remain green on the
  untouched candidate baseline.
- Hidden scenarios: broad cleanup, financial preservation, shared ownership, concurrency,
  idempotency, tenant isolation, dependency failure, restart/resume, delayed webhook, event replay,
  and post-completion queued work.
- Private design and acceptance matrix: `DESIGN.md`.
