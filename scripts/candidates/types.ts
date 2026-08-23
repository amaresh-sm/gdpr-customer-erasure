/** A measured value or an explicit declaration that it cannot be collected. */
export interface Evidence<T> {
  value: T | null;
  status: 'measured' | 'not_available' | 'not_applicable';
  source: string;
  reason: string | null;
}

export interface ToolCallEvidence {
  sequence: number;
  call_id: string | null;
  name: string;
  category: 'shell' | 'patch' | 'mcp' | 'other';
  started_at: string;
  duration_ms: number | null;
  status: 'ok' | 'error' | 'cancelled';
  sanitized_arguments: unknown;
  result_size_bytes: number | null;
  result_sha256: string | null;
  result_metadata: Record<string, unknown>;
  truncated: boolean | null;
}

export interface CandidateRunManifest {
  schema_version: 1;
  run: {
    id: string;
    status: 'completed' | 'failed' | 'timed_out' | 'not_started';
    exit_code: number | null;
    timeout_exceeded: boolean;
    failure_reason: string | null;
  };
  model: {
    provider: string;
    name: string;
    reasoning_effort: string;
  };
  timing: {
    started_at: Evidence<string>;
    completed_at: Evidence<string>;
    generation_elapsed_ms: Evidence<number>;
    model_execution_elapsed_ms: Evidence<number>;
  };
  tokens: {
    input: Evidence<number>;
    cached_input: Evidence<number>;
    output: Evidence<number>;
    reasoning: Evidence<number>;
    total: Evidence<number>;
    source: Evidence<string>;
    provider_codex_agreement: Evidence<boolean>;
  };
  tool_usage: {
    total: Evidence<number>;
    successful: Evidence<number>;
    failed: Evidence<number>;
    cancelled: Evidence<number>;
    shell: Evidence<number>;
    patch: Evidence<number>;
    by_tool: Record<string, number>;
    trajectory: ToolCallEvidence[];
  };
  resources: {
    cpu_seconds: Evidence<number>;
    peak_memory_bytes: Evidence<number>;
  };
  event_integrity: {
    codex_thread_id: Evidence<string>;
    jsonl_event_count: Evidence<number>;
    invalid_event_count: Evidence<number>;
    terminal_event: Evidence<string>;
  };
  error_integrity: {
    codex_error_count: Evidence<number>;
    error_sha256: Evidence<string>;
  };
  prompt_integrity: {
    sha256: string;
  };
  runtime: {
    codex_cli_version: Evidence<string>;
    generation_image: Evidence<string>;
    gateway_image: Evidence<string>;
  };
  isolation: {
    host_mount_assertion: Evidence<boolean>;
    network_mode: Evidence<string>;
  };
  credential_safety: {
    location: Evidence<string>;
    ephemeral_storage: Evidence<boolean>;
    post_run_persistence: Evidence<boolean>;
    leak_scan: Evidence<boolean>;
  };
  cleanup: {
    removed_transient_files: Evidence<string[]>;
  };
  portkey: {
    route_identity: Evidence<string>;
  };
  source: {
    baseline_ref: string;
    baseline_commit: string;
    sha256: string | null;
  };
  scoring: {
    verifier_ref: string | null;
    junit_path: string | null;
    score_path: string | null;
    scenarios_total: number | null;
    scenarios_passed: number | null;
    weighted_score: number | null;
    weighted_maximum: number | null;
    hard_pass: boolean | null;
    score_state: 'complete' | 'blocked' | null;
    report_sha256: string | null;
  };
}
