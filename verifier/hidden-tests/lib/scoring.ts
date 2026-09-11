export type CheckState = 'pass' | 'fail' | 'blocked';
export type ScoreState = 'complete';

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
