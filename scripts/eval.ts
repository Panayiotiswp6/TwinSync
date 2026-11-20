// Prints the offline evaluation (synthetic data, no AI cost). Run: npm run eval
// For the live AI held-out evaluation use the UI ("Αξιολόγηση") or POST /api/eval/live.
import { evaluationReport } from '../server/evaluation';

const r = evaluationReport();
console.log('TwinSync evaluation — dataset: SYNTHETIC\n');
console.log('Integrity:', r.integrity);
const h = r.heuristic;
console.log(`\nHeld-out (demo heuristic): ${h.correct}/${h.total} correct, ${h.wrong} wrong, ${h.uncertain} uncertain`);
for (const row of h.rows) console.log(`  [${row.outcome.padEnd(9)}] ${row.id} predicted=${row.predicted} actual=${row.actual} margin=${row.margin} — ${row.note}`);
if (r.live) console.log(`\nHeld-out (live ${r.live.model}, ${r.live.ranAt}): ${r.live.correct}/${r.live.total} correct, ${r.live.wrong} wrong, ${r.live.uncertain} uncertain`);
console.log('\nScenarios:');
for (const s of r.scenarios) console.log(`  ${s.pass ? 'PASS' : 'FAIL'}  ${s.name} — ${s.detail}`);
console.log('\nProposal quality (separate from fidelity and group logic):');
for (const s of r.planChecks) console.log(`  ${s.pass ? 'PASS' : 'FAIL'}  ${s.name} — ${s.detail}`);
console.log('\nWhat is measured:');
for (const m of r.measures) console.log(`  - ${m}`);
process.exitCode = [...r.scenarios, ...r.planChecks].every((s) => s.pass) ? 0 : 1;
