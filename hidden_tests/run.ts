import { writeFile } from 'node:fs/promises';
import { closeClients } from './lib/clients.js';
import { seedFixture, type BenchmarkFixture } from './lib/fixture.js';
import { assertNoErasureViolations, collectErasureViolations, releaseDelayedWork,
  replayHistoricalPiiEvent, requestErasure, verifyFinancialRetention, verifyRequestContract,
  verifySurvivorUntouched, waitForCompletion } from './lib/verifier.js';

interface TestResult { name: string; durationMs: number; error?: string }
const results: TestResult[] = [];
let fixture: BenchmarkFixture;
// A correct workflow completes well inside this bound. Keep the guard outside the
// individual polling helpers so any hung candidate participant is reported as a
// scenario failure rather than preventing later independent checks from running.
const scenarioTimeoutMs = Number(process.env.ERASURE_SCENARIO_TIMEOUT_MS ?? '90000');

function newlyIntroduced(previous: string[], current: string[]): string[] {
  const baseline = new Set(previous);
  return current.filter((violation) => !baseline.has(violation));
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

const slot = process.env.ERASURE_TEST_SLOT ?? `${Date.now()}-${process.pid}`;
try {
  await test('deterministic fixture provisions cross-store PII', async () => { fixture = await seedFixture(slot); });
  if (fixture!) {
    let normalRequest = '';
    await test('request contract is tenant-safe, concurrent, and idempotent', async () => {
      normalRequest = await verifyRequestContract(fixture);
      await waitForCompletion(fixture.merchantKey, normalRequest);
    });
    await test('normal subject PII is absent from every active store', async () => {
      assertNoErasureViolations(await collectErasureViolations(fixture, fixture.normal), 'normal erasure');
    });
    await test('financial truth and shared unrelated records are retained', async () => {
      await verifyFinancialRetention(fixture);
      await verifySurvivorUntouched(fixture);
    });
    let delayedRequest = '';
    let delayedViolations: string[] = [];
    await test('pending asynchronous work is sanitized before completion', async () => {
      delayedRequest = await requestErasure(fixture.merchantKey, fixture.delayed.customerId, `delayed-${slot}`);
      await waitForCompletion(fixture.merchantKey, delayedRequest);
      delayedViolations = await collectErasureViolations(fixture, fixture.delayed);
      assertNoErasureViolations(delayedViolations, 'delayed-subject erasure');
    });
    await test('delayed webhook and document work cannot reintroduce PII', async () => {
      await releaseDelayedWork(fixture);
      const current = await collectErasureViolations(fixture, fixture.delayed);
      assertNoErasureViolations(newlyIntroduced(delayedViolations, current), 'delayed work');
      delayedViolations = current;
    });
    await test('historical event replay is suppressed by durable erasure state', async () => {
      await replayHistoricalPiiEvent(fixture);
      const current = await collectErasureViolations(fixture, fixture.delayed);
      assertNoErasureViolations(newlyIntroduced(delayedViolations, current), 'historical replay');
      delayedViolations = current;
    });
    await test('survivor remains unchanged after replay and delayed work', async () => {
      await verifySurvivorUntouched(fixture);
    });
  }
} finally {
  await writeReport();
  await closeClients();
}

if (results.some((result) => result.error)) process.exitCode = 1;
