# Private benchmark design: GDPR customer erasure

This file is evaluator-only. It must never appear in a candidate workspace.

## Provenance and target

- Product baseline: `payflow-platform-v1.0.0` at `a80300c`.
- Task shape: additive real-repository endpoint and durable workflow, not a planted single-line bug.
- Target difficulty: Hard, measured as a 5–20% full-pass rate using the maximum pass rate across
  the fresh-model panel.
- Primary non-local interaction: erasure completion crossed with delayed financial work and event
  replay. The financial operation must finish, but its old snapshot must not restore PII.

## Private PII and propagation inventory

| Owner/store | Location | Disposition | Resurrection path |
|---|---|---|---|
| Customer/PostgreSQL | `customers.customers` identity, external reference, metadata | delete | customer update outbox |
| Customer/PostgreSQL | addresses, contacts, payment-method refs | delete | none after customer is quiesced |
| Customer/PostgreSQL | import rows and imported MinIO object | delete when the object contains the subject | import object remains discoverable |
| Support/PostgreSQL | participants, authored messages, attachments, ticket subject | detach/redact; preserve survivor data | support outbox event |
| Payments/PostgreSQL | intent `customer_id`, payment-method id, description, customer snapshot | retain financial row; replace linkage and redact PII | delayed webhook reads snapshot |
| Payments/PostgreSQL | attempt request/response payloads | retain status/provider facts; redact subject values | operational inspection |
| Payments/PostgreSQL | captures and ledger | retain exactly | must never be cascaded |
| Payments/PostgreSQL | refunds email/reason, dispute evidence | retain financial facts; redact PII | delayed refund event |
| Payments/PostgreSQL | invoices, billing snapshot, line descriptions | retain totals; replace linkage and redact PII | invoice event/document |
| Platform/PostgreSQL | audit target/actor and JSON metadata | retain action/time; replace linkage and redact PII | none |
| Operations/PostgreSQL | outbox payload and customer aggregate id | retain envelope; redact/replace | publisher after erasure |
| Operations/PostgreSQL | jobs, provider webhooks, dead letters | retain operational facts; redact payloads | retry after erasure |
| Operations/PostgreSQL | idempotency response bodies | retain key/hash; redact response | API replay |
| Operations/PostgreSQL | analytics | retain aggregate facts; null identity and redact properties | event replay |
| Operations/PostgreSQL | notification preferences/history | delete | event replay |
| Operations/PostgreSQL | document manifests | retain retained-document facts; replace linkage/redact metadata; delete import manifests | document retry |
| Redis | customer document, activity hash, secondary values | delete subject keys and values | projection replay |
| OpenSearch | customer document | delete | customer event replay |
| MinIO | customer import | delete | none |
| MinIO | invoice and receipt JSON | retain financial body with redacted customer section | delayed document job |
| Kafka/Redpanda | bounded-retention historical events | no per-record rewrite; enforce replay suppression | fresh consumer group |
| Privacy/PostgreSQL | request context | temporary; remove PII before completion | workflow resume |
| Privacy/PostgreSQL | erased-subject marker | retain only UUIDs/status/timestamps | required suppression control |

## Frozen semantics

1. The internal customer UUID is removed from active business projections and replaced in retained
   financial records by a request-specific opaque UUID. The raw UUID may remain only in the minimal
   privacy suppression record.
2. Customer-authored support message bodies and attachments are redacted. Other authors' messages
   remain byte-for-byte identical except for an exact target PII canary embedded in shared text.
3. Invoice and receipt financial values remain. Their customer blocks are redacted and manifests
   receive the new checksum.
4. Completion requires all registered participants. A participant error produces `failed`, retains
   completed step checkpoints, and is retried without replaying completed destructive work.
5. An existing request is canonical for `(merchant_id, customer_id)`. Idempotency-key reuse for a
   different customer conflicts.
6. Unknown or cross-tenant customer IDs return 404 and do not create a request.
7. A tombstone is established before destructive work. Customer writes are quiesced and event
   consumers consult the marker before producing PII-bearing projections or notifications.
8. Kafka records, PostgreSQL WAL/backups, and disaster-recovery media are not scanned for literal
   canaries. Kafka is graded by deterministic replay consequences.

## Reference participant registry

The reference uses these ordered, individually checkpointed contracts:

1. `subject-quiescence`
2. `financial-records`
3. `object-storage`
4. `operational-records`
5. `derived-projections`
6. `customer-records`
7. `completion-verification`

