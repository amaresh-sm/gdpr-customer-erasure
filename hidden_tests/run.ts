import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { closeClients } from './lib/clients.js';
import { seedFixture, type BenchmarkFixture } from './lib/fixture.js';
import { assertNoErasureViolations, collectErasureViolations, installTransientPaymentWriteFailure,
  releaseDelayedWork, removeTransientPaymentWriteFailure, replayHistoricalPiiEvent, requestErasure,
  verifyFinancialRetention, verifyFixtureCoverage, verifySubjectUnchanged, verifySurvivorUntouched,
  waitForCompletion, waitForStatus } from './lib/verifier.js';
import { api } from './lib/http.js';

interface TestResult { name: string; durationMs: number; error?: string | undefined }
type CheckState = 'pass' | 'fail' | 'blocked';

interface DiagnosticCheck {
  id: string;
  label: string;
  maximum: number;
  earned: number;
  state: CheckState;
  evidence?: string | undefined;
}

interface ScoreReport {
  schema_version: 1;
  state: 'complete' | 'blocked';
  hard_pass: boolean;
  earned: number | null;
  maximum: 8;
  checks: DiagnosticCheck[];
  blocked_reason?: string | undefined;
}

interface ErasureResponse {
  id: string;
  status: 'pending' | 'processing' | 'failed' | 'completed';
  lastError?: string | null;
}

const results: TestResult[] = [];
const checks: DiagnosticCheck[] = [];
let fixture: BenchmarkFixture;
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

