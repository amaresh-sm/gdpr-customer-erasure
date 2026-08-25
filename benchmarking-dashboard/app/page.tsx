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

export default function Home() {
  const [selectedId, setSelectedId] = useState(runs[0]?.id ?? '');
  const [expanded, setExpanded] = useState(false);
  const ranked = useMemo(() => [...runs].sort((a, b) => b.score - a.score || a.elapsedMs! - b.elapsedMs!), []);
  const selected = ranked.find((run) => run.id === selectedId) ?? ranked[0];

  if (!selected) {
    return <main className="shell"><div className="frame hero"><h1>No completed runs yet.</h1></div></main>;
  }

  const displayTools = expanded ? selected.tools.trajectory : selected.tools.trajectory.slice(0, 8);
  const bestScore = ranked[0].score;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="frame topbar-inner">
          <div className="brand"><span className="brand-mark" /><span className="eyebrow">PayFlow · Evaluation</span></div>
          <div className="top-status"><span className="pulse" /> local candidate evidence</div>
        </div>
      </header>

      <section className="frame hero">
        <div className="eyebrow">GDPR customer erasure · calibration dashboard</div>
        <h1>See what each<br /><strong>candidate actually did.</strong></h1>
        <p>Two latest completed isolated runs, ranked by their normalized privacy-erasure score. Select a run to inspect its score profile and tool trajectory.</p>
      </section>

      <section className="frame summary-grid" aria-label="Run summary">
        <div className="summary-cell"><div className="metric-label">Recorded runs</div><div className="metric-value">{ranked.length}</div></div>
        <div className="summary-cell"><div className="metric-label">Highest score</div><div className="metric-value"><em>{score(bestScore)}</em> <span className="mono">/ 1.000</span></div></div>
        <div className="summary-cell"><div className="metric-label">Data refreshed</div><div className="metric-value">{new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(dataset.generatedAt))}</div></div>
      </section>

      <section className="frame">
        <div className="section-head"><h2>Recent candidate runs</h2><p>Normalized score only · 1.000 is a complete solution</p></div>
        <div className="leaderboard" role="list">
          {ranked.map((run, index) => {
            const active = run.id === selected.id;
            return (
              <button className={`run-row ${active ? 'active' : ''}`} key={run.id} onClick={() => { setSelectedId(run.id); setExpanded(false); }} aria-pressed={active}>
                <span className="rank-box">{index + 1}</span>
                <span>
                  <span className="model-name">{run.model} <span>({run.reasoning})</span></span>
                  <span className="run-meta">{run.provider} · {duration(run.elapsedMs)} · completed</span>
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
          <div><div className="card-kicker">Selected run · rank #{ranked.indexOf(selected) + 1}</div><h2>{selected.model} <span className="mono">({selected.reasoning})</span></h2><p className="run-id">{selected.id}</p></div>
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
              {selected.checks.filter((check) => check.maximum > 0).map((check) => {
                const share = check.maximum ? (check.earned / check.maximum) * 100 : 0;
                return <div className="check-row" key={check.label} title={check.label}>
                  <span className="check-label">{check.label}</span>
                  <span className="check-meter"><span className={stateClass(check.state)} style={{ width: `${share}%` }} /></span>
                  <span className={`check-state ${stateClass(check.state)}`}>{check.state}</span>
                </div>;
              })}
            </div>
          </div>
          <div className="trajectory">
            <div className="panel-title">Tool-by-tool trajectory</div>
            <p className="panel-description">A condensed view of the measured tool sequence. Details are intentionally summarized rather than replaying raw commands.</p>
            <div className="trajectory-summary"><span className="tool-count"><strong>{selected.tools.total ?? 'N/A'}</strong> tool calls</span><span className="run-meta">{selected.tools.trajectory.length} recorded steps</span></div>
            <div className="trajectory-strip" aria-label="Tool trajectory strip">
              {selected.tools.trajectory.map((tool) => <span key={tool.sequence} className={`trajectory-bar ${tool.state}`} style={{ height: `${18 + (tool.sequence % 5) * 8}px` }} title={`${tool.sequence}: ${tool.state}`} />)}
            </div>
            <div className="legend"><span><i /> successful</span><span><i className="error" /> error</span></div>
            <div className="tool-list">
              {displayTools.map((tool) => <div className="tool-row" key={tool.sequence}>
                <span className="tool-step">{String(tool.sequence).padStart(3, '0')}</span>
                <span className="tool-kind"><i className={tool.state === 'ok' ? '' : 'error'} />{tool.kind}</span>
                <span className="tool-label">{tool.label}</span>
                <span className={`tool-result ${tool.state === 'ok' ? '' : 'error'}`}>{tool.state === 'ok' ? '+' : '!'}</span>
              </div>)}
            </div>
            {selected.tools.trajectory.length > 8 && <button className="expand" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : `Show all ${selected.tools.trajectory.length} tool calls`}</button>}
          </div>
        </div>
      </section>
      <footer className="frame footer">Data source: completed candidate metadata and score reports. Refresh with <span className="mono">npm run sync:data</span> after a new run is scored.</footer>
    </main>
  );
}
