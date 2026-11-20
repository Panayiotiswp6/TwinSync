import { FlaskConical } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type AppState, type EvalReport, type HoldoutReport } from '../api';
import { Avatar, Badge, InfoTip, Spinner } from '../components/ui';

const OUT = { correct: { label: 'σωστό', tone: 'good' }, wrong: { label: 'λάθος', tone: 'bad' }, uncertain: { label: 'αβέβαιο', tone: 'warn' } } as const;

function HoldoutTable({ r, state }: { r: HoldoutReport; state: AppState }) {
  return (
    <div className="card eval-card">
      <div className="eval-head">
        <h3>{r.method === 'live' ? `🤖 Live AI · ${r.model}` : '⚙️ Ευρετικό demo (χωρίς AI)'}</h3>
        <span className="big-score">
          {r.correct}/{r.total}
        </span>
      </div>
      <p className="small muted">
        {r.correct} σωστές · {r.wrong} λάθος · {r.uncertain} αβέβαιες · {new Date(r.ranAt).toLocaleString('el-GR')}
      </p>
      {r.error && <p className="error">{r.error}</p>}
      <table className="eval-table">
        <tbody>
          {r.rows.map((row) => {
            const p = state.personas.find((x) => x.id === row.personaId);
            return (
              <tr key={row.id}>
                <td>{p && <Avatar persona={p} size={26} />}</td>
                <td>
                  <span className="meta-row">
                    <b className="small">{row.question}</b>
                    <InfoTip size={13} label="Αιτιολόγηση πρόβλεψης">
                      <p>{row.why}</p>
                      <p className="muted">Πραγματικά: {row.note}</p>
                    </InfoTip>
                  </span>
                  {row.origin === 'imported' && <Badge tone="brand">πραγματική απόφαση κατόχου</Badge>}
                </td>
                <td>
                  <Badge tone={OUT[row.outcome].tone}>{OUT[row.outcome].label}</Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Eval({ state, onState }: { state: AppState; onState: () => void }) {
  const [report, setReport] = useState<EvalReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.evaluation().then(setReport).catch((e) => setErr(e.message));
  }, []);
  const runLive = async () => {
    setBusy(true);
    setErr(null);
    try {
      setReport(await api.evaluationLive());
      onState();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="eval">
      <h2>
        <FlaskConical size={22} /> Αξιολόγηση: είναι πραγματικά «αυτοί»;
      </h2>
      <p className="muted">
        Κάθε Twin προβλέπει 8 παλιές (συνθετικές) αποφάσεις του κατόχου του που <b>δεν του δόθηκαν ποτέ ως πηγή</b>. Διαφορά βαθμολογίας &lt; 3 μετρά ως «αβέβαιο», όχι ως σωστό. Δύο από τις
        αποφάσεις εξαρτώνται σκόπιμα από πράγματα που το Twin δεν μπορεί να ξέρει.
      </p>
      {!report && !err && <Spinner label="Φόρτωση…" />}
      {err && <p className="error">{err}</p>}
      {report && (
        <>
          <div className="eval-grid">
            {report.live ? (
              <HoldoutTable r={report.live} state={state} />
            ) : (
              <div className="card eval-card">
                <h3>🤖 Live AI</h3>
                <p className="small muted">{state.status.aiMode === 'live' ? 'Τρέξτε την πρόβλεψη με το AI (8 μικρές κλήσεις).' : 'Χρειάζεται κλειδί AI στο .env.'}</p>
              </div>
            )}
            <HoldoutTable r={report.heuristic} state={state} />
          </div>
          <button className="btn btn-brand" disabled={busy || state.status.aiMode !== 'live'} onClick={runLive}>
            {busy ? <Spinner label="Το AI προβλέπει…" /> : 'Τρέξε live αξιολόγηση με AI'}
          </button>
          <div className="card eval-card">
            <h3>✅ Σενάρια λογικής ομάδας</h3>
            <ul className="plain scen">
              {report.scenarios.map((s) => (
                <li key={s.name}>
                  <span className="meta-row">
                    <Badge tone={s.pass ? 'good' : 'bad'}>{s.pass ? 'PASS' : 'FAIL'}</Badge> <b className="small">{s.name}</b>
                    <InfoTip size={13} label="Λεπτομέρειες σεναρίου">{s.detail}</InfoTip>
                  </span>
                </li>
              ))}
            </ul>
            {!!report.planChecks?.length && (
              <>
                <h3>📍 Ποιότητα προτάσεων</h3>
                <ul className="plain scen">
                  {report.planChecks.map((s) => (
                    <li key={s.name}>
                      <span className="meta-row">
                        <Badge tone={s.pass ? 'good' : 'bad'}>{s.pass ? 'PASS' : 'FAIL'}</Badge> <b className="small">{s.name}</b>
                        <InfoTip size={13} label="Λεπτομέρειες ελέγχου">{s.detail}</InfoTip>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="tiny muted">
              Ακεραιότητα δεδομένων: {report.integrity.personas} Twins · {report.integrity.sources} πηγές · {report.integrity.memoryItems} αναμνήσεις · {report.integrity.verifiedQuotes} παραπομπές επαληθευμένες ως αυτούσια
              αποσπάσματα.
            </p>
          </div>
          <div className="card eval-card">
            <h3>Τι μετράμε</h3>
            <ul className="small muted">
              {report.measures.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