function recordCheck(id: string, label: string, maximum: number, observed: { ok: boolean; evidence?: string | undefined },
                     eligible = true, ineligibleReason = 'a prerequisite safety check failed'): boolean {
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
    else if (violation.startsWith('PostgreSQL ') || /^[a-z_]+\.[a-z_]+ retained human PII/.test(violation)) output.payload.push(violation);
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
  const report: ScoreReport = blocked
    ? { schema_version: 1, state: 'blocked', hard_pass: false, earned: null, maximum: 8, checks,
      blocked_reason: 'fixture provisioning failed; candidate score is not comparable' }
    : { schema_version: 1, state: 'complete', hard_pass: results.length === 8 && results.every((result) => !result.error),
      earned: Number(checks.reduce((total, check) => total + check.earned, 0).toFixed(2)), maximum: 8, checks };
  await writeFile(process.env.ERASURE_SCORE_PATH ?? 'hidden.score.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

const slot = process.env.ERASURE_TEST_SLOT ?? `${Date.now()}-${process.pid}`;
try {
  await test('deterministic fixture provisions cross-store PII', async () => {
    fixture = await seedFixture(slot);
    await verifyFixtureCoverage(fixture);
  });
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
      const completionOk = recordCheck('workflow.completed', 'Request reaches completed only after convergence', 0.25,
        completion, concurrentOk && alternateOk, 'a canonical request was not established');
      if (![unknownCustomer.ok, crossTenant.ok, concurrentOk, alternateOk, repeated.ok, conflictingReuse.ok, completionOk].every(Boolean)) {
        throw new Error('one or more request-contract checks failed');
      }
    });
    await test('normal subject PII is absent from every active store', async () => {
      const violations = await collectErasureViolations(fixture, fixture.normal);
      const grouped = classifyNormalViolations(violations);
      recordCheck('normal.postgres_relational', 'Primary relational records are removed or rekeyed', 0.6, noViolations(grouped.relational));
      recordCheck('normal.postgres_payloads', 'Embedded and operational PostgreSQL PII is redacted', 0.8, noViolations(grouped.payload));
      recordCheck('normal.redis', 'Redis no longer contains subject PII', 0.15, noViolations(grouped.redis));
      recordCheck('normal.opensearch', 'OpenSearch no longer contains subject PII', 0.15, noViolations(grouped.search));
      recordCheck('normal.minio', 'MinIO no longer contains subject PII', 0.25, noViolations(grouped.minio));
      recordCheck('normal.mailpit', 'Mailpit no longer contains subject PII', 0.25, noViolations(grouped.mailpit));
      assertNoErasureViolations(violations, 'normal erasure');
    });
    await test('financial truth and shared unrelated records are retained', async () => {
      const financial = await observe(async () => { await verifyFinancialRetention(fixture); });
      const normalClean = checks.filter((check) => check.id.startsWith('normal.')).every((check) => check.state === 'pass');
      recordCheck('financial.retention', 'Financial facts remain intact after a successful erasure', 1, financial,
        normalClean, 'normal-subject PII was not fully removed');
      const survivor = await observe(async () => { await verifySurvivorUntouched(fixture); });
      if (!financial.ok) throw new Error(financial.evidence);
      if (!survivor.ok) throw new Error(survivor.evidence);
    });
    let delayedRequest = '';
    let delayedViolations: string[] = [];
    await test('failed erasure retries safely and pending asynchronous work is sanitized before completion', async () => {
      const retryKey = `delayed-${slot}`;
      const created = await observe(async () => {
        await installTransientPaymentWriteFailure(fixture.delayed.paymentId);
        delayedRequest = await requestErasure(fixture.merchantKey, fixture.delayed.customerId, retryKey);
      });
      const createdOk = recordCheck('async.request_accepted', 'Delayed-subject erasure request is accepted', 0.2, created);
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
      // The legacy binary suite stops this scenario at a failed request/completion. Do the same
      // here: collecting cross-store evidence would add enough time for background work to alter
      // later delayed/replay scenarios and would make the legacy score non-comparable.
      if (!created.ok || !failed.ok || !completed.ok) {
        recordCheck('async.pending_payloads', 'Pending work and its payloads are fully sanitized', 0.7,
          { ok: false, evidence: completed.evidence ?? created.evidence }, false,
          'the delayed-subject erasure did not complete');
        throw new Error([created.evidence, completed.evidence].filter(Boolean).join('; ') || 'pending-work verification failed');
      }
      const delayedSnapshot = await collectErasureViolations(fixture, fixture.delayed);
      const delayedClean = noViolations(delayedSnapshot);
      recordCheck('async.pending_payloads', 'Pending work and its payloads are fully sanitized', 0.7, delayedClean,
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
      const replay = await observe(async () => { await replayHistoricalPiiEvent(fixture); });
      const delayedSafe = checks.find((check) => check.id === 'delayed.no_reintroduction')?.state === 'pass';
      const replayOk = recordCheck('replay.consumed', 'Historical event is safely consumed', 0.4, replay,
        delayedSafe, 'delayed-work safety was not established');
      const current = replay.ok ? await collectErasureViolations(fixture, fixture.delayed) : [];
      const introduced = replay.ok ? noViolations(newlyIntroduced(delayedViolations, current))
        : { ok: false, evidence: replay.evidence };
      recordCheck('replay.no_reintroduction', 'Historical replay does not restore PII', 0.6, introduced,
        delayedSafe && replayOk, 'historical replay could not be safely evaluated');
      if (replay.ok) delayedViolations = current;
      if (!replay.ok || !introduced.ok) throw new Error([replay.evidence, introduced.evidence].filter(Boolean).join('; ') || 'replay verification failed');
    });
    await test('survivor remains unchanged after replay and delayed work', async () => {
      const survivor = await observe(async () => { await verifySurvivorUntouched(fixture); });
      const replaySafe = checks.find((check) => check.id === 'replay.no_reintroduction')?.state === 'pass';
      recordCheck('survivor.unchanged', 'Unrelated shared records remain unchanged', 0.6, survivor,
        replaySafe, 'replay safety was not established');
      if (!survivor.ok) throw new Error(survivor.evidence);
    });
  }
} finally {
  await writeReport();
  await writeScoreReport();
  await closeClients();
}

if (results.some((result) => result.error)) process.exitCode = 1;
