import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MODEL } from '../src/assistant/agent';
import { CheckLine, ModelCall, RunBody } from './harness';

/** Writes results/report.html (5 tabs), results/report.md, results/traces/<case>.json and results/history.json. */

export const RESULTS_DIR = join(__dirname, 'results');
const TRACES_DIR = join(RESULTS_DIR, 'traces');

/** What TASK.md asks the evals to cover, in its order. */
export const COVERAGE = [
  '1. Requirements',
  '2. Matching',
  '3. No suitable property',
  '4. Unclear follow-up date',
  '5. Prompt injection',
  '6. Tool failure',
  '7. Tool choice',
  '8. No action without approval',
  'Part 6: WhatsApp',
  'Part 7: Price check',
  'Part 8: Agent pick',
  'Part 9: Re-check on approve',
  'Part 10: Budget',
  'Extra: Dates and timezone',
  'Extra: Agency isolation',
  'Extra: Concurrency',
] as const;
export type Coverage = (typeof COVERAGE)[number];

export interface CaseResult {
  name: string;
  covers: Coverage[];
  input: string;
  status: 'pass' | 'fail' | 'skipped';
  skipReason?: string;
  checks: CheckLine[];
  durationMs: number;
  runs: RunBody[];
  extra?: unknown;
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const esc = (value: unknown) =>
  String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const usd = (n: number) => `$${n.toFixed(4)}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const json = (value: unknown, max = 4000) => {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters in the trace file)` : text;
};

export function writeResults(results: CaseResult[], calls: ModelCall[], startedAt: Date, partial = false) {
  if (partial) {
    // A filtered run (`-t ...`) prints its table but leaves the full report, traces and history alone.
    printTable(results, calls, summarize(results, calls));
    console.log('Filtered run: report.html, report.md, traces and history were not changed.');
    return;
  }
  mkdirSync(RESULTS_DIR, { recursive: true });
  rmSync(TRACES_DIR, { recursive: true, force: true });
  mkdirSync(TRACES_DIR, { recursive: true });

  const callsOf = (name: string) => calls.filter((c) => c.caseName === name);
  for (const r of results) {
    writeFileSync(
      join(TRACES_DIR, `${slug(r.name)}.json`),
      JSON.stringify({ ...r, modelCalls: callsOf(r.name) }, null, 2) + '\n',
    );
  }

  // Stability: keep the verdicts of the last 10 runs of the suite.
  const historyFile = join(RESULTS_DIR, 'history.json');
  const history: Array<{ at: string; verdicts: Record<string, string> }> = existsSync(historyFile)
    ? JSON.parse(readFileSync(historyFile, 'utf8'))
    : [];
  history.push({ at: startedAt.toISOString(), verdicts: Object.fromEntries(results.map((r) => [r.name, r.status])) });
  while (history.length > 10) history.shift();
  writeFileSync(historyFile, JSON.stringify(history, null, 2) + '\n');

  const stats = summarize(results, calls);
  writeFileSync(join(RESULTS_DIR, 'report.md'), markdown(results, calls, stats, startedAt));
  writeFileSync(join(RESULTS_DIR, 'report.html'), html(results, calls, stats, history, startedAt));
  printTable(results, calls, stats);
}

function summarize(results: CaseResult[], calls: ModelCall[]) {
  const runs = new Map<string, RunBody>();
  for (const r of results) for (const run of r.runs) if (run?.id) runs.set(run.id, run);
  const modelRuns = [...runs.values()].filter((run) => run.finishedAt && Number(run.costUsd) > 0);
  const runMs = modelRuns.map((run) => Date.parse(run.finishedAt) - Date.parse(run.createdAt));
  return {
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    totalCost: calls.reduce((sum, c) => sum + c.costUsd, 0),
    totalMs: results.reduce((sum, r) => sum + r.durationMs, 0),
    modelCalls: calls.length,
    modelRuns: modelRuns.length,
    avgRunCost: modelRuns.length ? modelRuns.reduce((s, run) => s + Number(run.costUsd), 0) / modelRuns.length : 0,
    avgRunMs: runMs.length ? runMs.reduce((s, ms) => s + ms, 0) / runMs.length : 0,
    models: [...new Set(calls.map((c) => c.model))],
  };
}
type Stats = ReturnType<typeof summarize>;

