import { useMemo, useState } from 'react';
import type { Decision, Owner, Preference, PrefKey, TripOption } from '../../../shared/types';
import { ACTIVITY_LABEL, ACTIVITY_TAGS, PREF_META, describePref, formatValue } from '../../../shared/prefs';
import { STANCE_THRESHOLDS } from '../../../shared/engine';
import { api, type AppState } from '../api';
import { Avatar, Badge, Cite, Details, Section, type OpenSource } from './ui';

const STANCE: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' }> = {
  agree: { label: 'Συμφωνεί', tone: 'good' },
  agree_with_concession: { label: 'Συμφωνεί με παραχώρηση', tone: 'warn' },
  object: { label: 'Διαφωνεί', tone: 'bad' },
};
const CONFIDENCE: Record<string, string> = { low: 'χαμηλή', medium: 'μέτρια', high: 'υψηλή' };

function Score({ value }: { value: number }) {
  return (
    <span className="score" title={`${value}/100`}>
      <span className="score-bar" style={{ width: `${value}%` }} />
      <span className="score-num">{value}</span>
    </span>
  );
}

function TripFacts({ t }: { t: TripOption }) {
  return (
    <ul className="facts">
      <li>
        <strong>{t.pricePerPerson}€</strong>/άτομο
      </li>
      <li>Επιστροφή Κυρ. {t.returnSunday}</li>
      <li>{t.hikeHours ? `${t.hikeHours}h πεζοπορία` : 'χωρίς πεζοπορία'}</li>
      <li>{t.seaAccess >= 0.9 ? 'θάλασσα' : t.seaAccess > 0 ? 'σύντομη βουτιά' : 'χωρίς θάλασσα'}</li>
      <li>{t.stay.label}</li>
    </ul>
  );
}

