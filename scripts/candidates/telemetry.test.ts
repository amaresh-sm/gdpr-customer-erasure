import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseCodexJsonl } from './telemetry.js';

test('parses current Codex item command events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'payflow-codex-events-'));
  const events = join(directory, 'events.jsonl');
  try {
    await writeFile(events, [
      JSON.stringify({ type: 'item.started', timestamp: '2026-08-22T12:00:00.000Z', item: { id: 'item-1', type: 'command_execution', command: 'npm test', status: 'in_progress' } }),
      JSON.stringify({ type: 'item.completed', timestamp: '2026-08-22T12:00:01.250Z', item: { id: 'item-1', type: 'command_execution', command: 'npm test', aggregated_output: 'ok', exit_code: 0, status: 'completed' } }),
    ].join('\n'));
    const telemetry = await parseCodexJsonl(events);
    assert.equal(telemetry.eventCount, 2);
    assert.equal(telemetry.toolCalls.length, 1);
    assert.equal(telemetry.toolCalls[0]?.category, 'shell');
    assert.equal(telemetry.toolCalls[0]?.status, 'ok');
    assert.equal(telemetry.toolCalls[0]?.duration_ms, 1250);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