function printTable(results: CaseResult[], calls: ModelCall[], s: Stats) {
  const lines = ['', 'EVAL REPORT', '-----------'];
  for (const r of results) {
    const cost = calls.filter((c) => c.caseName === r.name).reduce((sum, c) => sum + c.costUsd, 0);
    lines.push(`${r.status.toUpperCase().padEnd(7)} ${r.name.padEnd(48)} ${secs(r.durationMs).padStart(7)} ${usd(cost)}`);
    for (const f of r.checks.filter((x) => !x.ok)) lines.push(`        - ${f.text}`);
    if (r.skipReason) lines.push(`        (${r.skipReason})`);
  }
  lines.push(
    '',
    `${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped. ${s.modelCalls} model calls, ${usd(s.totalCost)}, ${secs(s.totalMs)}.`,
    `Report: ${join(RESULTS_DIR, 'report.html')}`,
    '',
  );
  console.log(lines.join('\n'));
}

function markdown(results: CaseResult[], calls: ModelCall[], s: Stats, startedAt: Date) {
  const rows = results.map((r) => {
    const cost = calls.filter((c) => c.caseName === r.name).reduce((sum, c) => sum + c.costUsd, 0);
    const why = r.status === 'skipped' ? r.skipReason : r.checks.filter((x) => !x.ok).map((x) => x.text).join('; ');
    return `| ${r.status.toUpperCase()} | ${r.name} | ${r.covers.join(', ')} | ${secs(r.durationMs)} | ${usd(cost)} | ${why ?? ''} |`;
  });
  return `# Eval report

Run ${startedAt.toISOString()} with \`TZ=${process.env.TZ ?? '(unset)'}\`, model \`${s.models.join(', ') || DEFAULT_MODEL}\`, on a freshly reset test database.

**${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped.** ${s.modelCalls} model calls, ${usd(s.totalCost)} in total, ${secs(s.totalMs)}. Average run: ${usd(s.avgRunCost)}, ${secs(s.avgRunMs)}.

Full report with cost per step, traces, coverage and stability: \`report.html\`. One trace file per case: \`traces/\`.

| Result | Case | Covers | Time | Cost | Why it failed or was skipped |
| --- | --- | --- | --- | --- | --- |
${rows.join('\n')}
`;
}

