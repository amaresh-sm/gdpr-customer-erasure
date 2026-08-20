import { writeFile } from 'node:fs/promises';
import { closeClients } from './lib/clients.js';
import { seedFixture, type BenchmarkFixture } from './lib/fixture.js';
import { releaseDelayedWork, replayHistoricalPiiEvent, requestErasure, verifyErasedEverywhere,
  verifyFinancialRetention, verifyRequestContract, verifySurvivorUntouched, waitForCompletion } from './lib/verifier.js';

interface TestResult { name: string; durationMs: number; error?: string }
const results: TestResult[] = [];
let fixture: BenchmarkFixture;

async function test(name: string, operation: () => Promise<void>): Promise<void> {
  const started = Date.now();
  try {
    await operation();
    results.push({ name, durationMs: Date.now() - started });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    results.push({ name, durationMs: Date.now() - started, error: message });
    process.stdout.write(`FAIL ${name}: ${message}\n`);
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
      await verifyErasedEverywhere(fixture, fixture.normal);
    });
    await test('financial truth and shared unrelated records are retained', async () => {
      await verifyFinancialRetention(fixture);
      await verifySurvivorUntouched(fixture);
    });
    let delayedRequest = '';
    await test('pending asynchronous work is sanitized before completion', async () => {
      delayedRequest = await requestErasure(fixture.merchantKey, fixture.delayed.customerId, `delayed-${slot}`);
      await waitForCompletion(fixture.merchantKey, delayedRequest);
      await verifyErasedEverywhere(fixture, fixture.delayed);
    });
    await test('delayed webhook and document work cannot reintroduce PII', async () => {
      await releaseDelayedWork(fixture);
      await verifyErasedEverywhere(fixture, fixture.delayed);
    });
    await test('historical event replay is suppressed by durable erasure state', async () => {
      await replayHistoricalPiiEvent(fixture);
      await verifyErasedEverywhere(fixture, fixture.delayed);
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
