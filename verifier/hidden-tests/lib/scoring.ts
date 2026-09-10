export type CheckState = 'pass' | 'fail' | 'blocked';
export type ScoreState = 'complete' | 'partial' | 'blocked';

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
 * Builds a conservative score. Only checks with a pass/fail observation
 * contribute to the evaluated maximum; blocked checks never become zeroes.
 */
export function buildScoreReport(
  checks: DiagnosticCheck[],
  fixtures: FixtureDiagnostic[],
  fullFixtureReady: boolean,
  hardPass: boolean,
  blockedReason?: string,
): ScoreReport {
  const diagnostics = {
    passed_checks: checks.filter((check) => check.state === 'pass').length,
    failed_checks: checks.filter((check) => check.state === 'fail').length,
    blocked_checks: checks.filter((check) => check.state === 'blocked').length,
    blocked_check_ids: checks.filter((check) => check.state === 'blocked').map((check) => check.id),
  };
  const observed = checks.filter((check) => check.state !== 'blocked');
  const evaluatedMaximum = rounded(observed.reduce((total, check) => total + check.maximum, 0));
  const earned = rounded(checks.reduce((total, check) => total + check.earned, 0));

  if (fullFixtureReady) {
    return {
      schema_version: 1,
      state: 'complete',
      comparable: true,
      hard_pass: hardPass,
      earned,
      maximum: 1,
      evaluated_maximum: 1,
      unverified_maximum: 0,
      checks,
      fixtures,
      diagnostics,
    };
  }

  if (evaluatedMaximum > 0) {
    return {
      schema_version: 1,
      state: 'partial',
      comparable: false,
      hard_pass: false,
      earned,
      maximum: 1,
      evaluated_maximum: evaluatedMaximum,
      unverified_maximum: rounded(1 - evaluatedMaximum),
      checks,
      fixtures,
      diagnostics,
      blocked_reason: blockedReason,
    };
  }

  return {
    schema_version: 1,
    state: 'blocked',
    comparable: false,
    hard_pass: false,
    earned: null,
    maximum: 1,
    evaluated_maximum: 0,
    unverified_maximum: 1,
    checks,
    fixtures,
    diagnostics,
    blocked_reason: blockedReason ?? 'no independently valid fixture produced an observable check',
  };
}
