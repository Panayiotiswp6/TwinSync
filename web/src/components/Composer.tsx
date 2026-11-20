import { ChevronDown, ChevronUp, MapPin, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type AppState } from '../api';
import { go } from './Shell';
import { LiveTwinChat } from './TwinChat';
import { Avatar } from './ui';

const IDEAS = [
  { emoji: '☕', text: 'Καφές στο Παγκράτι το Σάββατο στις 16:30, ως 8€, κάπου ήσυχο' },
  { emoji: '🍸', text: 'Ποτό στο κέντρο την Παρασκευή μετά τις 21:30, ως 25€' },
  { emoji: '🧳', text: 'Τετραήμερο στο εξωτερικό 4–7 Δεκεμβρίου, ως 450€' },
  { emoji: '🎶', text: 'Live μουσική το Σάββατο 12 Δεκεμβρίου μετά τις 21:00, ως 30€' },
  { emoji: '🏞️', text: 'Βρες μας ένα διήμερο αυτό το ΣΚ' },
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
        <label className="city-field small" title="Πού βρίσκεται η παρέα. Αν το γράψει το αίτημα («είμαστε στη Θεσσαλονίκη»), μετράει εκείνο.">
          📍
          <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Αθήνα (παραδοχή)" aria-label="Πόλη της παρέας" />
        </label>
        <label className="city-field pick-field small" title="Προαιρετικό: ένα συγκεκριμένο μέρος που θέλετε να ελέγξουν τα Twins — αν ταιριάζει σε όλους και με ποιον αντικρούεται.">
          <MapPin size={14} />
          <input value={pick} onChange={(e) => setPick(e.target.value)} placeholder="Συγκεκριμένο μέρος; π.χ. The Clumsies" aria-label="Συγκεκριμένο μέρος για έλεγχο" />
        </label>
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
                  placeholder={`${p.name}: μόνο για αυτό (μετράει πάνω από το προφίλ), π.χ. «ως 500€ όλα μαζί», «Δευτέρα πρωί πίσω», «θέλω θάλασσα»`}
                />
              </label>
            ))}
        </div>
      )}
      <div className="composer-foot">
        <span className="tiny muted">Οι επιθυμίες για αυτό το αίτημα μετράνε πάνω από το μόνιμο προφίλ. Τίποτα δεν κλείνεται χωρίς έγκριση.</span>
        <button className="btn btn-brand" disabled={text.trim().length < 3 || participants.length < 2} onClick={submit}>
          <Sparkles size={16} /> Ρώτα τα Twins
        </button>
      </div>
      {err && <p className="error">{err}</p>}
    </div>
  );
}
