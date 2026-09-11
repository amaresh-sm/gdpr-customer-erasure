import { readFile } from 'node:fs/promises';

export type CheckState = 'pass' | 'fail' | 'blocked';
export type ScoreState = 'complete';

export interface ScoringManifestCheck {
  id: string;
  aliases?: string[];
  label: string;
  maximum: number;
  criterion: string;
}

export interface ScoringManifest {
  task_id: string;
  schema_version: number;
  scale: 'normalized_1';
  blocked_policy: 'zero';
  criteria: Array<{ id: string; check_ids: string[] }>;
  checks: ScoringManifestCheck[];
}

export interface DiagnosticCheck {
  id: string;
  label: string;
  maximum: number;
  earned: number;
  state: CheckState;
  evidence?: string | undefined;
}

export interface FixtureDiagnostic {
  id: string;
  state: 'ready' | 'failed' | 'not_attempted';
  evidence?: string | undefined;
}

export interface ScoreReport {
  schema_version: 1;
  state: ScoreState;
  comparable: boolean;
  hard_pass: boolean;
  earned: number | null;
  maximum: 1;
  evaluated_maximum: number;
  unverified_maximum: number;
  checks: DiagnosticCheck[];
  fixtures: FixtureDiagnostic[];
  diagnostics: {
    passed_checks: number;
    failed_checks: number;
    blocked_checks: number;
    blocked_check_ids: string[];
  };
  blocked_reason?: string | undefined;
}

/**
 * Loads the private score manifest shared by the verifier and readiness checks.
 * The file is JSON-compatible YAML so the runtime needs no third-party parser.
 */
export async function loadScoringManifest(path?: string): Promise<ScoringManifest> {
  const manifestPath = path ?? process.env.ERASURE_SCORING_PATH ??
    new URL('../../scoring.yml', import.meta.url);
  const content = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(content) as ScoringManifest;
  if (manifest.schema_version !== 1 || manifest.scale !== 'normalized_1' || manifest.blocked_policy !== 'zero') {
    throw new Error('scoring manifest has an unsupported schema, scale, or blocked policy');
  }
  if (!Array.isArray(manifest.checks) || !Array.isArray(manifest.criteria)) {
    throw new Error('scoring manifest must contain checks and criteria arrays');
  }
  return manifest;
}

/**
 * Builds an ID lookup, including explicitly declared equivalent check aliases.
 */
export function scoringMaximums(manifest: ScoringManifest): Map<string, number> {
  const maximums = new Map<string, number>();
  for (const check of manifest.checks) {
    if (maximums.has(check.id)) throw new Error(`duplicate scoring check ID: ${check.id}`);
    maximums.set(check.id, check.maximum);
    for (const alias of check.aliases ?? []) {
      if (maximums.has(alias)) throw new Error(`duplicate scoring check alias: ${alias}`);
      maximums.set(alias, check.maximum);
    }
  }
  return maximums;
}

function rounded(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * Builds the single normalized benchmark score. Passing checks earn their weight;
 * failed and blocked checks earn zero. Blocked checks remain visible in diagnostics,
 * but they do not create a second score or an alternate score state.
 */
export function buildScoreReport(
  checks: DiagnosticCheck[],
  fixtures: FixtureDiagnostic[],
  _fullFixtureReady: boolean,
  hardPass: boolean,
  blockedReason?: string,
): ScoreReport {
  const diagnostics = {
    passed_checks: checks.filter((check) => check.state === 'pass').length,
    failed_checks: checks.filter((check) => check.state === 'fail').length,
    blocked_checks: checks.filter((check) => check.state === 'blocked').length,
    blocked_check_ids: checks.filter((check) => check.state === 'blocked').map((check) => check.id),
  };
  const earned = rounded(checks.reduce((total, check) => total + check.earned, 0));

  return {
    schema_version: 1,
    state: 'complete',
    comparable: true,
    hard_pass: hardPass && diagnostics.blocked_checks === 0,
    earned,
    maximum: 1,
    evaluated_maximum: 1,
    unverified_maximum: 0,
    checks,
    fixtures,
    diagnostics,
    blocked_reason: blockedReason,
  };
}
