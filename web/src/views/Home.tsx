import { Heart, MessageCircle, Plus } from 'lucide-react';
import { useState } from 'react';
import type { AppState } from '../api';
import { Composer } from '../components/Composer';
import { NewTwinModal } from '../components/NewTwinModal';
import { go } from '../components/Shell';
import { Avatar, AvatarStack, Badge, CATEGORY, Empty, timeAgo } from '../components/ui';
import { formatWhen } from '../../../shared/time';

export function Stories({ state, onState }: { state: AppState; onState: (s: AppState) => void }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="stories">
      {state.personas.map((p) => {
        const pending = state.memory.some((m) => m.personaId === p.id && m.status === 'candidate');
        return (
          <button key={p.id} className="story" onClick={() => go(`/twin/${p.id}`)}>
            <span className={`story-ring ${pending ? 'pending' : ''}`}>
              <Avatar persona={p} size={62} />
            </span>
            <span className="story-name">{p.name}</span>
          </button>
        );
      })}
      <button className="story" onClick={() => setAdding(true)}>
        <span className="story-ring add">
          <span className="story-add">
            <Plus size={26} />
          </span>
        </span>
        <span className="story-name">Νέο Twin</span>
      </button>
      {adding && <NewTwinModal onClose={() => setAdding(false)} onState={onState} live={state.status.aiMode === 'live'} />}
    </div>
  );
}

export function Home({ state, onState }: { state: AppState; onState: (s: AppState) => void }) {
  const posts = [...state.requests].reverse();
  return (
    <div className="home">
      <div className="feed">
        <Stories state={state} onState={onState} />
        <Composer state={state} onState={onState} compact />
        {posts.length === 0 && (
          <Empty emoji="✨" title="Καμία απόφαση ακόμα">
            Γράψτε τι θέλει να κάνει η παρέα — τα Twins θα προτείνουν και θα συμφωνήσουν.
          </Empty>
        )}
        {posts.map((r) => {
          const d = state.decisions.filter((x) => x.requestId === r.id).at(-1);
          const people = r.participants.map((id) => state.personas.find((p) => p.id === id)!).filter(Boolean);
          const chosen = d?.options.find((o) => o.id === d.outcome.chosenOptionId);
          const approvals = d ? Object.values(d.approvals).filter((a) => a === 'approved').length : 0;
          return (
            <article key={r.id} className="post card" onClick={() => go(`/req/${r.id}`)}>
              <header className="post-head">
                <AvatarStack personas={people} />
                <div>
                  <strong>{r.title}</strong>
                  <div className="tiny muted">
                    {CATEGORY[r.category].label} · {timeAgo(r.createdAt)}
                  </div>
                </div>
              </header>
              <div className="post-cover" style={{ background: CATEGORY[r.category].grad }}>
                <span className="post-emoji">{chosen?.emoji ?? (d?.outcome.status === 'deadlock' ? '🤔' : CATEGORY[r.category].emoji)}</span>
                <div className="post-cover-text">
                  {d?.outcome.status === 'deadlock' ? (
                    <>
                      <span className="eyebrow light">Αδιέξοδο</span>
                      <h3>Δεν βρέθηκε κάτι για όλους</h3>
                    </>
                  ) : (
                    <>
                      <span className="eyebrow light">Πρόταση των Twins</span>
                      <h3>{chosen?.title ?? '—'}</h3>
                      {chosen && (
                        <span className="cover-chips">
                          {chosen.costPerPerson !== null && <span>{chosen.costPerPerson}€/άτομο</span>}
                          {chosen.endsAt && <span>έως {formatWhen(chosen.endsAt)}</span>}
                          {chosen.location && <span>{chosen.location}</span>}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
              <footer className="post-foot">
                <span className="post-action">
                  <Heart size={20} className={approvals ? 'liked' : ''} /> {approvals}/{people.length} εγκρίσεις
                </span>
                <span className="post-action">
                  <MessageCircle size={20} /> {d?.outcome.votes.length ?? 0} ψήφοι Twins
                </span>
                {d?.status === 'approved' && <Badge tone="good">Εγκρίθηκε</Badge>}
                {d?.aiModel ? <Badge tone="ai">AI</Badge> : <Badge tone="neutral">demo</Badge>}
              </footer>
            </article>
          );
        })}
      </div>
      <aside className="rail">
        <div className="card rail-card">
          <p className="eyebrow">Πώς δουλεύει</p>
          <ol className="how">
            <li>
              <b>Μόνιμη μνήμη:</b> κάθε Twin μαθαίνει από αρχεία, chats, emails και παλιές αποφάσεις του κατόχου.
            </li>
            <li>
              <b>Αίτημα + επιθυμίες:</b> ό,τι θέλει η παρέα, με προσωρινά όρια ανά άτομο.
            </li>
            <li>
              <b>AI σκέφτεται:</b> προτείνει επιλογές και κάθε Twin τις κρίνει με παραπομπές στη μνήμη του.
            </li>
            <li>
              <b>Ο κώδικας εγγυάται:</b> όρια κόστους/χρόνου, δίκαιη κοινή απόφαση, ανθρώπινη έγκριση.
            </li>
          </ol>
        </div>
        <div className="card rail-card">
          <p className="eyebrow">Η παρέα</p>
          {state.personas.map((p) => (
            <button key={p.id} className="rail-person" onClick={() => go(`/twin/${p.id}`)}>
              <Avatar persona={p} size={36} />
              <span>
                <b>{p.name}</b>
                <span className="tiny muted">@{p.handle}</span>
              </span>
              <span className="tiny muted">{state.memory.filter((m) => m.personaId === p.id && m.status === 'confirmed' && m.scope === 'profile').length} αναμνήσεις</span>
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}
