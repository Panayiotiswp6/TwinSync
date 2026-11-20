import { ChevronDown, Plus } from 'lucide-react';
import { api, type AppState } from '../api';
import { Composer } from '../components/Composer';
import { go } from '../components/Shell';
import { AvatarStack, CATEGORY, timeAgo } from '../components/ui';
import { formatWhen } from '../../../shared/time';

function Welcome({ state, onState }: { state: AppState; onState: (s: AppState) => void }) {
  return (
    <section className="card welcome">
      <h2>Ένα AI Twin για κάθε φίλο</h2>
      <p className="muted">
        Κάθε μέλος της παρέας απαντά σε μια σύντομη συνέντευξη μέσα στην εφαρμογή (χρήματα ανά περίσταση, χρόνος, φαγητό, ταξίδια, πώς αποφασίζει, πώς γράφει). Το Twin του μαθαίνει από αυτή — και από κάθε αίτημα που εγκρίνει — και μετά τα Twins συζητούν και συμφωνούν για λογαριασμό σας.
      </p>
      <div className="welcome-actions">
        <button className="btn btn-brand big" onClick={() => go('/onboard')}>
          <Plus size={17} /> Φτιάξε το πρώτο Twin
        </button>
        {state.personas.length === 0 && (
          <button className="btn" onClick={async () => onState(await api.reset(state.status.teamSeed ? 'team' : 'synthetic'))}>
            {state.status.teamSeed ? 'Δοκίμασε με την παρέα μας' : 'Δοκίμασε με συνθετική παρέα'}
          </button>
        )}
      </div>
      {state.personas.length === 1 && <p className="small">Χρειάζεται τουλάχιστον ακόμα ένα Twin για κοινή απόφαση.</p>}
    </section>
  );
}

/** The four steps, short and folded. */
function HowItWorks({ open }: { open?: boolean }) {
  return (
    <details className="card how-it-works" open={open}>
      <summary>
        Πώς δουλεύει <ChevronDown size={14} />
      </summary>
      <ol className="how">
        <li>
          <b>Μνήμη:</b> κάθε Twin μαθαίνει από τη συνέντευξη, μηνύματα και παλιές αποφάσεις του κατόχου.
        </li>
        <li>
          <b>Αίτημα:</b> ό,τι θέλει η παρέα, με προσωρινές επιθυμίες ανά άτομο.
        </li>
        <li>
          <b>AI:</b> προτείνει επιλογές και κάθε Twin τις κρίνει με παραπομπές στη μνήμη του.
        </li>
        <li>
          <b>Κώδικας και άνθρωποι:</b> όρια κόστους/χρόνου, δίκαιη κοινή απόφαση, ανθρώπινη έγκριση.
        </li>
      </ol>
    </details>
  );
}

export function Home({ state, onState }: { state: AppState; onState: (s: AppState) => void }) {
  const posts = [...state.requests].reverse();
  if (state.personas.length < 2 && !posts.length) {
    return (
      <div className="home">
        <div className="feed">
          <Welcome state={state} onState={onState} />
        </div>
      </div>
    );
  }
  return (
    <div className="home">
      <div className="feed">
        <Composer state={state} onState={onState} compact />
        <HowItWorks />
        {posts.length > 0 && <h3 className="feed-title">Προηγούμενα αιτήματα</h3>}
        {posts.map((r) => {
          const d = state.decisions.filter((x) => x.requestId === r.id).at(-1);
          const people = r.participants.map((id) => state.personas.find((p) => p.id === id)!).filter(Boolean);
          const chosen = d?.options.find((o) => o.id === d.outcome.chosenOptionId);
          const approvals = d ? Object.values(d.approvals).filter((a) => a === 'approved').length : 0;
          const status = !d ? null : !chosen ? { tone: 'warn', text: 'Χωρίς πρόταση' } : d.status === 'approved' ? { tone: 'good', text: 'Εγκρίθηκε' } : d.outcome.status === 'compromise' ? { tone: 'warn', text: 'Δεν καλύπτει όλους' } : { tone: 'good', text: 'Κοινή πρόταση' };
          return (
            <a key={r.id} className="post card" href={`#/req/${r.id}`}>
              <div className="post-main">
                <p className="eyebrow">
                  {CATEGORY[r.category].label} · {timeAgo(r.createdAt)}
                </p>
                <strong className="post-title">{r.title}</strong>
                {chosen && (
                  <p className="small post-sub">
                    <b>{chosen.venue?.name ?? chosen.title}</b>
                    {chosen.startsAt ? <span className="nowrap"> · {formatWhen(chosen.startsAt)}</span> : ''}
                    {chosen.costPerPerson !== null ? <span className="nowrap"> · ≈{chosen.costPerPerson}€/άτομο</span> : ''}
                  </p>
                )}
              </div>
              <div className="post-side">
                {status && <span className={`state ${status.tone}`}>{status.text}</span>}
                <span className="tiny muted">
                  {approvals}/{people.length} εγκρίσεις
                </span>
                <AvatarStack personas={people} size={20} />
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
