import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { closeClients } from './lib/clients.js';
import { seedApiContractFixture, seedFixture, seedPartialCoreFixture, verifyApiContractCustomerUnchanged,
  type ApiContractFixture, type BenchmarkFixture } from './lib/fixture.js';
import { buildScoreReport, loadScoringManifest, scoringMaximums, type DiagnosticCheck, type FixtureDiagnostic } from './lib/scoring.js';
import { assertNoErasureViolations, assertReplaySideEffectsUnchanged, collectErasureViolations, historicalCustomerAggregateEvent,
  installTransientPaymentWriteFailure, publishHistoricalEvent, releaseDelayedWork, removeTransientPaymentWriteFailure,
  replayHistoricalPiiEvent, requestErasure, snapshotReplaySideEffects, waitForHistoricalConsumerOffsets, waitForHistoricalInbox,
  verifyAnonymousRetainedFinancialLink, verifyFinancialRetention, verifyFixtureCoverage, verifyMerchantCredentialsPreserved, verifyMerchantIdentityAndAdminPreserved,
  verifyPostErasureRefund, verifyPostErasureRefundFailureRetry, verifySecondaryMerchantCredentialsPreserved, verifySubjectUnchanged, verifySurvivorUntouched, verifyUnrelatedPaymentArtifactsPreserved,
  waitForCompletion, waitForStatus } from './lib/verifier.js';
import { api } from './lib/http.js';

interface TestResult { name: string; durationMs: number; error?: string | undefined }

interface ErasureResponse {
  id: string;
  status: 'pending' | 'processing' | 'failed' | 'completed';
  lastError?: string | null;
}

const results: TestResult[] = [];
const checks: DiagnosticCheck[] = [];
const fixtures: FixtureDiagnostic[] = [];
let fixture: BenchmarkFixture;
const rawWeightTotal = 8;
const scoringManifest = await loadScoringManifest();
const configuredMaximums = scoringMaximums(scoringManifest);
// A correct workflow completes well inside this bound. Keep the guard outside the
// individual polling helpers so any hung candidate participant is reported as a
// scenario failure rather than preventing later independent checks from running.
const scenarioTimeoutMs = Number(process.env.ERASURE_SCENARIO_TIMEOUT_MS ?? '90000');

function newlyIntroduced(previous: string[], current: string[]): string[] {
  const baseline = new Set(previous);
  return current.filter((violation) => !baseline.has(violation));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function observe(operation: () => Promise<void>): Promise<{ ok: boolean; evidence?: string | undefined }> {
  try {
    await operation();
    return { ok: true };
  } catch (error) {
    return { ok: false, evidence: errorText(error) };
  }
}

async function observeValue<T>(operation: () => Promise<T>): Promise<{ ok: boolean; value?: T; evidence?: string | undefined }> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, evidence: errorText(error) };
  }
}

function recordCheck(id: string, label: string, rawWeight: number, observed: { ok: boolean; evidence?: string | undefined },
                     eligible = true, ineligibleReason = 'a prerequisite safety check failed'): boolean {
  const maximum = configuredMaximums.get(id);
  if (maximum === undefined) throw new Error(`scoring manifest is missing check ${id}`);
  const declaredMaximum = Number((rawWeight / rawWeightTotal).toFixed(4));
  if (maximum !== declaredMaximum) {
    throw new Error(`scoring manifest weight mismatch for ${id}: manifest=${maximum}, verifier=${declaredMaximum}`);
  }
  if (!eligible) {
    checks.push({ id, label, maximum, earned: 0, state: 'blocked', evidence: ineligibleReason });
    return false;
  }
  checks.push({ id, label, maximum, earned: observed.ok ? maximum : 0,
    state: observed.ok ? 'pass' : 'fail', evidence: observed.evidence });
  return observed.ok;
}

function violationsFor(violations: string[], prefix: string): string[] {
  return violations.filter((violation) => violation.startsWith(prefix));
}

function noViolations(violations: string[]): { ok: boolean; evidence?: string | undefined } {
  return violations.length === 0 ? { ok: true } : { ok: false, evidence: violations.join('; ') };
}

function classifyNormalViolations(violations: string[]): Record<'relational' | 'payload' | 'redis' | 'search' | 'minio' | 'mailpit', string[]> {
  const output = { relational: [] as string[], payload: [] as string[], redis: [] as string[],
    search: [] as string[], minio: [] as string[], mailpit: [] as string[] };
  for (const violation of violations) {
    if (violation.startsWith('Redis ')) output.redis.push(violation);
    else if (violation.startsWith('OpenSearch ')) output.search.push(violation);
    else if (violation.startsWith('MinIO ')) output.minio.push(violation);
    else if (violation.startsWith('Mailpit ')) output.mailpit.push(violation);
    else if (violation.startsWith('PostgreSQL ') ||
      violation.startsWith('platform.audit_logs ') || violation.startsWith('operations.provider_webhooks ') ||
      /^[a-z_]+\.[a-z_]+ retained human PII/.test(violation)) output.payload.push(violation);
    else output.relational.push(violation);
  }
  return output;
}

