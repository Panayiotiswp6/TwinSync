import { useState } from 'react';
import type { Owner, Preference, Source } from '../../../shared/types';
import { ACTIVITY_LABEL, ACTIVITY_TAGS, PREF_META, describePref, formatValue, importanceLabel } from '../../../shared/prefs';
import { api, type AppState } from '../api';
import { Avatar, Badge } from './ui';

interface Props {
  owner: Owner;
  state: AppState;
  sample: string;
  onState: (s: AppState) => void;
  onClose: () => void;
}

function highlightQuote(text: string, quotes: string[]) {
  const spans: [number, number][] = quotes
    .map((q) => {
      const i = text.indexOf(q);
      return i < 0 ? null : ([i, i + q.length] as [number, number]);
    })
    .filter((x): x is [number, number] => x !== null)
    .sort((a, b) => a[0] - b[0]);
  const out: React.ReactNode[] = [];
  let pos = 0;
  spans.forEach(([s, e], i) => {
    if (s < pos) return;
    out.push(text.slice(pos, s), <mark key={i}>{text.slice(s, e)}</mark>);
    pos = e;
  });
  out.push(text.slice(pos));
  return out;
}

function CandidateRow({ p, onState }: { p: Preference; onState: (s: AppState) => void }) {
  const meta = PREF_META[p.key];
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(p.value));
  const [weight, setWeight] = useState(p.weight);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async (fn: () => Promise<AppState>) => {
    setBusy(true);
    setErr(null);
    try {
      onState(await fn());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const done = p.status !== 'candidate';
  return (
    <li className={`candidate ${done ? 'candidate-done' : ''}`}>
      <div className="candidate-head">
        <span className="pref-kind">{meta.kind === 'constraint' ? 'Περιορισμός' : 'Προτίμηση'}</span>
        <strong>{describePref(p)}</strong>
        {meta.kind === 'preference' && <span className="muted small">σημασία {importanceLabel(p.weight)}</span>}
        <span className="muted small">βεβαιότητα {Math.round(p.confidence * 100)}%</span>
        {p.correctedFrom !== undefined && <Badge tone="info">διορθώθηκε από {formatValue(p.key, p.correctedFrom)}</Badge>}
        {p.status === 'confirmed' && <Badge tone="good">Επιβεβαιώθηκε</Badge>}
        {p.status === 'rejected' && <Badge tone="bad">Απορρίφθηκε</Badge>}
        {p.status === 'superseded' && <Badge tone="neutral">Αντικαταστάθηκε</Badge>}
      </div>
      <p className="quote">«{p.sourceRefs[0]?.quote}»</p>
      {!done && editing && (
        <div className="edit-row">
          {meta.valueType === 'boolean' ? (
            <select value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="true">ναι</option>
              <option value="false">όχι</option>
            </select>
          ) : meta.valueType === 'tag' ? (
            <select value={value} onChange={(e) => setValue(e.target.value)} aria-label="Ενδιαφέρον">
              {ACTIVITY_TAGS.map((t) => (
                <option key={t} value={t}>
                  {ACTIVITY_LABEL[t]}
                </option>
              ))}
            </select>
          ) : (
            <input value={value} onChange={(e) => setValue(e.target.value)} aria-label="Τιμή" placeholder={meta.valueType === 'time' ? 'ΩΩ:ΛΛ' : meta.unit} />
          )}
          {meta.kind === 'preference' && (
            <select value={weight} onChange={(e) => setWeight(Number(e.target.value))} aria-label="Σημασία">
              <option value={0.3}>σημασία χαμηλή</option>
              <option value={0.6}>σημασία μέτρια</option>
              <option value={0.9}>σημασία υψηλή</option>
            </select>
          )}
          <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api.confirm(p.id, value, weight))}>
            Αποθήκευση διόρθωσης
          </button>
        </div>
      )}
      {!done && !editing && (
        <div className="btn-row">
          <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api.confirm(p.id))}>
            Επιβεβαίωση
          </button>
          <button className="btn" disabled={busy} onClick={() => setEditing(true)}>
            Διόρθωση
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => run(() => api.reject(p.id))}>
            Απόρριψη
          </button>
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </li>
  );
}

