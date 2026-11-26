/**
 * Side-by-side comparison of two eval runs: who chose the tools, Claude or Jev.
 *   pnpm -C api exec tsx evals/compare.ts   (after `TOOL_PLANNER=claude pnpm eval` and `TOOL_PLANNER=jev pnpm eval`,
 *                                            with each run's results copied to evals/results-claude and evals/results-jev)
 * Writes evals/compare.html and evals/compare.md. Every number comes from the saved traces; nothing is estimated.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Check {
  ok: boolean;
  text: string;
}
interface ModelCall {
  model: string;
  costUsd: number;
  durationMs: number;
}
interface Run {
  costUsd?: number | string;
  createdAt?: string;
  finishedAt?: string | null;
  status?: string;
  toolPlanner?: { name?: string; costUsd?: number } | null;
  trace?: Array<{ tool: string; input?: unknown }>;
}
interface CaseTrace {
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  checks?: Check[];
  durationMs: number;
  runs?: Run[];
  modelCalls?: ModelCall[];
  error?: string;
}

interface Side {
  status: CaseTrace['status'] | 'missing';
  durationMs: number;
  claudeUsd: number;
  jevUsd: number;
  runUsd: number;
  tools: string;
  failed: string[];
}

const DIR = __dirname;
const SIDES = [
  { key: 'claude', label: 'Claude chooses the tools', dir: join(DIR, 'results-claude', 'traces') },
  { key: 'jev', label: 'Jev chooses the tools', dir: join(DIR, 'results-jev', 'traces') },
] as const;

function load(dir: string): Map<string, CaseTrace> {
  const cases = new Map<string, CaseTrace>();
  if (!existsSync(dir)) return cases;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const trace = JSON.parse(readFileSync(join(dir, file), 'utf8')) as CaseTrace;
    cases.set(trace.name, trace);
  }
  return cases;
}

function side(trace: CaseTrace | undefined): Side {
  if (!trace) return { status: 'missing', durationMs: 0, claudeUsd: 0, jevUsd: 0, runUsd: 0, tools: '', failed: [] };
  const runs = trace.runs ?? [];
  return {
    status: trace.status,
    durationMs: trace.durationMs,
    claudeUsd: (trace.modelCalls ?? []).reduce((s, c) => s + c.costUsd, 0),
    jevUsd: runs.reduce((s, r) => s + (r?.toolPlanner?.name === 'jev' ? Number(r.toolPlanner.costUsd ?? 0) : 0), 0),
    runUsd: runs.reduce((s, r) => s + Number(r?.costUsd ?? 0), 0),
    tools: runs
      .flatMap((r) => (r?.trace ?? []).map((t) => t.tool))
      .reduce<string[]>((acc, t) => acc.concat(t), [])
      .join(', '),
    failed: [...(trace.checks ?? []).filter((c) => !c.ok).map((c) => c.text), ...(trace.error ? [trace.error] : [])],
  };
}

const usd = (n: number) => (n === 0 ? '0' : n < 0.001 ? n.toFixed(6) : n.toFixed(4));
const sec = (ms: number) => (ms / 1000).toFixed(1);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const [claude, jev] = SIDES.map((s) => load(s.dir));
const names = [...new Set([...claude.keys(), ...jev.keys()])];
const rows = names.map((name) => ({ name, claude: side(claude.get(name)), jev: side(jev.get(name)) }));

function totals(pick: (r: (typeof rows)[number]) => Side) {
  const sides = rows.map(pick);
  const active = sides.filter((s) => s.status === 'pass' || s.status === 'fail');
  return {
    pass: sides.filter((s) => s.status === 'pass').length,
    fail: sides.filter((s) => s.status === 'fail').length,
    skipped: sides.filter((s) => s.status === 'skipped').length,
    active: active.length,
    totalMs: sides.reduce((s, x) => s + x.durationMs, 0),
    claudeUsd: sides.reduce((s, x) => s + x.claudeUsd, 0),
    jevUsd: sides.reduce((s, x) => s + x.jevUsd, 0),
  };
}
const tc = totals((r) => r.claude);
const tj = totals((r) => r.jev);
const differ = rows.filter((r) => r.claude.status !== r.jev.status);

// Markdown, for the repo and the deck.
const md = [
  '# Eval comparison: who chooses the tools',
  '',
  `Generated ${new Date().toISOString()} from evals/results-claude and evals/results-jev (every number from the saved traces).`,
  '',
  '| | Claude chooses | Jev chooses |',
  '| --- | --- | --- |',
  `| Passed | ${tc.pass} of ${tc.active} active | ${tj.pass} of ${tj.active} active |`,
  `| Failed | ${tc.fail} | ${tj.fail} |`,
  `| Skipped (parts not built) | ${tc.skipped} | ${tj.skipped} |`,
  `| Total time (s) | ${sec(tc.totalMs)} | ${sec(tj.totalMs)} |`,
  `| Claude cost (USD) | ${usd(tc.claudeUsd)} | ${usd(tj.claudeUsd)} |`,
  `| Jev cost (USD) | ${usd(tc.jevUsd)} | ${usd(tj.jevUsd)} |`,
  '',
  '| Case | Claude | Jev | Time s (C / J) | Tools (C / J) |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map(
    (r) =>
      `| ${r.name.replace(/\|/g, '/')} | ${r.claude.status} | ${r.jev.status} | ${sec(r.claude.durationMs)} / ${sec(r.jev.durationMs)} | ${r.claude.tools || 'none'} / ${r.jev.tools || 'none'} |`,
  ),
  '',
  differ.length ? '## Cases with different verdicts' : '## Same verdict on every case',
  ...differ.map(
    (r) =>
      `- **${r.name}**: Claude ${r.claude.status}, Jev ${r.jev.status}. Failed checks: Claude: ${r.claude.failed.join('; ') || 'none'}. Jev: ${r.jev.failed.join('; ') || 'none'}.`,
  ),
  '',
].join('\n');
writeFileSync(join(DIR, 'compare.md'), md);

const pill = (status: string) => `<span class="pill ${status}">${status}</span>`;
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eval comparison</title>
<style>
:root { --bg:#f6f7f9; --card:#fff; --ink:#111827; --muted:#6b7280; --line:#e5e7eb; --pass:#047857; --pass-bg:#d1fae5; --fail:#b91c1c; --fail-bg:#fee2e2; --skip:#6b7280; --skip-bg:#f3f4f6; --hl:#fffbeb; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#0b0f17; --card:#111827; --ink:#f3f4f6; --muted:#9ca3af; --line:#1f2937; --pass:#6ee7b7; --pass-bg:#064e3b; --fail:#fca5a5; --fail-bg:#7f1d1d; --skip:#9ca3af; --skip-bg:#1f2937; --hl:#3b2f0a; } }
body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 system-ui, -apple-system, sans-serif; }
main { max-width:1100px; margin:0 auto; padding:24px 16px; }
h1 { font-size:20px; margin:0 0 4px; } p.sub { color:var(--muted); margin:0 0 20px; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; margin-bottom:20px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
.card h2 { font-size:14px; margin:0 0 8px; } .big { font-size:28px; font-weight:700; }
.kv { display:flex; justify-content:space-between; color:var(--muted); } .kv b { color:var(--ink); font-weight:600; }
.table { background:var(--card); border:1px solid var(--line); border-radius:12px; overflow-x:auto; }
table { width:100%; border-collapse:collapse; } th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:12px; color:var(--muted); font-weight:600; } tr.differ td { background:var(--hl); }
.pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; font-weight:600; }
.pill.pass { color:var(--pass); background:var(--pass-bg); } .pill.fail { color:var(--fail); background:var(--fail-bg); } .pill.skipped, .pill.missing { color:var(--skip); background:var(--skip-bg); }
.why { color:var(--fail); font-size:12px; margin-top:4px; } .muted { color:var(--muted); font-size:12px; }
</style></head><body><main>
<h1>Eval comparison: who chooses the tools</h1>
<p class="sub">Same eval suite, same Claude model writing the answer. Left: Claude chooses and calls the tools. Right: Jev chooses, code runs them, Claude writes with no tools. Every number is read from the saved traces.</p>
<div class="grid">
${[
  ['Claude chooses the tools', tc],
  ['Jev chooses the tools', tj],
]
  .map(
    ([label, t]) => `<div class="card"><h2>${label}</h2><div class="big">${(t as typeof tc).pass} / ${(t as typeof tc).active}</div>
<div class="kv"><span>Failed</span><b>${(t as typeof tc).fail}</b></div>
<div class="kv"><span>Skipped (parts not built)</span><b>${(t as typeof tc).skipped}</b></div>
<div class="kv"><span>Total time</span><b>${sec((t as typeof tc).totalMs)} s</b></div>
<div class="kv"><span>Claude cost</span><b>USD ${usd((t as typeof tc).claudeUsd)}</b></div>
<div class="kv"><span>Jev cost</span><b>USD ${usd((t as typeof tc).jevUsd)}</b></div></div>`,
  )
  .join('\n')}
<div class="card"><h2>Different verdicts</h2><div class="big">${differ.length}</div><div class="muted">Highlighted rows below.</div></div>
</div>
<div class="table"><table>
<thead><tr><th>Case</th><th>Claude chooses</th><th>Jev chooses</th><th>Time (s)</th><th>Cost USD (Claude / Jev part)</th><th>Tool calls</th></tr></thead>
<tbody>
${rows
  .map(
    (r) => `<tr class="${r.claude.status !== r.jev.status ? 'differ' : ''}"><td>${esc(r.name)}</td>
<td>${pill(r.claude.status)}${r.claude.failed.map((f) => `<div class="why">${esc(f)}</div>`).join('')}</td>
<td>${pill(r.jev.status)}${r.jev.failed.map((f) => `<div class="why">${esc(f)}</div>`).join('')}</td>
<td>${sec(r.claude.durationMs)} / ${sec(r.jev.durationMs)}</td>
<td>${usd(r.claude.claudeUsd)} / ${usd(r.jev.claudeUsd)} + jev ${usd(r.jev.jevUsd)}</td>
<td class="muted">C: ${esc(r.claude.tools || 'none')}<br>J: ${esc(r.jev.tools || 'none')}</td></tr>`,
  )
  .join('\n')}
</tbody></table></div>
</main></body></html>`;
writeFileSync(join(DIR, 'compare.html'), html);
console.log(`compare.html and compare.md written: Claude ${tc.pass}/${tc.active}, Jev ${tj.pass}/${tj.active}, ${differ.length} different verdict(s).`);
