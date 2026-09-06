'use client';

import { useMemo, useState } from 'react';
import dataset from './data/runs.json';

type Check = { label: string; state: 'pass' | 'fail' | 'blocked'; earned: number; maximum: number };
type Tool = { sequence: number; kind: string; state: string; label: string; durationMs: number | null };
type Run = {
  id: string;
  status: string;
  provider: string;
  model: string;
  reasoning: string;
  startedAt: string;
  elapsedMs: number | null;
  tokens: { input: number | null; cachedInput: number | null; output: number | null; reasoning: number | null; total: number | null };
  tools: { total: number | null; successful: number | null; failed: number | null; trajectory: Tool[] };
  score: number;
  scoreMaximum: number;
  hardPass: boolean;
  checks: Check[];
};

const runs = dataset.runs as Run[];
const dashboardTimeZone = 'UTC';

function duration(value: number | null) {
  if (value === null) return 'N/A';
  const minutes = Math.round(value / 60000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
}

function compact(value: number | null) {
  if (value === null) return 'not reported';
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function score(value: number) {
  return value.toFixed(4);
}

function stateClass(state: string) {
  return state === 'pass' ? 'pass' : state === 'blocked' ? 'blocked' : 'fail';
}

function modelLabel(run: Run) {
  return run.model.replace('gpt-5.6-', 'GPT-5.6 ').replace(/\b\w/g, (character) => character.toUpperCase()).replaceAll('-', ' ');
}

function runDate(value: string) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: dashboardTimeZone,
  }).format(new Date(value));
}

