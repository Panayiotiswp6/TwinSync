// Prints the evaluation report (synthetic data). Run: npm run eval
import { runEvaluation } from '../server/evaluation';

const r = runEvaluation();
console.log('TwinSync evaluation — dataset: SYNTHETIC\n');
console.log(`Held-out decisions: ${r.holdout.correct}/${r.holdout.total} correct, ${r.holdout.wrong} wrong, ${r.holdout.uncertain} uncertain`);
for (const row of r.holdout.rows) {
  console.log(`  [${row.outcome.padEnd(9)}] ${row.id} (${row.ownerId}) predicted=${row.predicted} actual=${row.actual} margin=${row.margin} — ${row.note}`);
}
console.log('\nScenarios:');
for (const s of r.scenarios) console.log(`  ${s.pass ? 'PASS' : 'FAIL'}  ${s.name} — ${s.detail}`);
console.log('\nRule extractor recall on seed sources:');
for (const e of r.extraction) console.log(`  ${e.ownerId}: recall ${e.recall} expected=[${e.expected}] found=[${e.found}]`);
console.log('\nWhat is measured:');
for (const m of r.measures) console.log(`  - ${m}`);
process.exitCode = r.scenarios.every((s) => s.pass) ? 0 : 1;