export function TwinBuilder({ owner, state, sample, onState, onClose }: Props) {
  const [text, setText] = useState(sample);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ids: string[]; source?: Source; mode: string; model?: string; note?: string; dropped: number; unmapped: { label: string; quote: string }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const extract = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.ingest(owner.id, text);
      onState(r.state);
      const source = r.state.sources.find((s) => r.candidates[0]?.sourceRefs[0]?.sourceId === s.id);
      const src = source ?? r.state.sources.filter((s) => s.ownerId === owner.id && s.kind === 'owner_input').at(-1);
      setResult({ ids: r.candidates.map((c) => c.id), source: src, mode: r.mode, model: r.model, note: r.note, dropped: r.dropped, unmapped: r.unmapped ?? [] });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const candidates = result ? state.preferences.filter((p) => result.ids.includes(p.id)) : [];

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Δημιουργία Twin" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn drawer-close" onClick={onClose} aria-label="Κλείσιμο">
          ×
        </button>
        <header className="twin-head">
          <Avatar owner={owner} size={40} />
          <div>
            <p className="eyebrow">Πώς δημιουργείται ένα Twin</p>
            <h3>{owner.name}: μάθε από νέο κείμενο</h3>
          </div>
        </header>
        <p className="muted small">
          Επικόλλησε μια σημείωση ή μια παλιότερη απόφαση με αιτιολόγηση. Το {state.status.aiMode === 'live' ? 'AI' : 'demo mode (κανόνες)'} προτείνει
          προτιμήσεις και περιορισμούς. Κάθε στοιχείο δείχνει το απόσπασμα από το οποίο βγήκε. Στο προφίλ μπαίνει μόνο ό,τι επιβεβαιώσει ο κάτοχος.
        </p>
        <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} aria-label="Κείμενο κατόχου" />
        <div className="btn-row">
          <button className="btn btn-primary" onClick={extract} disabled={busy || text.trim().length < 5}>
            {busy ? 'Ανάλυση…' : 'Εξαγωγή υποψήφιων στοιχείων'}
          </button>
          <Badge tone={state.status.aiMode === 'live' ? 'ai' : 'neutral'}>
            {state.status.aiMode === 'live' ? `Live AI · ${state.status.model}` : 'Demo mode · κανόνες, χωρίς κλειδί'}
          </Badge>
        </div>
        {err && <p className="error">{err}</p>}
        {result && (
          <div className="builder-result">
            {result.note && <p className="warn-box">{result.note}</p>}
            {result.source && (
              <blockquote className="source-text">
                <span className="eyebrow">{result.source.id}</span>
                <br />
                {highlightQuote(result.source.text, candidates.map((c) => c.sourceRefs[0]?.quote ?? ''))}
              </blockquote>
            )}
            {candidates.length === 0 ? (
              <p className="muted">
                {result.unmapped.length
                  ? 'Κανένα στοιχείο δεν μπαίνει στο προφίλ απόφασης — δείτε παρακάτω τι κατάλαβε το Twin.'
                  : 'Δεν βρέθηκε κάτι που να στηρίζεται καθαρά στο κείμενο. Το Twin δεν μαντεύει — καμία αλλαγή στο προφίλ.'}
              </p>
            ) : (
              <ul className="plain">
                {candidates.map((p) => (
                  <CandidateRow key={p.id} p={p} onState={onState} />
                ))}
              </ul>
            )}
            {result.unmapped.length > 0 && (
              <div className="unmapped">
                <p className="small">
                  <strong>Το Twin το κατάλαβε, αλλά δεν επηρεάζει ακόμα την απόφαση</strong> — κανένα διήμερο δεν περιγράφεται με αυτό:
                </p>
                <ul className="plain">
                  {result.unmapped.map((u) => (
                    <li key={u.label + u.quote} className="small">
                      • {u.label} <span className="muted">«{u.quote}»</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.dropped > 0 && <p className="muted small">{result.dropped} προτάσεις απορρίφθηκαν αυτόματα γιατί το απόσπασμά τους δεν υπάρχει αυτούσιο στο κείμενο.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