export default function Home() {
  const [selectedId, setSelectedId] = useState(runs[0]?.id ?? '');
  const ranked = useMemo(() => [...runs].sort((a, b) => b.score - a.score || a.elapsedMs! - b.elapsedMs!), []);
  const selected = ranked.find((run) => run.id === selectedId) ?? ranked[0];

  if (!selected) {
    return <main className="shell"><div className="frame hero"><h1>No completed runs yet.</h1></div></main>;
  }

  const bestScore = ranked[0].score;
  const displayedChecks = (selected.checks.length ? [...selected.checks] : [{
    label: 'Hidden verifier score',
    state: selected.hardPass ? 'pass' as const : 'fail' as const,
    earned: selected.score,
    maximum: selected.scoreMaximum,
  }]).sort((left, right) => right.maximum - left.maximum || right.earned - left.earned);

  return (
    <main className="shell">
      <section className="frame hero">
        <h1>Add customer data deletion to PayFlow</h1>
        <p>Selected completed isolated runs, ranked by their normalized privacy score. Select a run to inspect its score profile.</p>
      </section>

      <section className="frame summary-grid" aria-label="Run summary">
        <div className="summary-cell"><div className="metric-label">Recorded runs</div><div className="metric-value">{ranked.length}</div></div>
        <div className="summary-cell"><div className="metric-label">Highest score</div><div className="metric-value"><em>{score(bestScore)}</em> <span className="mono">/ 1.000</span></div></div>
      </section>

      <section className="frame visual-section" aria-label="Calibration charts">
        <article className="chart-card bar-chart-card">
          <div className="chart-head"><div><div className="panel-title">Score ranking</div><p>Selected runs, ranked high to low.</p></div></div>
          <div className="bar-list">
            {ranked.map((run, index) => <button className={`bar-row ${run.id === selected.id ? 'active' : ''}`} key={run.id} onClick={() => setSelectedId(run.id)} aria-pressed={run.id === selected.id}>
              <span className="bar-rank">{index + 1}</span>
              <span className="bar-content"><span className="bar-model">{modelLabel(run)} <small>{run.reasoning}</small></span><span className="bar-track"><span style={{ width: `${run.score * 100}%` }} /></span></span>
              <span className="bar-score">{score(run.score)}</span>
            </button>)}
          </div>
        </article>
      </section>

      <section className="frame run-highlight" aria-live="polite">
        <div className="highlight-title"><div className="panel-title">Highlighted candidate</div><h2>{modelLabel(selected)} <span className="mono">({selected.reasoning})</span></h2><p>{selected.id}</p></div>
        <div className="highlight-stat"><span>Started</span><b>{runDate(selected.startedAt)}</b></div>
        <div className="highlight-stat"><span>Score</span><b className="accent">{score(selected.score)} / 1.000</b></div>
        <div className="highlight-stat"><span>Generation</span><b>{duration(selected.elapsedMs)}</b></div>
        <div className="highlight-stat"><span>Input tokens</span><b>{compact(selected.tokens.input)}</b></div>
        <div className="highlight-stat"><span>Tool calls</span><b>{selected.tools.total ?? 'N/A'}</b></div>
        <div className="highlight-stat"><span>Hard pass</span><b className={selected.hardPass ? 'good' : 'warn'}>{selected.hardPass ? 'yes' : 'not reached'}</b></div>
      </section>

      <section className="frame">
        <div className="section-head"><h2>Candidate runs</h2><p>Normalized score only · 1.000 is a complete solution</p></div>
        <div className="leaderboard" role="list">
            {ranked.map((run, index) => {
            const active = run.id === selected.id;
            return (
              <button className={`run-row ${active ? 'active' : ''}`} key={run.id} onClick={() => setSelectedId(run.id)} aria-pressed={active}>
                <span className="rank-box">{index + 1}</span>
                <span>
                  <span className="model-name">{modelLabel(run)} <span>({run.reasoning})</span></span>
                  <span className="run-meta">{duration(run.elapsedMs)} · completed</span>
                </span>
                <span className="row-status">Hard pass <b>{run.hardPass ? 'yes' : 'not reached'}</b></span>
                <span className="row-score"><span className="score-meter"><span style={{ width: `${run.score * 100}%` }} /></span><span className="score-value">{score(run.score)} <small>/1.0</small></span></span>
                <span className="chevron">{active ? '−' : '+'}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="frame detail" aria-label="Selected run details">
        <div className="detail-head">
          <div><div className="card-kicker">Selected run · rank #{ranked.indexOf(selected) + 1}</div><h2>{modelLabel(selected)} <span className="mono">({selected.reasoning})</span></h2><p className="run-id">{selected.id}</p></div>
          <span className="status-chip">{selected.hardPass ? 'hard pass' : 'not hard pass'}</span>
        </div>
        <div className="detail-metrics">
          <div className="detail-metric"><div className="metric-label">Score</div><div className="value">{score(selected.score)} / 1.000</div><div className="sub">normalized privacy score</div></div>
          <div className="detail-metric"><div className="metric-label">Generation time</div><div className="value">{duration(selected.elapsedMs)}</div><div className="sub">isolated model run</div></div>
          <div className="detail-metric"><div className="metric-label">Input tokens</div><div className="value">{compact(selected.tokens.input)}</div><div className="sub">{compact(selected.tokens.cachedInput)} cached</div></div>
          <div className="detail-metric"><div className="metric-label">Tool calls</div><div className="value">{selected.tools.total ?? 'N/A'}</div><div className="sub">{selected.tools.successful ?? 'N/A'} ok · {selected.tools.failed ?? 'N/A'} errors</div></div>
        </div>
        <div className="detail-body">
          <div className="score-profile">
            <div className="panel-title">Score profile</div>
            <p className="panel-description">Each bar is a scored privacy or system-safety check. Blocked checks are shown separately and never count as passes.</p>
            <div className="check-list">
              {displayedChecks.filter((check) => check.maximum > 0).map((check) => {
                const share = check.maximum ? (check.earned / check.maximum) * 100 : 0;
                return <div className="check-row" key={check.label} title={check.label}>
                  <span className="check-label">{check.label}</span>
                  <span className="check-meter"><span className={stateClass(check.state)} style={{ width: `${share}%` }} /></span>
                  <span className="check-score">{score(check.earned)} / {score(check.maximum)}</span>
                  <span className={`check-state ${stateClass(check.state)}`}>{check.state}</span>
                </div>;
              })}
            </div>
          </div>
        </div>
      </section>
      <footer className="frame footer">Data source: completed candidate metadata and score reports. Refresh with <span className="mono">npm run sync:data</span> after a new run is scored.</footer>
    </main>
  );
}