function html(
  results: CaseResult[],
  calls: ModelCall[],
  s: Stats,
  history: Array<{ at: string; verdicts: Record<string, string> }>,
  startedAt: Date,
) {
  const badge = (status: string) => `<span class="badge ${status}">${status.toUpperCase()}</span>`;
  const costOfCase = (name: string) => calls.filter((c) => c.caseName === name).reduce((sum, c) => sum + c.costUsd, 0);
  const maxCost = Math.max(0.0001, ...results.map((r) => costOfCase(r.name)));

  const overview = `
    <div class="tiles">
      <div class="tile"><b>${s.passed}/${results.length - s.skipped}</b><span>passed</span></div>
      <div class="tile"><b>${s.failed}</b><span>failed</span></div>
      <div class="tile"><b>${s.skipped}</b><span>skipped (part not built)</span></div>
      <div class="tile"><b>${usd(s.totalCost)}</b><span>total cost</span></div>
      <div class="tile"><b>${secs(s.totalMs)}</b><span>total time</span></div>
      <div class="tile"><b>${esc(s.models.join(', ') || DEFAULT_MODEL)}</b><span>model, TZ=${esc(process.env.TZ ?? 'unset')}</span></div>
    </div>
    <table><thead><tr><th>Result</th><th>Case</th><th>Covers</th><th>Time</th><th>Cost</th><th>Why it failed or was skipped</th></tr></thead><tbody>
    ${results
      .map(
        (r) => `<tr><td>${badge(r.status)}</td><td>${esc(r.name)}</td><td>${r.covers.map((c) => `<span class="tag">${esc(c)}</span>`).join(' ')}</td>
        <td class="num">${secs(r.durationMs)}</td><td class="num">${usd(costOfCase(r.name))}</td>
        <td>${esc(r.status === 'skipped' ? r.skipReason : r.checks.filter((x) => !x.ok).map((x) => x.text).join('; '))}</td></tr>`,
      )
      .join('')}
    </tbody></table>`;

  const cost = `
    <div class="tiles">
      <div class="tile"><b>${usd(s.avgRunCost)}</b><span>average cost per run</span></div>
      <div class="tile"><b>${secs(s.avgRunMs)}</b><span>average time per run</span></div>
      <div class="tile"><b>${s.modelRuns}</b><span>runs that called the model</span></div>
      <div class="tile"><b>${s.modelCalls}</b><span>model calls (one per agent step)</span></div>
    </div>
    <h3>Cost per case</h3>
    <div class="bars">${results
      .filter((r) => r.status !== 'skipped')
      .map((r) => {
        const value = costOfCase(r.name);
        return `<div class="bar"><span class="label">${esc(r.name)}</span><span class="track"><span class="fill" style="width:${((value / maxCost) * 100).toFixed(1)}%"></span></span><span class="num">${usd(value)}</span></div>`;
      })
      .join('')}</div>
    <h3>Every model call</h3>
    <p class="muted">Each step of the agent loop is one call to the model: it either asks for tools or writes the final answer.</p>
    <table><thead><tr><th>Case</th><th>Step</th><th>Model</th><th>Did</th><th>In tokens</th><th>Out tokens</th><th>Cost</th><th>Time</th></tr></thead><tbody>
    ${calls
      .map(
        (c) => `<tr><td>${esc(c.caseName)}</td><td class="num">${c.step}</td><td>${esc(c.model)}</td><td>${esc(c.error ? `error: ${c.error}` : c.did)}</td>
        <td class="num">${c.inputTokens.toLocaleString('en-US')}</td><td class="num">${c.outputTokens.toLocaleString('en-US')}</td>
        <td class="num">${usd(c.costUsd)}</td><td class="num">${secs(c.durationMs)}</td></tr>`,
      )
      .join('')}
    <tr class="total"><td colspan="6">Total</td><td class="num">${usd(s.totalCost)}</td><td class="num">${secs(calls.reduce((t, c) => t + c.durationMs, 0))}</td></tr>
    </tbody></table>`;

  const traces = results
    .map(
      (r) => `<details class="case"><summary>${badge(r.status)} ${esc(r.name)}</summary>
      <p><b>Input:</b> ${esc(r.input)}</p>
      ${r.skipReason ? `<p class="muted">${esc(r.skipReason)}</p>` : ''}
      <ul class="checks">${r.checks.map((x) => `<li class="${x.ok ? 'ok' : 'bad'}">${x.ok ? '✓' : '✗'} ${esc(x.text)}</li>`).join('')}</ul>
      ${r.runs
        .map(
          (run) => `<div class="run"><p><b>Run</b> ${esc(run?.id)}: ${esc(run?.status)}${run?.error ? `, error: ${esc(run.error)}` : ''}</p>
          <p><b>Summary:</b> ${esc(run?.summary)}</p>
          <p><b>Understood:</b></p><pre>${esc(json(run?.requirements))}</pre>
          <p><b>Recommended:</b> ${(run?.recommendations ?? []).map((x: RunBody) => `<span class="tag">${esc(x.reference ?? x.propertyId)}</span> ${esc(x.reason)}`).join('<br>') || 'nothing'}</p>
          <p><b>Proposed:</b></p><pre>${esc(json(run?.proposedActions))}</pre>
          <p><b>Tool calls, in order:</b></p>
          <ol>${(run?.trace ?? [])
            .map(
              (t: RunBody) => `<li><code>${esc(t.tool)}</code> ${esc(JSON.stringify(t.input))} (${t.durationMs} ms)${t.error ? ` <span class="badge fail">ERROR</span> ${esc(t.error)}` : ''}
              <details><summary>output</summary><pre>${esc(json(t.output ?? t.error))}</pre></details></li>`,
            )
            .join('')}</ol></div>`,
        )
        .join('')}
      ${r.extra ? `<p><b>Other data:</b></p><pre>${esc(json(r.extra))}</pre>` : ''}
    </details>`,
    )
    .join('');

  const coverage = `<table><thead><tr><th>TASK.md asks for</th><th>Covered by</th><th>Result</th></tr></thead><tbody>
    ${COVERAGE.map((item) => {
      const cases = results.filter((r) => r.covers.includes(item));
      const status = !cases.length
        ? 'fail'
        : cases.some((r) => r.status === 'fail')
          ? 'fail'
          : cases.every((r) => r.status === 'skipped')
            ? 'skipped'
            : 'pass';
      return `<tr><td>${esc(item)}</td><td>${cases.map((r) => esc(r.name)).join('<br>') || '<i>no case</i>'}</td><td>${badge(status)}</td></tr>`;
    }).join('')}
    </tbody></table>`;

  const [previous, latest] = history.slice(-2).length === 2 ? history.slice(-2) : [undefined, history.at(-1)];
  const names = results.map((r) => r.name);
  const same = previous ? names.every((n) => previous.verdicts[n] === latest?.verdicts[n]) : null;
  const stability = `
    <p>${
      same === null
        ? 'Only one run so far. Run <code>pnpm -C api eval</code> again to compare.'
        : same
          ? '<span class="badge pass">SAME VERDICTS</span> on the last two runs.'
          : '<span class="badge fail">VERDICTS CHANGED</span> between the last two runs.'
    }</p>
    <table><thead><tr><th>Case</th><th>Previous run${previous ? `<br><span class="muted">${esc(previous.at)}</span>` : ''}</th><th>This run<br><span class="muted">${esc(latest?.at)}</span></th></tr></thead><tbody>
    ${names
      .map((n) => `<tr><td>${esc(n)}</td><td>${previous?.verdicts[n] ? badge(previous.verdicts[n]) : '-'}</td><td>${badge(latest?.verdicts[n] ?? '-')}</td></tr>`)
      .join('')}
    </tbody></table>`;

  const tabs: Array<[string, string]> = [
    ['Overview', overview],
    ['Cost', cost],
    ['Traces', traces],
    ['Coverage', coverage],
    ['Stability', stability],
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Assistant Eval Report</title>
<style>
:root { --bg:#f7f7f8; --card:#fff; --text:#16181d; --muted:#6b7280; --line:#e5e7eb; --accent:#2563eb; --pass:#15803d; --pass-bg:#dcfce7; --fail:#b91c1c; --fail-bg:#fee2e2; --skip:#92400e; --skip-bg:#fef3c7; }
@media (prefers-color-scheme: dark) { :root { --bg:#111318; --card:#1a1d24; --text:#e8eaee; --muted:#9aa1ad; --line:#2b2f38; --accent:#60a5fa; --pass:#4ade80; --pass-bg:#14301f; --fail:#f87171; --fail-bg:#3a1616; --skip:#fbbf24; --skip-bg:#3a2c0d; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
header { padding:20px 16px 0; max-width:1200px; margin:0 auto; }
h1 { font-size:20px; margin:0 0 4px; } h3 { margin:24px 0 8px; }
.muted { color:var(--muted); }
nav { display:flex; gap:4px; flex-wrap:wrap; margin-top:16px; border-bottom:1px solid var(--line); }
nav button { border:0; background:none; color:var(--muted); padding:10px 14px; font:inherit; cursor:pointer; border-bottom:2px solid transparent; }
nav button.active { color:var(--text); border-bottom-color:var(--accent); font-weight:600; }
main { max-width:1200px; margin:0 auto; padding:16px; }
section { display:none; } section.active { display:block; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; margin-bottom:16px; }
.tile { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; }
.tile b { display:block; font-size:22px; } .tile span { color:var(--muted); font-size:12px; }
.table-wrap, table { width:100%; }
table { border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; display:block; overflow-x:auto; }
th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:12px; color:var(--muted); font-weight:600; }
td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
tr.total td { font-weight:700; }
.badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; font-weight:700; }
.badge.pass { color:var(--pass); background:var(--pass-bg); } .badge.fail { color:var(--fail); background:var(--fail-bg); } .badge.skipped { color:var(--skip); background:var(--skip-bg); }
.tag { display:inline-block; padding:0 6px; border:1px solid var(--line); border-radius:6px; font-size:12px; margin:1px 0; }
.bars { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px; }
.bar { display:grid; grid-template-columns:minmax(120px, 2fr) 3fr auto; gap:10px; align-items:center; padding:3px 0; }
.bar .label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.track { height:10px; background:var(--line); border-radius:5px; overflow:hidden; } .fill { display:block; height:100%; background:var(--accent); }
details.case { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 14px; margin-bottom:8px; }
details.case > summary { cursor:pointer; font-weight:600; }
.checks { list-style:none; padding:0; } .checks .ok { color:var(--pass); } .checks .bad { color:var(--fail); font-weight:600; }
.run { border-top:1px solid var(--line); margin-top:10px; padding-top:6px; }
pre { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:8px; overflow-x:auto; font-size:12px; max-height:360px; }
code { font-size:12px; }
</style></head>
<body>
<header>
  <h1>Assistant eval report</h1>
  <div class="muted">${esc(startedAt.toISOString())} · ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped · ${usd(s.totalCost)} · ${secs(s.totalMs)}</div>
  <nav>${tabs.map(([name], i) => `<button data-tab="${i}" class="${i === 0 ? 'active' : ''}">${name}</button>`).join('')}</nav>
</header>
<main>${tabs.map(([, body], i) => `<section data-tab="${i}" class="${i === 0 ? 'active' : ''}">${body}</section>`).join('')}</main>
<script>
document.querySelectorAll('nav button').forEach(function (b) {
  b.addEventListener('click', function () {
    document.querySelectorAll('[data-tab]').forEach(function (el) { el.classList.toggle('active', el.dataset.tab === b.dataset.tab); });
  });
});
</script>
</body></html>
`;
}