async function test(name: string, operation: () => Promise<void>): Promise<void> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`scenario timed out after ${scenarioTimeoutMs}ms`)), scenarioTimeoutMs);
      }),
    ]);
    results.push({ name, durationMs: Date.now() - started });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    results.push({ name, durationMs: Date.now() - started, error: message });
    process.stdout.write(`FAIL ${name}: ${message}\n`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

async function writeReport(): Promise<void> {
  const failures = results.filter((result) => result.error).length;
  const cases = results.map((result) => `  <testcase classname="payflow.gdpr" name="${escapeXml(result.name)}" time="${(result.durationMs / 1000).toFixed(3)}">${
    result.error ? `\n    <failure message="hidden verification failed">${escapeXml(result.error)}</failure>\n  ` : ''}</testcase>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="payflow-gdpr-erasure" tests="${results.length}" failures="${failures}">\n${cases}\n</testsuite>\n`;
  await writeFile(process.env.JUNIT_PATH ?? 'junit.xml', xml, 'utf8');
}

async function writeScoreReport(): Promise<void> {
  const fixtureResult = results.find((result) => result.name === 'deterministic fixture provisions cross-store PII');
  const blocked = Boolean(fixtureResult?.error);
  const report = buildScoreReport(
    checks,
    fixtures,
    !blocked,
    !blocked && results.length === 13 && results.every((result) => !result.error),
    blocked ? 'full cross-store fixture was unavailable; only independently observed checks are credited' : undefined,
  );
  await writeFile(process.env.ERASURE_SCORE_PATH ?? 'hidden.score.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

/** Runs only API checks that can be proven without a payment, notification, or external-store fixture. */
async function runIndependentApiChecks(apiFixture: ApiContractFixture): Promise<void> {
  await test('independent API contract checks', async () => {
    const unknown = randomUUID();
    const unknownCustomer = await observe(async () => {
      await api(apiFixture.merchantKey, `/v1/customers/${unknown}/erasure-requests`, {
        method: 'POST', expected: 404, headers: { 'idempotency-key': `unknown-${apiFixture.slot}` },
      });
    });
    recordCheck('api.unknown_customer', 'Unknown customer is tenant-safe', 0.1, unknownCustomer);

    const crossTenantPost = await observe(async () => {
      await api(apiFixture.otherMerchantKey, `/v1/customers/${apiFixture.normalCustomerId}/erasure-requests`, {
        method: 'POST', expected: 404, headers: { 'idempotency-key': `cross-tenant-${apiFixture.slot}` },
      });
      await verifyApiContractCustomerUnchanged(apiFixture);
    });
    recordCheck('api.cross_tenant_rejection', 'Cross-tenant customer is hidden without mutation', 0.1, crossTenantPost);

    const winningKey = `erase-canonical-${apiFixture.slot}`;
    let requestId = '';
    const concurrent = await observe(async () => {
      const responses = await Promise.all([winningKey, winningKey, winningKey].map(async (key) => await api<ErasureResponse>(
        apiFixture.merchantKey, `/v1/customers/${apiFixture.normalCustomerId}/erasure-requests`,
        { method: 'POST', expected: 202, headers: { 'idempotency-key': key } },
      )));
      const ids = new Set(responses.map((response) => response.body.id));
      if (ids.size !== 1) throw new Error('concurrent erasure requests created multiple workflows');
      requestId = responses[0]!.body.id;
    });
    const concurrentOk = recordCheck('api.concurrent_idempotency', 'Concurrent same-key requests share one workflow', 0.2, concurrent);

    const alternate = await observe(async () => {
      const response = await api<ErasureResponse>(apiFixture.merchantKey,
        `/v1/customers/${apiFixture.normalCustomerId}/erasure-requests`,
        { method: 'POST', expected: 202, headers: { 'idempotency-key': `erase-alternate-${apiFixture.slot}` } });
      if (response.body.id !== requestId) throw new Error('alternate key created a second customer workflow');
    });
    recordCheck('api.customer_deduplication', 'Alternate key reuses the customer workflow', 0.15,
      alternate, concurrentOk, 'concurrent request did not yield a canonical request ID');

    const repeated = await observe(async () => {
      const response = await api<ErasureResponse>(apiFixture.merchantKey,
        `/v1/customers/${apiFixture.normalCustomerId}/erasure-requests`,
        { method: 'POST', expected: 202, headers: { 'idempotency-key': winningKey } });
      if (response.body.id !== requestId) throw new Error('idempotent retry changed request ID');
    });
    recordCheck('api.key_reuse', 'Idempotent retry returns the original request', 0.1,
      repeated, concurrentOk, 'concurrent request did not yield a canonical request ID');

    const conflictingReuse = await observe(async () => {
      await api(apiFixture.merchantKey, `/v1/customers/${apiFixture.survivorCustomerId}/erasure-requests`, {
        method: 'POST', expected: 409, headers: { 'idempotency-key': winningKey },
      });
    });
    recordCheck('api.key_conflict', 'Key reuse for another customer is rejected', 0.1, conflictingReuse);
    if (![unknownCustomer.ok, crossTenantPost.ok, concurrentOk, alternate.ok, repeated.ok, conflictingReuse.ok].every(Boolean)) {
      throw new Error('one or more independent API checks failed');
    }
  });
}

async function partialFixture(label: string, slot: string): Promise<BenchmarkFixture | undefined> {
  let value: BenchmarkFixture | undefined;
  await test(`partial ${label} fixture provisions isolated subjects`, async () => {
    value = await seedPartialCoreFixture(`partial-${label}-${randomUUID().slice(0, 12)}`);
  });
  const result = results.find((item) => item.name === `partial ${label} fixture provisions isolated subjects`);
  fixtures.push({ id: `partial-${label}`, state: value ? 'ready' : 'failed', evidence: result?.error });
  return value;
}

async function runPartialDomainCells(slot: string): Promise<void> {
  const apiFixture = await (async () => {
    let value: ApiContractFixture | undefined;
    await test('minimal API fixture provisions isolated customer records', async () => {
      value = await seedApiContractFixture(`${slot}-api`);
    });
    const result = results.find((item) => item.name === 'minimal API fixture provisions isolated customer records');
    fixtures.push({ id: 'api-contract', state: value ? 'ready' : 'failed', evidence: result?.error });
    return value;
  })();
  if (apiFixture) await runIndependentApiChecks(apiFixture);

  const normalFixture = await partialFixture('normal', slot);
  if (normalFixture) {
    await test('partial normal erasure checks', async () => {
      let requestId = '';
      const accepted = await observe(async () => {
        requestId = await requestErasure(normalFixture.merchantKey, normalFixture.normal.customerId, `normal-${normalFixture.slot}`);
      });
      const completed = accepted.ok ? await observe(async () => { await waitForCompletion(normalFixture.merchantKey, requestId); })
        : { ok: false, evidence: accepted.evidence };
      const violations = completed.ok ? await observeValue(async () => collectErasureViolations(normalFixture, normalFixture.normal))
        : { ok: false, evidence: completed.evidence };
      // A public completed status is meaningful only when the active-store
      // verification immediately following it is clean. Keep other cells
      // independently observable so this failure does not mask their results.
      const truthfulCompletion = completed.ok && violations.ok
        ? noViolations(violations.value as unknown as string[])
        : { ok: false, evidence: violations.evidence ?? completed.evidence };
      recordCheck('workflow.completed', 'Request reaches completed only after active-store convergence', 0.25, truthfulCompletion);
      const grouped = violations.ok ? classifyNormalViolations(violations.value as unknown as string[]) : undefined;
      const normalCheck = (id: string, label: string, weight: number, key: keyof NonNullable<typeof grouped>) => {
        const observed = grouped ? noViolations(grouped[key]) : { ok: false, evidence: violations.evidence };
        recordCheck(id, label, weight, observed, completed.ok, 'normal erasure did not complete safely');
      };
      normalCheck('normal.postgres_relational', 'Primary relational records are removed or rekeyed', 0.3, 'relational');
      normalCheck('normal.postgres_payloads', 'Embedded and operational PostgreSQL PII is redacted', 0.8, 'payload');
      normalCheck('normal.redis', 'Redis no longer contains subject PII', 0.15, 'redis');
      normalCheck('normal.opensearch', 'OpenSearch no longer contains subject PII', 0.15, 'search');
      normalCheck('normal.minio', 'MinIO no longer contains subject PII', 0.25, 'minio');
      recordCheck('normal.mailpit', 'Mailpit no longer contains subject PII', 0.25,
        grouped ? noViolations(grouped.mailpit) : { ok: false, evidence: violations.evidence },
        completed.ok && (normalFixture.capabilities?.normalMailpit ?? true),
        'normal Mailpit fixture delivery was not established');
    });
  }

  const financialFixture = await partialFixture('financial', slot);
  if (financialFixture) {
    await test('partial financial checks', async () => {
      let requestId = '';
      const accepted = await observe(async () => {
        requestId = await requestErasure(financialFixture.merchantKey, financialFixture.normal.customerId, `financial-${financialFixture.slot}`);
      });
      const completed = accepted.ok ? await observe(async () => { await waitForCompletion(financialFixture.merchantKey, requestId); })
        : { ok: false, evidence: accepted.evidence };
      const violations = completed.ok ? await observeValue(async () => collectErasureViolations(financialFixture, financialFixture.normal))
        : { ok: false, evidence: completed.evidence };
      const clean = completed.ok && violations.ok && (violations.value as unknown as string[]).length === 0;
      recordCheck('financial.retention', 'Financial facts remain intact after a successful erasure', 0.6,
        clean ? await observe(async () => { await verifyFinancialRetention(financialFixture); }) : { ok: false, evidence: 'financial subject erasure was not fully verified' }, clean,
        'financial subject erasure was not fully verified');
      recordCheck('financial.anonymous_retained_link', 'Retained financial links are anonymous and support a private later refund', 0.1,
        clean ? await observe(async () => { await verifyAnonymousRetainedFinancialLink(financialFixture); }) : { ok: false, evidence: 'financial subject erasure was not fully verified' }, clean,
        'financial subject erasure was not fully verified');
      recordCheck('financial.post_erasure_refund', 'A later refund remains balanced without restoring customer identity', 0.4,
        await observe(async () => { await verifyPostErasureRefund(financialFixture); }));
      recordCheck('financial.post_erasure_refund_failure_retry', 'A failed post-erasure refund stays private and a later retry remains balanced', 0.2,
        await observe(async () => { await verifyPostErasureRefundFailureRetry(financialFixture); }));
    });
  }

  const scopeFixture = await partialFixture('scope', slot);
  if (scopeFixture) {
    await test('partial scope-preservation checks', async () => {
      let requestId = '';
      const accepted = await observe(async () => {
        requestId = await requestErasure(scopeFixture.merchantKey, scopeFixture.normal.customerId, `scope-${scopeFixture.slot}`);
      });
      const completed = accepted.ok ? await observe(async () => { await waitForCompletion(scopeFixture.merchantKey, requestId); })
        : { ok: false, evidence: accepted.evidence };
      const eligible = completed.ok;
      recordCheck('scope.unrelated_customer_and_shared_record', 'Unrelated customer and shared record remain unchanged', 0.2,
        eligible ? await observe(async () => { await verifySurvivorUntouched(scopeFixture); }) : { ok: false, evidence: completed.evidence }, eligible,
        'scope erasure did not complete safely');
      recordCheck('scope.merchant_identity_and_admin', 'Merchant identity and administrator remain unchanged', 0.1,
        eligible ? await observe(async () => { await verifyMerchantIdentityAndAdminPreserved(scopeFixture); }) : { ok: false, evidence: completed.evidence }, eligible,
        'scope erasure did not complete safely');
      recordCheck('scope.merchant_credentials', 'Independent merchant credential remains active and usable', 0.1,
        eligible ? await observe(async () => { await verifySecondaryMerchantCredentialsPreserved(scopeFixture); }) : { ok: false, evidence: completed.evidence }, eligible,
        'scope erasure did not complete safely');
      recordCheck('scope.unrelated_payment_notification_document', 'Unrelated payment, notification, and receipt remain unchanged', 0.2,
        { ok: false, evidence: 'unrelated payment notification fixture was not established' }, false,
        'unrelated payment notification fixture was not established');
    });
  }

  const asyncFixture = await partialFixture('async', slot);
  if (asyncFixture) {
    await test('partial asynchronous, delayed-work, and replay checks', async () => {
      const retryKey = `async-${asyncFixture.slot}`;
      let delayedRequest = '';
      const created = await observe(async () => {
        await installTransientPaymentWriteFailure(asyncFixture.delayed.paymentId);
        delayedRequest = await requestErasure(asyncFixture.merchantKey, asyncFixture.delayed.customerId, retryKey);
      });
      recordCheck('async.request_accepted', 'Delayed-subject erasure request is accepted', 0.1, created);
      const failed = created.ok ? await observe(async () => {
        const response = await waitForStatus(asyncFixture.merchantKey, delayedRequest, 'failed');
        if (!response.lastError || response.lastError.includes(asyncFixture.delayed.email) || response.lastError.includes(asyncFixture.delayed.name) || response.lastError.includes(asyncFixture.delayed.canary)) {
          throw new Error('failed request did not expose a safe operational error code');
        }
      }) : { ok: false, evidence: created.evidence };
      await removeTransientPaymentWriteFailure();
      const completed = failed.ok ? await observe(async () => {
        const retried = await requestErasure(asyncFixture.merchantKey, asyncFixture.delayed.customerId, retryKey);
        if (retried !== delayedRequest) throw new Error('retry created a second erasure workflow');
        await waitForCompletion(asyncFixture.merchantKey, delayedRequest);
      }) : { ok: false, evidence: failed.evidence };
      const gate = { ok: failed.ok && completed.ok, evidence: completed.evidence ?? failed.evidence };
      recordCheck('async.completion_gate', 'Participant failure prevents completion and the same request converges when retried', 0.3, gate, created.ok,
        'delayed-subject erasure request was not accepted');
      const delayedSnapshot = gate.ok ? await observeValue(async () => collectErasureViolations(asyncFixture, asyncFixture.delayed)) : { ok: false, evidence: gate.evidence };
      const delayedClean = delayedSnapshot.ok
        ? noViolations(delayedSnapshot.value as unknown as string[])
        : { ok: false, evidence: delayedSnapshot.evidence };
      recordCheck('async.pending_payloads', 'Pending work and its payloads are fully sanitized', 0.8, delayedClean, gate.ok,
        'delayed-subject erasure did not complete');
      const delayedViolations = delayedSnapshot.ok ? delayedSnapshot.value as unknown as string[] : [];
      const release = delayedClean.ok ? await observe(async () => { await releaseDelayedWork(asyncFixture); }) : { ok: false, evidence: delayedClean.evidence };
      recordCheck('delayed.work_processes', 'Delayed work completes with correct financial processing', 0.4, release, delayedClean.ok,
        'delayed subject was not clean before delayed work released');
      const afterRelease = release.ok ? await observeValue(async () => collectErasureViolations(asyncFixture, asyncFixture.delayed)) : { ok: false, evidence: release.evidence };
      const introduced = release.ok && afterRelease.ok ? noViolations(newlyIntroduced(delayedViolations, afterRelease.value as unknown as string[])) : { ok: false, evidence: afterRelease.evidence ?? release.evidence };
      recordCheck('delayed.no_reintroduction', 'Delayed work does not reintroduce PII', 0.6, introduced, release.ok,
        'delayed work could not be safely evaluated');
      const replay = introduced.ok ? await observe(async () => { await replayHistoricalPiiEvent(asyncFixture); }) : { ok: false, evidence: introduced.evidence };
      recordCheck('replay.consumed', 'Historical event is safely consumed', 0.4, replay, introduced.ok,
        'delayed-work safety was not established');
      const afterReplay = replay.ok ? await observeValue(async () => collectErasureViolations(asyncFixture, asyncFixture.delayed)) : { ok: false, evidence: replay.evidence };
      const replaySafe = replay.ok && afterReplay.ok ? noViolations(newlyIntroduced(afterRelease.ok ? afterRelease.value as unknown as string[] : delayedViolations, afterReplay.value as unknown as string[])) : { ok: false, evidence: afterReplay.evidence ?? replay.evidence };
      recordCheck('replay.no_reintroduction', 'Historical replay does not restore PII', 0.6, replaySafe, replay.ok,
        'historical replay could not be safely evaluated');
      recordCheck('security.survivor_unchanged_after_delayed_replay', 'Unrelated shared record remains unchanged after delayed work and replay', 0,
        replaySafe.ok ? await observe(async () => { await verifySurvivorUntouched(asyncFixture); }) : { ok: false, evidence: replaySafe.evidence }, replaySafe.ok,
        'replay safety was not established');
    });
  }
}

const slot = process.env.ERASURE_TEST_SLOT ?? `${Date.now()}-${process.pid}`;
try {
  await test('deterministic fixture provisions cross-store PII', async () => {
    fixture = await seedFixture(slot);
    await verifyFixtureCoverage(fixture);
  });
  const fixtureResult = results.find((result) => result.name === 'deterministic fixture provisions cross-store PII');
  fixtures.push({ id: 'full-cross-store', state: fixtureResult?.error ? 'failed' : 'ready', evidence: fixtureResult?.error });
  if (fixture!) {
    let normalRequest = '';
    await test('request contract is tenant-safe, concurrent, and idempotent', async () => {
      const unknown = randomUUID();
      const unknownCustomer = await observe(async () => {
        await api(fixture.merchantKey, `/v1/customers/${unknown}/erasure-requests`, {
          method: 'POST', expected: 404, headers: { 'idempotency-key': `unknown-${slot}` },
        });
      });
      recordCheck('api.unknown_customer', 'Unknown customer is tenant-safe', 0.1, unknownCustomer);
      const crossTenantPost = await observe(async () => {
        await api(fixture.otherMerchantKey, `/v1/customers/${fixture.normal.customerId}/erasure-requests`, {
          method: 'POST', expected: 404, headers: { 'idempotency-key': `cross-tenant-${slot}` },
        });
        await verifySubjectUnchanged(fixture, fixture.normal);
      });

      const winningKey = `erase-canonical-${slot}`;
      let requestId = '';
      const concurrent = await observe(async () => {
        const responses = await Promise.all([winningKey, winningKey, winningKey].map(async (key) => await api<ErasureResponse>(
          fixture.merchantKey, `/v1/customers/${fixture.normal.customerId}/erasure-requests`,
          { method: 'POST', expected: 202, headers: { 'idempotency-key': key } },
        )));
        const ids = new Set(responses.map((response) => response.body.id));
        if (ids.size !== 1) throw new Error('concurrent erasure requests created multiple workflows');
        requestId = responses[0]!.body.id;
      });
      const concurrentOk = recordCheck('api.concurrent_idempotency', 'Concurrent same-key requests share one workflow', 0.2, concurrent);
      normalRequest = requestId;
      const crossTenantRead = await observe(async () => {
        await api(fixture.otherMerchantKey, `/v1/erasure-requests/${requestId}`, { expected: 404 });
      });
      const crossTenant = {
        ok: crossTenantPost.ok && crossTenantRead.ok,
        evidence: crossTenantPost.evidence ?? crossTenantRead.evidence,
      };
      recordCheck('api.cross_tenant', 'Cross-tenant customer and request are hidden without mutation', 0.1, crossTenant);
      const alternate = await observe(async () => {
        const response = await api<ErasureResponse>(fixture.merchantKey,
          `/v1/customers/${fixture.normal.customerId}/erasure-requests`,
          { method: 'POST', expected: 202, headers: { 'idempotency-key': `erase-alternate-${slot}` } });
        if (response.body.id !== requestId) throw new Error('alternate key created a second customer workflow');
      });
      const alternateOk = recordCheck('api.customer_deduplication', 'Alternate key reuses the customer workflow', 0.15,
        alternate, concurrentOk, 'concurrent request did not yield a canonical request ID');
      const repeated = await observe(async () => {
        const response = await api<ErasureResponse>(fixture.merchantKey,
          `/v1/customers/${fixture.normal.customerId}/erasure-requests`,
          { method: 'POST', expected: 202, headers: { 'idempotency-key': winningKey } });
        if (response.body.id !== requestId) throw new Error('idempotent retry changed request ID');
      });
      recordCheck('api.key_reuse', 'Idempotent retry returns the original request', 0.1,
        repeated, concurrentOk, 'concurrent request did not yield a canonical request ID');
      const conflictingReuse = await observe(async () => {
        await api(fixture.merchantKey, `/v1/customers/${fixture.survivor.customerId}/erasure-requests`, {
          method: 'POST', expected: 409, headers: { 'idempotency-key': winningKey },
        });
      });
      recordCheck('api.key_conflict', 'Key reuse for another customer is rejected', 0.1, conflictingReuse);
      const completion = await observe(async () => { await waitForCompletion(fixture.merchantKey, requestId); });
      const activeStoreClean = completion.ok
        ? await observe(async () => { assertNoErasureViolations(await collectErasureViolations(fixture, fixture.normal)); })
        : { ok: false, evidence: completion.evidence };
      const completionOk = recordCheck('workflow.completed', 'Request reaches completed only after active-store convergence', 0.25,
        activeStoreClean, concurrentOk && alternateOk, 'a canonical request was not established');
      if (![unknownCustomer.ok, crossTenant.ok, concurrentOk, alternateOk, repeated.ok, conflictingReuse.ok, completionOk].every(Boolean)) {
        throw new Error('one or more request-contract checks failed');
      }
    });
    await test('normal subject PII is absent from every active store', async () => {
      const violations = await collectErasureViolations(fixture, fixture.normal);
      const grouped = classifyNormalViolations(violations);
      recordCheck('normal.postgres_relational', 'Primary relational records are removed or rekeyed', 0.3, noViolations(grouped.relational));
      recordCheck('normal.postgres_payloads', 'Embedded and operational PostgreSQL PII is redacted', 0.8, noViolations(grouped.payload));
      recordCheck('normal.redis', 'Redis no longer contains subject PII', 0.15, noViolations(grouped.redis));
      recordCheck('normal.opensearch', 'OpenSearch no longer contains subject PII', 0.15, noViolations(grouped.search));
      recordCheck('normal.minio', 'MinIO no longer contains subject PII', 0.25, noViolations(grouped.minio));
      recordCheck('normal.mailpit', 'Mailpit no longer contains subject PII', 0.25, noViolations(grouped.mailpit),
        fixture.capabilities?.normalMailpit ?? true, 'normal Mailpit fixture delivery was not established');
      assertNoErasureViolations(violations, 'normal erasure');
    });
    await test('financial truth and shared unrelated records are retained', async () => {
      const financial = await observe(async () => { await verifyFinancialRetention(fixture); });
      const normalClean = checks.filter((check) => check.id.startsWith('normal.')).every((check) => check.state === 'pass');
      recordCheck('financial.retention', 'Financial facts remain intact after a successful erasure', 0.6, financial,
        normalClean, 'normal-subject PII was not fully removed');
      if (!financial.ok) throw new Error(financial.evidence);
    });
    await test('retained financial links remain anonymous and support a later private refund', async () => {
      const normalClean = checks.filter((check) => check.id.startsWith('normal.')).every((check) => check.state === 'pass');
      if (!normalClean) {
        recordCheck('financial.anonymous_retained_link',
          'Retained financial links are anonymous and support a private later refund', 0.1,
          { ok: false }, false, 'normal-subject PII was not fully removed');
        return;
      }
      const anonymousLink = await observe(async () => { await verifyAnonymousRetainedFinancialLink(fixture); });
      recordCheck('financial.anonymous_retained_link',
        'Retained financial links are anonymous and support a private later refund', 0.1, anonymousLink);
      if (!anonymousLink.ok) throw new Error(anonymousLink.evidence);
    });
    await test('post-erasure refunds preserve financial correctness without restoring PII', async () => {
      const refund = await observe(async () => { await verifyPostErasureRefund(fixture); });
      recordCheck('financial.post_erasure_refund',
        'A later refund remains balanced without restoring customer identity', 0.4, refund);
      if (!refund.ok) throw new Error(refund.evidence);
    });
    await test('failed post-erasure refunds remain private and retry safely', async () => {
      const refundRetry = await observe(async () => { await verifyPostErasureRefundFailureRetry(fixture); });
      recordCheck('financial.post_erasure_refund_failure_retry',
        'A failed post-erasure refund stays private and a later retry remains balanced', 0.2, refundRetry);
      if (!refundRetry.ok) throw new Error(refundRetry.evidence);
    });
    await test('merchant credentials remain usable after customer erasure', async () => {
      const credentials = await observe(async () => { await verifyMerchantCredentialsPreserved(fixture); });
      recordCheck('security.merchant_credentials_preserved', 'Merchant API credential remains active and unchanged', 0, credentials);
      if (!credentials.ok) throw new Error(credentials.evidence);
    });
    await test('customer erasure preserves unrelated customer and merchant-platform survivors', async () => {
      const shared = await observe(async () => { await verifySurvivorUntouched(fixture); });
      const merchant = await observe(async () => { await verifyMerchantIdentityAndAdminPreserved(fixture); });
      const credentials = await observe(async () => { await verifySecondaryMerchantCredentialsPreserved(fixture); });
      const artifacts = fixture.platformSurvivor.payment
        ? await observe(async () => { await verifyUnrelatedPaymentArtifactsPreserved(fixture); })
        : { ok: false, evidence: 'unrelated payment fixture was not established' };
      recordCheck('scope.unrelated_customer_and_shared_record', 'Unrelated customer and shared record remain unchanged', 0.2, shared);
      recordCheck('scope.merchant_identity_and_admin', 'Merchant identity and administrator remain unchanged', 0.1, merchant);
      recordCheck('scope.merchant_credentials', 'Independent merchant credential remains active and usable', 0.1, credentials);
      recordCheck('scope.unrelated_payment_notification_document', 'Unrelated payment, notification, and receipt remain unchanged', 0.2,
        artifacts, fixture.platformSurvivor.payment !== null, 'unrelated payment fixture was not established');
      if (![shared.ok, merchant.ok, credentials.ok, artifacts.ok].every(Boolean)) {
        throw new Error([shared.evidence, merchant.evidence, credentials.evidence, artifacts.evidence].filter(Boolean).join('; '));
      }
    });
    let delayedRequest = '';
    let delayedViolations: string[] = [];
    await test('failed erasure retries safely and pending asynchronous work is sanitized before completion', async () => {
      const retryKey = `delayed-${slot}`;
      const created = await observe(async () => {
        await installTransientPaymentWriteFailure(fixture.delayed.paymentId);
        delayedRequest = await requestErasure(fixture.merchantKey, fixture.delayed.customerId, retryKey);
      });
      const createdOk = recordCheck('async.request_accepted', 'Delayed-subject erasure request is accepted', 0.1, created);
      const failed = created.ok ? await observe(async () => {
        const response = await waitForStatus(fixture.merchantKey, delayedRequest, 'failed');
        if (!response.lastError || response.lastError.includes(fixture.delayed.email) ||
          response.lastError.includes(fixture.delayed.name) || response.lastError.includes(fixture.delayed.canary)) {
          throw new Error('failed request did not expose a safe operational error code');
        }
      }) : { ok: false, evidence: created.evidence };
      await removeTransientPaymentWriteFailure();
      const completed = failed.ok ? await observe(async () => {
        const retried = await requestErasure(fixture.merchantKey, fixture.delayed.customerId, retryKey);
        if (retried !== delayedRequest) throw new Error('retry created a second erasure workflow');
        await waitForCompletion(fixture.merchantKey, delayedRequest);
      }) : { ok: false, evidence: failed.evidence };
      const completionGate = {
        ok: failed.ok && completed.ok,
        evidence: completed.evidence ?? failed.evidence,
      };
      const completedOk = recordCheck('async.completion_gate',
        'Participant failure prevents completion and the same request converges when retried', 0.3,
        completionGate, createdOk, 'the delayed-subject erasure request was not accepted');
      // Stop this scenario at a failed request/completion. Collecting cross-store evidence after
      // an incomplete retry could let background work alter later delayed/replay observations.
      if (!created.ok || !failed.ok || !completed.ok) {
        recordCheck('async.pending_payloads', 'Pending work and its payloads are fully sanitized', 0.8,
          { ok: false, evidence: completed.evidence ?? created.evidence }, false,
          'the delayed-subject erasure did not complete');
        throw new Error([created.evidence, completed.evidence].filter(Boolean).join('; ') || 'pending-work verification failed');
      }
      const delayedSnapshot = await collectErasureViolations(fixture, fixture.delayed);
      const delayedClean = noViolations(delayedSnapshot);
      recordCheck('async.pending_payloads', 'Pending work and its payloads are fully sanitized', 0.8, delayedClean,
        completedOk, 'the delayed-subject erasure did not complete');
      delayedViolations = delayedSnapshot;
      if (!delayedClean.ok) throw new Error(delayedClean.evidence ?? 'pending-work verification failed');
    });
    await test('delayed webhook and document work cannot reintroduce PII', async () => {
      const release = await observe(async () => { await releaseDelayedWork(fixture); });
      const delayedClean = checks.find((check) => check.id === 'async.pending_payloads')?.state === 'pass';
      const releaseOk = recordCheck('delayed.work_processes', 'Delayed work completes with correct financial processing', 0.4,
        release, delayedClean, 'the delayed subject was not clean before delayed work released');
      // Do not inspect or advance the binary baseline if the release itself failed; this is the
      // same ordering as the original verifier, while the weighted ledger records the failure.
      const current = release.ok ? await collectErasureViolations(fixture, fixture.delayed) : [];
      const introduced = release.ok ? noViolations(newlyIntroduced(delayedViolations, current))
        : { ok: false, evidence: release.evidence };
      recordCheck('delayed.no_reintroduction', 'Delayed work does not reintroduce PII', 0.6, introduced,
        delayedClean && releaseOk, 'delayed work could not be safely evaluated after incomplete erasure');
      if (release.ok) delayedViolations = current;
      if (!release.ok || !introduced.ok) throw new Error([release.evidence, introduced.evidence].filter(Boolean).join('; ') || 'delayed-work verification failed');
    });
    await test('historical event replay is suppressed by durable erasure state', async () => {
      let replayEvent: Awaited<ReturnType<typeof replayHistoricalPiiEvent>> | undefined;
      const replay = await observe(async () => { replayEvent = await replayHistoricalPiiEvent(fixture); });
      const delayedSafe = checks.find((check) => check.id === 'delayed.no_reintroduction')?.state === 'pass';
      const replayOk = recordCheck('replay.consumed', 'Historical event is safely consumed', 0.4, replay,
        delayedSafe, 'delayed-work safety was not established');
      let current = replay.ok ? await collectErasureViolations(fixture, fixture.delayed) : [];
      const introduced = replay.ok ? noViolations(newlyIntroduced(delayedViolations, current))
        : { ok: false, evidence: replay.evidence };
      let replaySafe = introduced;
      if (replay.ok && replayEvent) {
        const beforeDuplicate = await snapshotReplaySideEffects(fixture, replayEvent);
        const duplicatePosition = await publishHistoricalEvent(replayEvent);
        await waitForHistoricalConsumerOffsets(duplicatePosition, ['payflow-projections-v1', 'payflow-notifications-v1']);
        await waitForHistoricalInbox(replayEvent.eventId, ['projection-worker', 'notification-worker']);
        const afterDuplicate = await snapshotReplaySideEffects(fixture, replayEvent);
        assertReplaySideEffectsUnchanged(beforeDuplicate, afterDuplicate);

        const aggregateEvent = historicalCustomerAggregateEvent(fixture);
        const aggregatePosition = await publishHistoricalEvent(aggregateEvent);
        await waitForHistoricalInbox(aggregateEvent.eventId, ['projection-worker']);
        await waitForHistoricalConsumerOffsets(aggregatePosition, ['payflow-projections-v1']);
        current = await collectErasureViolations(fixture, fixture.delayed);
        replaySafe = noViolations(newlyIntroduced(delayedViolations, current));
      }
      recordCheck('replay.no_reintroduction', 'Historical replay does not restore PII', 0.6, replaySafe,
        delayedSafe && replayOk, 'historical replay could not be safely evaluated');
      if (replay.ok) delayedViolations = current;
      if (!replay.ok || !replaySafe.ok) throw new Error([replay.evidence, replaySafe.evidence].filter(Boolean).join('; ') || 'replay verification failed');
    });
    await test('survivor remains unchanged after replay and delayed work', async () => {
      const survivor = await observe(async () => { await verifySurvivorUntouched(fixture); });
      const replaySafe = checks.find((check) => check.id === 'replay.no_reintroduction')?.state === 'pass';
      recordCheck('security.survivor_unchanged_after_delayed_replay', 'Unrelated shared record remains unchanged after delayed work and replay', 0, survivor,
        replaySafe, 'replay safety was not established');
      if (!survivor.ok) throw new Error(survivor.evidence);
    });
  } else {
    await runPartialDomainCells(slot);
  }
} finally {
  await writeReport();
  await writeScoreReport();
  await closeClients();
}

if (results.some((result) => result.error)) process.exitCode = 1;
