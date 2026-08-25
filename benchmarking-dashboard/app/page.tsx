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

type EfficiencyMetric = 'perToolCall' | 'perHour' | 'perGeneratedToken' | 'perFreshInput';

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

function modelLabel(run: Run) {
  return run.model.replace('gpt-5.6-', 'GPT-5.6 ').replace(/\b\w/g, (character) => character.toUpperCase()).replaceAll('-', ' ');
}

function runDate(value: string) {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

const efficiencyMetrics: Record<EfficiencyMetric, { label: string; shortLabel: string; description: string; calculate: (run: Run) => number | null; format: (value: number) => string }> = {
  perToolCall: {
    label: 'Score per 100 tool calls',
    shortLabel: 'Tool calls',
    description: 'Normalized score earned for every 100 measured tool calls.',
    calculate: (run) => run.tools.total && run.tools.total > 0 ? (run.score / run.tools.total) * 100 : null,
    format: (value) => value.toFixed(3),
  },
  perHour: {
    label: 'Score per generation hour',
    shortLabel: 'Generation time',
    description: 'Normalized score earned per hour of model execution.',
    calculate: (run) => run.elapsedMs && run.elapsedMs > 0 ? run.score / (run.elapsedMs / 3_600_000) : null,
    format: (value) => value.toFixed(3),
  },
  perGeneratedToken: {
    label: 'Score per 1K generated tokens',
    shortLabel: 'Generated tokens',
    description: 'Normalized score earned per thousand output and reasoning tokens.',
    calculate: (run) => {
      const generated = (run.tokens.output ?? 0) + (run.tokens.reasoning ?? 0);
      return generated > 0 ? run.score / (generated / 1_000) : null;
    },
    format: (value) => value.toFixed(4),
  },
  perFreshInput: {
    label: 'Score per 1M non-cached input tokens',
    shortLabel: 'Fresh input',
    description: 'Normalized score earned per million input tokens that were not served from cache.',
    calculate: (run) => {
      const fresh = (run.tokens.input ?? 0) - (run.tokens.cachedInput ?? 0);
      return fresh > 0 ? run.score / (fresh / 1_000_000) : null;
    },
    format: (value) => value.toFixed(3),
  },
};

export default function Home() {
  const [selectedId, setSelectedId] = useState(runs[0]?.id ?? '');
  const [expanded, setExpanded] = useState(false);
  const [efficiencyMetric, setEfficiencyMetric] = useState<EfficiencyMetric>('perHour');
  const ranked = useMemo(() => [...runs].sort((a, b) => b.score - a.score || a.elapsedMs! - b.elapsedMs!), []);
  const chronological = useMemo(() => [...runs].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()), []);
  const selected = ranked.find((run) => run.id === selectedId) ?? ranked[0];

  if (!selected) {
    return <main className="shell"><div className="frame hero"><h1>No completed runs yet.</h1></div></main>;
  }

  const displayTools = expanded ? selected.tools.trajectory : selected.tools.trajectory.slice(0, 8);
  const bestScore = ranked[0].score;
  const chartWidth = 1000;
  const chartHeight = 330;
  const chartPadding = { left: 56, right: 18, top: 16, bottom: 38 };
  const plotWidth = chartWidth - chartPadding.left - chartPadding.right;
  const plotHeight = chartHeight - chartPadding.top - chartPadding.bottom;
  const chartPoint = (run: Run, index: number) => ({
    x: chartPadding.left + (chronological.length === 1 ? plotWidth / 2 : (index / (chronological.length - 1)) * plotWidth),
    y: chartPadding.top + (1 - run.score) * plotHeight,
  });
  const selectedEfficiency = efficiencyMetrics[efficiencyMetric];
  const efficiencyRanking = ranked
    .map((run) => ({ run, value: selectedEfficiency.calculate(run) }))
    .filter((item): item is { run: Run; value: number } => item.value !== null)
    .sort((left, right) => right.value - left.value);
  const highestEfficiency = efficiencyRanking[0]?.value ?? 0;

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

      <section className="frame visual-section" aria-label="Calibration charts">
        <article className="chart-card score-chart">
          <div className="chart-head"><div><div className="panel-title">Score across calibration runs</div><p>Normalized GDPR score by generation start time. Select a point for the recorded run evidence.</p></div><span className="chart-note">{chronological.length} results</span></div>
          <div className="line-chart-wrap">
            <svg className="line-chart" viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label="Normalized privacy score by calibration run time">
              {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
                const y = chartPadding.top + (1 - tick) * plotHeight;
                return <g key={tick}><line x1={chartPadding.left} x2={chartWidth - chartPadding.right} y1={y} y2={y} className="chart-grid-line" /><text x={chartPadding.left - 12} y={y + 4} textAnchor="end" className="chart-axis-label">{Math.round(tick * 100)}%</text></g>;
              })}
              {chronological.map((run, index) => {
                const point = chartPoint(run, index);
                return <g key={`${run.id}-tick`}><line x1={point.x} x2={point.x} y1={chartPadding.top} y2={chartHeight - chartPadding.bottom} className="chart-grid-line vertical" /><text x={point.x} y={chartHeight - 10} textAnchor="middle" className="chart-axis-label date">{runDate(run.startedAt)}</text></g>;
              })}
              {chronological.slice(1).map((run, index) => {
                const from = chartPoint(chronological[index]!, index);
                const to = chartPoint(run, index + 1);
                return <line key={`${run.id}-segment`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className="chart-series-line" />;
              })}
              {chronological.map((run, index) => {
                const point = chartPoint(run, index);
                const active = run.id === selected.id;
                return <g key={run.id} className="chart-point-group" onClick={() => { setSelectedId(run.id); setExpanded(false); }} role="button" tabIndex={0} aria-label={`Select ${modelLabel(run)} ${run.reasoning}, score ${score(run.score)}`} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(run.id); setExpanded(false); } }}>
                  <circle cx={point.x} cy={point.y} r={active ? 10 : 7} className={`chart-point ${active ? 'active' : ''}`} />
                  {active && <text x={point.x} y={point.y - 18} textAnchor="middle" className="chart-point-label">{score(run.score)}</text>}
                </g>;
              })}
            </svg>
          </div>
        </article>

        <article className="chart-card bar-chart-card">
          <div className="chart-head"><div><div className="panel-title">Score ranking</div><p>Same six runs, ranked high to low.</p></div></div>
          <div className="bar-list">
            {ranked.map((run, index) => <button className={`bar-row ${run.id === selected.id ? 'active' : ''}`} key={run.id} onClick={() => { setSelectedId(run.id); setExpanded(false); }} aria-pressed={run.id === selected.id}>
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

      <section className="frame efficiency-section" aria-label="Execution efficiency rankings">
        <div className="efficiency-intro">
          <div className="panel-title">Execution efficiency</div>
          <h2>Which run used its execution budget most effectively?</h2>
          <p>Higher is better. These are measured score-to-resource ratios, not estimated dollar cost.</p>
        </div>
        <div className="efficiency-tabs" role="tablist" aria-label="Efficiency metric">
          {(Object.entries(efficiencyMetrics) as [EfficiencyMetric, typeof efficiencyMetrics[EfficiencyMetric]][]).map(([key, metric]) => <button key={key} role="tab" aria-selected={efficiencyMetric === key} className={efficiencyMetric === key ? 'active' : ''} onClick={() => setEfficiencyMetric(key)}>{metric.shortLabel}</button>)}
        </div>
        <div className="efficiency-card">
          <div className="efficiency-card-head"><div><h3>{selectedEfficiency.label}</h3><p>{selectedEfficiency.description}</p></div><span>Higher is better</span></div>
          <div className="efficiency-ranking">
            {efficiencyRanking.map(({ run, value }, index) => <button key={run.id} className={`efficiency-row ${run.id === selected.id ? 'active' : ''}`} onClick={() => { setSelectedId(run.id); setExpanded(false); }} aria-pressed={run.id === selected.id}>
              <span className="efficiency-rank">{index + 1}</span>
              <span className="efficiency-model">{modelLabel(run)} <small>{run.reasoning}</small></span>
              <span className="efficiency-track"><span style={{ width: `${highestEfficiency ? (value / highestEfficiency) * 100 : 0}%` }} /></span>
              <span className="efficiency-value">{selectedEfficiency.format(value)}</span>
            </button>)}
          </div>
        </div>
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
                  <span className="model-name">{modelLabel(run)} <span>({run.reasoning})</span></span>
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