// ---------- Positions ----------
function Positions({ d, owners, trips, onOpen }: { d: Decision; owners: Owner[]; trips: TripOption[]; onOpen: OpenSource }) {
  const trip = (id: string | null) => trips.find((t) => t.id === id);
  return (
    <div className="twin-grid">
      {d.result.positions.map((pos) => {
        const o = owners.find((x) => x.id === pos.ownerId)!;
        const vote = trip(pos.voteOptionId);
        const best = pos.reasons.find((r) => r.effect === 'for') ?? pos.reasons[0];
        return (
          <article className="card" key={pos.ownerId}>
            <header className="twin-head">
              <Avatar owner={o} />
              <div>
                <p className="eyebrow">{o.name} · το Twin ψηφίζει</p>
                <h3>{vote ? vote.name : 'Καμία επιλογή'}</h3>
              </div>
            </header>
            {best ? (
              <p className="why">
                <span className="why-label">Γιατί:</span> {best.text} <Cite refs={best.sourceRefs} onOpen={onOpen} />
              </p>
            ) : (
              <p className="muted">Χωρίς επιβεβαιωμένες προτιμήσεις — η ψήφος βγαίνει μόνο από τους περιορισμούς.</p>
            )}
            <p className="small muted">
              Βεβαιότητα ψήφου: <strong>{CONFIDENCE[pos.confidence]}</strong>
            </p>
            <Details summary="Όλη η αιτιολόγηση">
              <ul className="plain reasons">
                {pos.reasons.map((r) => (
                  <li key={r.prefId} className={r.effect === 'for' ? 'for' : 'against'}>
                    {r.effect === 'for' ? '＋' : '－'} {r.text} <Cite refs={r.sourceRefs} onOpen={onOpen} />
                  </li>
                ))}
                {pos.constraints.map((r) => (
                  <li key={r.prefId} className="constraint">
                    ⛔ {r.text} <Cite refs={r.sourceRefs} onOpen={onOpen} />
                  </li>
                ))}
              </ul>
              <table className="mini">
                <tbody>
                  {pos.ranking.map((r) => (
                    <tr key={r.optionId}>
                      <td>{trip(r.optionId)?.name}</td>
                      <td>
                        <Score value={r.score} />
                      </td>
                      <td>{r.okForMe ? '' : <Badge tone="bad">εκτός δικών του ορίων</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {pos.uncertainties.length > 0 && (
                <ul className="plain uncertain">
                  {pos.uncertainties.map((u) => (
                    <li key={u}>? {u}</li>
                  ))}
                </ul>
              )}
            </Details>
          </article>
        );
      })}
    </div>
  );
}

// ---------- Options & constraints ----------
function Options({ d, owners, trips, onOpen }: { d: Decision; owners: Owner[]; trips: TripOption[]; onOpen: OpenSource }) {
  const name = (id: string) => owners.find((o) => o.id === id)?.name ?? id;
  return (
    <div className="options">
      {d.result.options.map((ev) => {
        const t = trips.find((x) => x.id === ev.optionId)!;
        const chosen = d.result.chosenOptionId === t.id;
        return (
          <article key={t.id} className={`card option ${chosen ? 'option-chosen' : ''} ${ev.feasible ? '' : 'option-out'}`}>
            <header className="option-head">
              <div>
                <h4>{t.name}</h4>
                <p className="muted small">{t.region}</p>
              </div>
              {chosen ? <Badge tone="good">Κοινή πρόταση</Badge> : ev.feasible ? <Badge tone="neutral">Εφικτό</Badge> : <Badge tone="bad">Αποκλείεται</Badge>}
            </header>
            <TripFacts t={t} />
            {!ev.feasible && (
              <ul className="plain violations">
                {ev.violations.map((v) => (
                  <li key={v.prefId + t.id}>
                    ⛔ <strong>{name(v.ownerId)}</strong>: {v.message}
                    {v.scope === 'trip' && <Badge tone="warn">μόνο αυτό το ΣΚ</Badge>} <Cite refs={v.sourceRefs} onOpen={onOpen} />
                  </li>
                ))}
              </ul>
            )}
            <Details summary="Βαθμολογία ανά Twin & λεπτομέρειες">
              <table className="mini">
                <tbody>
                  {Object.entries(ev.scores).map(([oid, s]) => (
                    <tr key={oid}>
                      <td>{name(oid)}</td>
                      <td>
                        <Score value={s} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="small muted">Δραστηριότητες: {t.activities.join(' · ')}</p>
              {t.tags && (
                <p className="small muted">
                  Χαρακτηριστικά:{' '}
                  {ACTIVITY_TAGS.filter((tag) => (t.tags?.[tag] ?? 0) >= 0.3)
                    .map((tag) => `${ACTIVITY_LABEL[tag]}${(t.tags?.[tag] ?? 0) >= 0.7 ? ' ●●' : ' ●'}`)
                    .join(' · ')}
                </p>
              )}
              <p className="small muted">
                Τιμή: {t.priceNote} — ενδεικτική τιμή demo, όχι live. Αναχώρηση Σάββατο {t.departSaturday}.
              </p>
            </Details>
          </article>
        );
      })}
    </div>
  );
}

// ---------- Corrections ----------
const CORRECTABLE: PrefKey[] = ['budget_max', 'return_by', 'requires_private_bath', 'no_camping', 'likes_hiking', 'likes_sea', 'prefers_comfort', 'prefers_low_cost', 'max_hike_hours', 'likes_activity', 'avoids_activity'];

function Corrections({ owners, inputs, onDecision }: { owners: Owner[]; inputs: Preference[]; onDecision: (r: { decision: Decision; state: AppState }) => void }) {
  const [ownerId, setOwnerId] = useState(owners.find((o) => o.id === 'geo')?.id ?? owners[0].id);
  const [key, setKey] = useState<PrefKey>('budget_max');
  const current = inputs.find((p) => p.ownerId === ownerId && p.key === key);
  const meta = PREF_META[key];
  const [value, setValue] = useState<string>('110');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pickKey = (k: PrefKey) => {
    setKey(k);
    const cur = inputs.find((p) => p.ownerId === ownerId && p.key === k);
    const m = PREF_META[k];
    setValue(cur ? String(cur.value) : m.valueType === 'boolean' ? 'true' : m.valueType === 'tag' ? 'nightlife' : m.valueType === 'time' ? '20:00' : '100');
  };

  const submit = async (scope: 'trip' | 'profile') => {
    setBusy(true);
    setErr(null);
    try {
      onDecision(await api.correct({ ownerId, key, value, scope }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card correction">
      <div className="correction-grid">
        <label>
          Κάτοχος
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Τι διορθώνει
          <select value={key} onChange={(e) => pickKey(e.target.value as PrefKey)}>
            {CORRECTABLE.map((k) => (
              <option key={k} value={k}>
                {PREF_META[k].label} ({PREF_META[k].kind === 'constraint' ? 'περιορισμός' : 'προτίμηση'})
              </option>
            ))}
          </select>
        </label>
        <label>
          Νέα τιμή
          {meta.valueType === 'boolean' ? (
            <select value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="true">ναι</option>
              <option value="false">όχι</option>
            </select>
          ) : meta.valueType === 'tag' ? (
            <select value={value} onChange={(e) => setValue(e.target.value)}>
              {ACTIVITY_TAGS.map((t) => (
                <option key={t} value={t}>
                  {ACTIVITY_LABEL[t]}
                </option>
              ))}
            </select>
          ) : (
            <input value={value} onChange={(e) => setValue(e.target.value)} inputMode={meta.valueType === 'number' ? 'numeric' : 'text'} placeholder={meta.valueType === 'time' ? 'ΩΩ:ΛΛ' : meta.unit} />
          )}
        </label>
      </div>
      <p className="small muted">Τώρα: {current ? `${describePref(current)}${current.scope === 'trip' ? ' (μόνο αυτό το ΣΚ)' : ''}` : 'δεν υπάρχει στο προφίλ — άγνωστο'}</p>
      <div className="btn-row">
        <button className="btn btn-primary" disabled={busy} onClick={() => submit('trip')}>
          Μόνο για αυτό το διήμερο
        </button>
        <button className="btn" disabled={busy} onClick={() => submit('profile')}>
          Αποθήκευση στο προφίλ
        </button>
      </div>
      {err && <p className="error">{err}</p>}
    </div>
  );
}

// ---------- Main ----------
export function DecisionView({
  decision,
  state,
  onOpen,
  onDecision,
  onState,
}: {
  decision: Decision;
  state: AppState;
  onOpen: OpenSource;
  onDecision: (r: { decision: Decision; state: AppState }) => void;
  onState: (s: AppState) => void;
}) {
  const owners = state.owners.filter((o) => decision.request.participants.includes(o.id));
  const trips = state.trips;
  const chosen = trips.find((t) => t.id === decision.result.chosenOptionId);
  const tripOverrides = useMemo(() => decision.inputs.filter((p) => p.scope === 'trip'), [decision]);
  const name = (id: string) => owners.find((o) => o.id === id)?.name ?? id;
  const [busy, setBusy] = useState(false);

  const approve = async (ownerId: string, ok: boolean) => {
    setBusy(true);
    try {
      onState(await api.approve(decision.id, ownerId, ok));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section step={4} id="decision" title="Κοινή απόφαση" subtitle="Οι περιορισμοί ελέγχονται σε κώδικα· ανάμεσα στις εφικτές κερδίζει όποια κρατά πιο ψηλά τον λιγότερο ικανοποιημένο.">
        {decision.diff && decision.diff.changes.length > 0 && (
          <div className="diff">
            <strong>Τι άλλαξε από την προηγούμενη εκτέλεση ({decision.diff.previousDecisionId}):</strong>
            <ul>
              {decision.diff.changes.map((c) => (
                <li key={c}>{c}</li>
              ))}
              {decision.diff.priceDelta !== null && decision.diff.priceDelta !== 0 && (
                <li>
                  Κόστος: {decision.diff.priceDelta > 0 ? '+' : ''}
                  {decision.diff.priceDelta}€/άτομο
                </li>
              )}
            </ul>
          </div>
        )}

        {decision.result.status === 'agreement' && chosen ? (
          <div className="card result result-ok">
            <div className="result-main">
              <p className="eyebrow">Πρόταση των Twins · {decision.request.weekendLabel}</p>
              <h3>{chosen.name}</h3>
              <TripFacts t={chosen} />
              <ul className="plain rationale">
                {decision.result.rationale.slice(-2).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
            <div className="concessions">
              {decision.result.concessions.map((c) => (
                <div key={c.ownerId} className="concession">
                  <div className="concession-head">
                    <Avatar owner={owners.find((o) => o.id === c.ownerId)!} size={28} />
                    <strong>{name(c.ownerId)}</strong>
                    <Badge tone={STANCE[c.stance].tone}>{STANCE[c.stance].label}</Badge>
                    <Score value={c.finalScore} />
                  </div>
                  {c.items.length ? (
                    <ul className="plain small">
                      {c.items.map((i) => (
                        <li key={i}>↘ {i}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="small muted">Παίρνει τη δική του ψήφο — καμία παραχώρηση.</p>
                  )}
                </div>
              ))}
              <p className="tiny muted">
                Όρια στάσης: ≥{STANCE_THRESHOLDS.agree} συμφωνεί · {STANCE_THRESHOLDS.concede}–{STANCE_THRESHOLDS.agree - 1} με παραχώρηση · &lt;{STANCE_THRESHOLDS.concede} διαφωνεί.
              </p>
            </div>
          </div>
        ) : (
          <div className="card result result-deadlock">
            <p className="eyebrow">Αδιέξοδο · {decision.request.weekendLabel}</p>
            <h3>Καμία επιλογή δεν περνά όλους τους υποχρεωτικούς περιορισμούς</h3>
            <p>Τα Twins δεν διαλέγουν κάτι που παραβιάζει όριο κατόχου. Τι θα το ξεμπλόκαρε:</p>
            <ul className="plain relax">
              {decision.result.relaxations.map((r) => (
                <li key={r.prefId + r.optionId}>→ {r.message}</li>
              ))}
              {!decision.result.relaxations.length && <li>Καμία μεμονωμένη αλλαγή δεν αρκεί — χρειάζεται συζήτηση ή νέες επιλογές.</li>}
            </ul>
          </div>
        )}

        <h4 className="sub">Υποψήφια διήμερα</h4>
        <Options d={decision} owners={owners} trips={trips} onOpen={onOpen} />
      </Section>

      <Section step={5} id="correct" title="Διόρθωση & έγκριση" subtitle="Ο κάτοχος έχει τον τελευταίο λόγο. Δοκιμάστε: Γιώργος → όριο κόστους 110 → «Μόνο για αυτό το διήμερο».">
        {tripOverrides.length > 0 && (
          <div className="overrides">
            <span className="small muted">Ενεργές αλλαγές μόνο για αυτό το διήμερο:</span>
            {tripOverrides.map((p) => (
              <span key={p.id} className="chip">
                {name(p.ownerId)}: {describePref(p)}
                <button
                  className="chip-x"
                  aria-label="Αφαίρεση"
                  onClick={async () => onDecision(await api.removeOverride(p.id))}
                  title="Αφαίρεση και νέα εκτέλεση"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <Corrections key={decision.id} owners={owners} inputs={decision.inputs} onDecision={onDecision} />

        {decision.result.status === 'agreement' && chosen && (
          <div className="card approvals">
            <h4>Ανθρώπινη έγκριση της πρότασης «{chosen.name}»</h4>
            <p className="small muted">Τίποτα δεν κλείνεται αυτόματα. Κάθε κάτοχος εγκρίνει ή απορρίπτει την πρόταση του Twin του.</p>
            <div className="approval-grid">
              {owners.map((o) => {
                const a = decision.approvals[o.id];
                return (
                  <div key={o.id} className="approval">
                    <Avatar owner={o} size={28} />
                    <span>{o.name}</span>
                    {a === 'pending' ? (
                      <span className="btn-row">
                        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => approve(o.id, true)}>
                          Εγκρίνω
                        </button>
                        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => approve(o.id, false)}>
                          Απορρίπτω
                        </button>
                      </span>
                    ) : (
                      <Badge tone={a === 'approved' ? 'good' : 'bad'}>{a === 'approved' ? 'Ενέκρινε' : 'Απέρριψε'}</Badge>
                    )}
                  </div>
                );
              })}
            </div>
            {decision.status === 'approved' && <p className="ok-box">✓ Εγκρίθηκε από όλους. Το επόμενο βήμα (κράτηση) γίνεται από ανθρώπους.</p>}
            {decision.status === 'rejected' && <p className="warn-box">Απορρίφθηκε. Κάντε μια διόρθωση παραπάνω και ξανατρέξτε.</p>}
          </div>
        )}
        <p className="tiny muted">
          Τιμές που χρησιμοποίησε αυτή η εκτέλεση ({decision.id}):{' '}
          {decision.inputs.map((p) => `${name(p.ownerId)} ${PREF_META[p.key].label}=${formatValue(p.key, p.value)}`).join(' · ')}
        </p>
      </Section>
    </>
  );
}

export { Positions };
