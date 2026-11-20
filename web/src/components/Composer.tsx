import { Check, ChevronDown, ChevronUp, MapPin, Sparkles, Store } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type AppState } from '../api';
import { go } from './Shell';
import { LiveTwinChat } from './TwinChat';
import { Avatar, shortName } from './ui';

/** Short samples; each fills in a complete request. */
const IDEAS = [
  { label: 'Καφές', text: 'Καφές στο Παγκράτι το Σάββατο στις 16:30, ως 8€, κάπου ήσυχο' },
  { label: 'Βραδινή έξοδος', text: 'Ποτό στο κέντρο την Παρασκευή μετά τις 21:30, ως 25€' },
  { label: 'Live μουσική', text: 'Live μουσική το Σάββατο 12 Δεκεμβρίου μετά τις 21:00, ως 30€' },
  { label: 'Διήμερο', text: 'Βρες μας ένα διήμερο αυτό το ΣΚ' },
  { label: 'Τετραήμερο', text: 'Τετραήμερο στο εξωτερικό 4–7 Δεκεμβρίου, ως 450€' },
];
const CITY_KEY = 'twinsync.city';
const readCity = () => {
  try {
    return localStorage.getItem(CITY_KEY) || '';
  } catch {
    return '';
  }
};

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
  const [participants, setParticipants] = useState<string[]>(state.personas.slice(0, 4).map((p) => p.id));
  const [wishes, setWishes] = useState<Record<string, string>>({});
  const [pick, setPick] = useState('');
  const [showWishes, setShowWishes] = useState(!compact);
  const [busy, setBusy] = useState(false);
  const [city, setCity] = useState(readCity);
  const [jobId, setJobId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      try {
        if (city.trim()) localStorage.setItem(CITY_KEY, city.trim());
      } catch {
        /* remembered city is only a convenience */
      }
      setJobId((await api.createRequestAsync(text, participants, wishes, city.trim() || 'Αθήνα', !city.trim(), pick.trim() || undefined)).jobId);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  if (state.personas.length < 2) {
    return (
      <div className="card composer">
        <p className="muted small">Χρειάζονται τουλάχιστον δύο Twins για ένα αίτημα της παρέας.</p>
        <button className="btn btn-brand" onClick={() => go('/onboard')}>
          <Sparkles size={16} /> Φτιάξε Twin
        </button>
      </div>
    );
  }

  if (busy && jobId) {
    const people = participants.map((id) => state.personas.find((p) => p.id === id)!).filter(Boolean);
    return (
      <LiveTwinChat
        jobId={jobId}
        people={people}
        onDone={(s, r) => {
          onState(s);
          go(`/req/${r.requestId}`);
        }}
        onError={(m) => {
          setErr(m);
          setBusy(false);
          setJobId(null);
        }}
      />
    );
  }
  if (busy) return <div className="card composer">{<Working live={state.status.aiMode === 'live'} />}</div>;

  const chosen = state.personas.filter((p) => participants.includes(p.id));
  return (
    <div className="card composer">
      <label className="composer-label" htmlFor="ask">
        Τι θέλει να κάνει η παρέα;
      </label>
      <textarea id="ask" rows={compact ? 2 : 3} value={text} onChange={(e) => setText(e.target.value)} placeholder="π.χ. «Ποτό στο κέντρο την Παρασκευή μετά τις 22:00, κάπου με μουσική»" />
      <div className="samples" aria-label="Παραδείγματα">
        {IDEAS.map((i) => (
          <button key={i.label} type="button" className={`chip ${text === i.text ? 'chip-on' : ''}`} onClick={() => setText(i.text)} title={i.text}>
            {i.label}
          </button>
        ))}
      </div>
      <div className="composer-who" role="group" aria-label="Ποιοι συμμετέχουν">
        <span className="tiny muted">Ποιοι:</span>
        {state.personas.map((p) => {
          const on = participants.includes(p.id);
          return (
            <button key={p.id} type="button" className={`who-btn ${on ? 'on' : ''}`} onClick={() => setParticipants((ps) => (on ? ps.filter((x) => x !== p.id) : [...ps, p.id]))} aria-pressed={on} title={p.name}>
              <Avatar persona={p} size={20} /> {shortName(p, state.personas)}
              {on && <Check size={13} />}
            </button>
          );
        })}
      </div>
      <details className="composer-more" open={showWishes}>
        <summary onClick={(e) => {
          e.preventDefault();
          setShowWishes((x) => !x);
        }}>
          {showWishes ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Περισσότερα: πόλη, συγκεκριμένο μέρος, προσωρινές επιθυμίες
        </summary>
        <div className="composer-fields">
          <label className="field-inline small" title="Πού βρίσκεται η παρέα. Αν το γράψει το αίτημα («είμαστε στη Θεσσαλονίκη»), μετράει εκείνο.">
            <MapPin size={14} />
            <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Πόλη: Αθήνα (παραδοχή)" aria-label="Πόλη της παρέας" />
          </label>
          <label className="field-inline small" title="Προαιρετικό: ένα συγκεκριμένο μέρος που θέλετε να ελέγξουν τα Twins — αν ταιριάζει σε όλους και με ποιον αντικρούεται.">
            <Store size={14} />
            <input value={pick} onChange={(e) => setPick(e.target.value)} placeholder="Συγκεκριμένο μέρος (π.χ. The Clumsies)" aria-label="Συγκεκριμένο μέρος για έλεγχο" />
          </label>
        </div>
        <div className="wishes">
          {chosen.map((p) => (
            <label key={p.id} className="wish">
              <Avatar persona={p} size={24} />
              <input value={wishes[p.id] ?? ''} onChange={(e) => setWishes({ ...wishes, [p.id]: e.target.value })} placeholder={`${shortName(p, state.personas)}: μόνο για αυτό, π.χ. «ως 500€ όλα μαζί», «θέλω θάλασσα»`} aria-label={`Προσωρινή επιθυμία: ${p.name}`} />
            </label>
          ))}
        </div>
      </details>
      <div className="composer-foot">
        <span className="tiny muted">Τίποτα δεν κλείνεται χωρίς ανθρώπινη έγκριση.</span>
        <button className="btn btn-brand big" disabled={text.trim().length < 3 || participants.length < 2} onClick={submit}>
          <Sparkles size={16} /> Ρώτα τα Twins
        </button>
      </div>
      {err && <p className="error">{err}</p>}
    </div>
  );
}