The hidden verifier must not require these names or this ordering. Only final observable behavior
and public request state are graded.

## Acceptance matrix

| Scenario | Target must change | Must remain exact | Post-completion action |
|---|---|---|---|
| Normal broad topology | all mutable PII surfaces | financial values and unrelated subjects | ordinary read-path checks |
| Delayed payment webhook | payment snapshot/jobs/events/documents are PII-safe | capture and balanced ledger are created | release stored webhook |
| Historical replay | no search/cache/notification PII | financial tables unchanged | replay from offset zero with fresh group |
| Shared support | target participation/content removed | survivor messages and participant remain | query shared ticket |
| Duplicate/concurrent POST | one canonical request | no duplicate completion work | send distinct and repeated keys |
| Partial MinIO/OpenSearch outage | status never lies; retry converges | completed step checkpoints | restart dependency |
| Orchestrator restart | request resumes | no duplicated receipt or ledger posting | restart after observed partial state |
| Tenant isolation | no target mutation | other merchant byte-exact | use wrong merchant credential |
| Unknown subject | no request or non-privacy mutation | entire application state | submit random UUID |

## Synthesized partial solutions

- Primary-row deletion: deletes customer tables but leaves snapshots, projections, documents, and
  queued payloads.
- Comprehensive one-shot purge: cleans present state but old webhook/event/job delivery restores
  PII after completion.
- Blanket cascade: removes customer-linked payments/invoices/ledger or shared survivor content.
- Consumer-only tombstone: prevents new projections but leaves stored PII in active systems.

Each must be materialized and rejected during the later discriminator phase.

## Fairness audit and specification freeze — 2026-08-21

The recurring Sol misses for `payments.invoice_lines` and `operations.dead_letters` were audited
against the exact `git archive question/gdpr-customer-erasure` candidate workspace.

- **Invoice-line descriptions are discoverable.** The public invoice API accepts an arbitrary
  `description`, `apps/payment-service/src/invoices.ts` stores it verbatim in
  `payments.invoice_lines` and in the invoice object, and the schema exposes the column. The README
  explicitly requires correctness for arbitrary customer-supplied text. The retention policy says
  retained financial facts do not justify retaining embedded identity, and that PostgreSQL,
  embedded JSON, and MinIO documents must converge. Testing a customer name in an invoice-line
  description is therefore a representative instance of the public contract, not a private rule.
- **Dead-letter payloads are discoverable.** The retention policy explicitly includes dead letters
  in the completion boundary. The operations runbook names `operations.dead_letters`; the schema
  exposes its `payload` and `error` fields; and both the webhook and document workers visibly copy
  failed payloads into it. Testing pre-existing PII in those fields follows directly from the
  documented completion rule and production retry topology.
- The candidate export contains all of those clues and excludes `hidden_tests/`, `DESIGN.md`, and
  `calibration/` as intended.

Verdict: both expectations are fair, repository-discoverable, production-authentic, and already
covered by the public contract. No candidate-facing wording or hidden-verifier behavior was changed
after this audit. The specification and verifier are frozen at candidate commit `7f42ed4` and
reference commit `b7aa314` for the five-run provisional Sol calibration.

## Frozen-specification Sol calibration — 2026-08-21

Five independent `gpt-5.6-sol` attempts ran at medium reasoning from fresh exports of candidate
commit `7f42ed4`. The hidden suite was absent while each solution was produced and was copied in only
after the solution and visible checks were final. Every hidden score used a fresh Docker Compose
project and the frozen eight-scenario verifier.

| Attempt | Scenarios | Full solve | Principal misses |
|---|---:|---:|---|
| Sol 1 | 7/8 | no | pending asynchronous payload sanitation |
| Sol 2 | 6/8 | no | normal and pending cross-store sanitation |
| Sol 3 | 6/8 | no | invoice-line identity in normal and pending subjects |
| Sol 4 | 6/8 | no | invoice lines plus pending payment-attempt payloads |
| Sol 5 | 3/8 | no | orchestration timeout and downstream convergence |

The panel produced **0/5 full solves** and **28/40 scenario checks passed**. This is directional
evidence toward the `unsolvable` band, while the strong partial-score rate shows that capable
solutions routinely implement most of the distributed contract. The band remains **provisional**:
five attempts are below the `N >= 15` certification threshold, so the author target remains `hard`
and publication certification is blocked pending ten additional valid Sol attempts (or an explicit
benchmark-governance exception).
