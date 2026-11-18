import { ChevronDown, ChevronUp, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type AppState } from '../api';
import { go } from './Shell';
import { Avatar } from './ui';

const IDEAS = [
  { emoji: '🧳', text: 'Βρείτε μας ένα τριήμερο για τις 4–6 Δεκεμβρίου' },
  { emoji: '🏞️', text: 'Βρες μας ένα διήμερο αυτό το ΣΚ' },
  { emoji: '🍽️', text: 'Πού να φάμε την Παρασκευή το βράδυ;' },
  { emoji: '🎉', text: 'Έξοδος για ποτό το Σάββατο, κάτι διαφορετικό' },
  { emoji: '🎁', text: 'Τι δώρο να πάρουμε μαζί στη Μαρία για τα γενέθλιά της;' },
];

export const PIPELINE = ['Κατανόηση αιτήματος', 'Ανάκτηση μνήμης', 'Υποψήφιες επιλογές', 'Τα Twins αξιολογούν', 'Κοινή απόφαση'];

export function Working({ live, steps = PIPELINE }: { live: boolean; steps?: string[] }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => Math.min(x + 1, steps.length - 1)), live ? 4200 : 450);
    return () => clearInterval(t);
  }, [live, steps.length]);
  return (
    <div className="working">
      <div className="orb" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <ol>
        {steps.map((s, k) => (
          <li key={s} className={k < i ? 'done' : k === i ? 'now' : ''}>
            {s}
          </li>
        ))}
      </ol>
      <p className="tiny muted">{live ? 'Το AI σκέφτεται — συνήθως 20–60″.' : 'Demo mode — κανόνες, χωρίς AI.'}</p>
    </div>
  );
}

export function Composer({ state, onState, compact }: { state: AppState; onState: (s: AppState) => void; compact?: boolean }) {
  const [text, setText] = useState('');
  const [participants, setParticipants] = useState<string[]>(state.personas.slice(0, 3).map((p) => p.id));
  const [wishes, setWishes] = useState<Record<string, string>>({});
  const [showWishes, setShowWishes] = useState(!compact);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.createRequest(text, participants, wishes);
      onState(r.state);
      go(`/req/${r.requestId}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (busy) return <div className="card composer">{<Working live={state.status.aiMode === 'live'} />}</div>;

  return (
    <div className="card composer">
      <div className="composer-top">
        <span className="composer-icon">
          <Sparkles size={18} />
        </span>
        <textarea rows={compact ? 2 : 3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Τι θέλει να κάνει η παρέα; π.χ. «Βρείτε μας ένα τριήμερο για τις 4–6 Δεκεμβρίου»" aria-label="Αίτημα παρέας" />
      </div>
      <div className="ideas">
        {IDEAS.map((i) => (
          <button key={i.text} className="chip" onClick={() => setText(i.text)}>
            {i.emoji} {i.text}
          </button>
        ))}
      </div>
      <div className="composer-row">
        <div className="who">
          {state.personas.map((p) => {
            const on = participants.includes(p.id);
            return (
              <button key={p.id} className={`who-btn ${on ? 'on' : ''}`} onClick={() => setParticipants((ps) => (on ? ps.filter((x) => x !== p.id) : [...ps, p.id]))} aria-pressed={on}>
                <Avatar persona={p} size={26} /> {p.name}
              </button>
            );
          })}
        </div>
        <button className="link-btn small" onClick={() => setShowWishes((s) => !s)}>
          {showWishes ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Προσωρινές επιθυμίες
        </button>
      </div>
      {showWishes && (
        <div className="wishes">
          {state.personas
            .filter((p) => participants.includes(p.id))
            .map((p) => (
              <label key={p.id} className="wish">
                <Avatar persona={p} size={30} />
                <input
                  value={wishes[p.id] ?? ''}
                  onChange={(e) => setWishes({ ...wishes, [p.id]: e.target.value })}
                  placeholder={`${p.name}: μόνο για αυτό, π.χ. «όχι πάνω από 150€», «μέχρι Δευτέρα να έχουμε γυρίσει», «να γνωρίσουμε νέα άτομα»`}
                />
              </label>
            ))}
        </div>
      )}
      <div className="composer-foot">
        <span className="tiny muted">Τα Twins χρησιμοποιούν τη μόνιμη μνήμη κάθε ατόμου + τις προσωρινές επιθυμίες. Τίποτα δεν κλείνεται χωρίς έγκριση.</span>
        <button className="btn btn-brand" disabled={text.trim().length < 3 || participants.length < 2} onClick={submit}>
          <Sparkles size={16} /> Ρώτα τα Twins
        </button>
      </div>
      {err && <p className="error">{err}</p>}
    </div>
  );
}
