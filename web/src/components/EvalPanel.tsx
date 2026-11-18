import { useState } from 'react';
import type { EvalReport } from '../../../server/evaluation';
import type { Owner } from '../../../shared/types';
import { api } from '../api';
import { Badge } from './ui';

const OUTCOME = { correct: { label: 'σωστό', tone: 'good' }, wrong: { label: 'λάθος', tone: 'bad' }, uncertain: { label: 'αβέβαιο', tone: 'warn' } } as const;

export function EvalPanel({ owners }: { owners: Owner[] }) {
  const [report, setReport] = useState<EvalReport | null>(null);
  const [busy, setBusy] = useState(false);
  const name = (id: string) => owners.find((o) => o.id === id)?.name ?? id;

  const run = async () => {
    setBusy(true);
    try {
      setReport(await api.evaluation());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card eval">
      <div className="btn-row">
        <button className="btn" onClick={run} disabled={busy}>
          {busy ? 'Εκτέλεση…' : 'Τρέξε την αξιολόγηση'}
        </button>
        <Badge tone="info">Συνθετικά δεδομένα</Badge>
      </div>
      {report && (
        <>
          <h4>
            Πρόβλεψη αποφάσεων που δεν δόθηκαν στο Twin: {report.holdout.correct}/{report.holdout.total} σωστές · {report.holdout.wrong} λάθος · {report.holdout.uncertain}{' '}
            αβέβαιες
          </h4>
          <table className="mini wide">
            <thead>
              <tr>
                <th>Κάτοχος</th>
                <th>Απόφαση</th>
                <th>Αποτέλεσμα</th>
                <th>Σημείωση</th>
              </tr>
            </thead>
            <tbody>
              {report.holdout.rows.map((r) => (
                <tr key={r.id}>
                  <td>{name(r.ownerId)}</td>
                  <td>{r.question}</td>
                  <td>
                    <Badge tone={OUTCOME[r.outcome].tone}>{OUTCOME[r.outcome].label}</Badge>
                  </td>
                  <td className="muted">{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>Σενάρια ροής</h4>
          <ul className="plain">
            {report.scenarios.map((s) => (
              <li key={s.name}>
                <Badge tone={s.pass ? 'good' : 'bad'}>{s.pass ? 'PASS' : 'FAIL'}</Badge> {s.name} <span className="muted small">— {s.detail}</span>
              </li>
            ))}
          </ul>
          <h4>Τι μετράμε</h4>
          <ul className="small muted">
            {report.measures.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
