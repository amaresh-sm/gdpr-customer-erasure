import { createHash } from 'node:crypto';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { CandidateRunManifest } from './types.js';

const ignoredDirectories = new Set(['.git', 'dist', 'node_modules']);

/** Returns a deterministic digest for the candidate-visible source tree. */
export async function treeSha256(root: string): Promise<string> {
  const entries: Array<{ path: string; kind: 'file' | 'symlink'; content: string }> = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      if (directory === root && (entry.name === '.hackerrank-openhands-run' || entry.name === '.payflow-task.md')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) entries.push({ path, kind: 'file', content: createHash('sha256').update(await readFile(path)).digest('hex') });
      else if (entry.isSymbolicLink()) entries.push({ path, kind: 'symlink', content: await readlink(path) });
    }
  }
  await visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const hash = createHash('sha256');
  for (const entry of entries) hash.update(`${relative(root, entry.path)}\0${entry.kind}\0${entry.content}\n`);
  return hash.digest('hex');
}

export interface SourceState {
  baseline_sha256: string;
  source_sha256: string;
  changed: boolean;
  baseline_source: 'launch_snapshot' | 'current_codebase_fallback';
}

/** Compares an exported candidate against its trusted launch baseline. */
export async function sourceState(runDirectory: string, baselineDirectory: string): Promise<SourceState> {
  const manifest = JSON.parse(await readFile(join(runDirectory, 'metadata.json'), 'utf8')) as CandidateRunManifest;
  const sourceSha256 = await treeSha256(join(runDirectory, 'source'));
  const recordedBaselineSha256 = manifest.source.baseline_sha256 ?? null;
  if (recordedBaselineSha256 !== null && manifest.source.sha256 !== null && manifest.source.sha256 !== sourceSha256) {
    throw new Error('candidate source changed after generation finalization; refusing to score a modified artifact');
  }
  const baselineSha256 = recordedBaselineSha256 ?? await treeSha256(baselineDirectory);
  return {
    baseline_sha256: baselineSha256,
    source_sha256: sourceSha256,
    changed: baselineSha256 !== sourceSha256,
    baseline_source: recordedBaselineSha256 === null ? 'current_codebase_fallback' : 'launch_snapshot',
  };
}
