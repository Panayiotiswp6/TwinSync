import { LogOut, MessageCircle, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { MemoryItem, Persona } from '../../../shared/types';
import { api, type AppState } from '../api';
import { go } from '../components/Shell';
import { Avatar, Badge, type OpenSource } from '../components/ui';

interface Turn {
  role: 'user' | 'twin';
  text: string;
  used?: Pick<MemoryItem, 'id' | 'statement' | 'refs'>[];
}

const MAX_TURNS = 30;

function Picker({ state }: { state: AppState }) {
  return (
    <div className="narrow">
      <h2>Chat με ένα Twin</h2>
      <p className="muted small">Ιδιωτική συζήτηση με ένα μόνο Twin, για ό,τι θέλεις. Απαντά σύντομα, όπως θα απαντούσε ο πραγματικός άνθρωπος — με το ύφος και τη μνήμη του. Η συζήτηση δεν αποθηκεύεται.</p>
      <div className="twin-cards">
        {state.personas.map((p) => (
          <div key={p.id} className="card twin-card" role="button" tabIndex={0} onClick={() => go(`/chat/${p.id}`)} onKeyDown={(e) => e.key === 'Enter' && go(`/chat/${p.id}`)}>
            <Avatar persona={p} size={64} ring />
            <b>{p.name}</b>
            <span className="small muted">{p.bio}</span>
            <span className="btn btn-sm">
              <MessageCircle size={14} /> Συνομίλησε
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Conversation({ persona, state, onOpen }: { persona: Persona; state: AppState; onOpen: OpenSource }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: 'smooth' });
  }, [turns, busy]);

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    const next: Turn[] = [...turns, { role: 'user', text: t }];
    setTurns(next);
    setText('');
    setBusy(true);
    setErr(null);
    try {
      const r = await api.privateChat(persona.id, next.map(({ role, text }) => ({ role, text })));
      setTurns([...next, { role: 'twin', text: r.reply, used: r.used }]);
      setNote(r.note ?? null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const end = () => {
    setTurns([]);
    go('/chat');
  };
  const full = turns.length >= MAX_TURNS;

  return (
    <div className="narrow">
      <div className="dm private-chat">
        <header className="dm-head">
          <Avatar persona={persona} size={36} ring />
          <div>
            <b>{persona.name}</b>
            <div className="tiny muted">
              <span className="dm-dot on" /> Twin · ιδιωτική συζήτηση, δεν αποθηκεύεται
            </div>
          </div>
          <span className="spacer" />
          <Badge tone={state.status.aiMode === 'live' ? 'ai' : 'warn'}>{state.status.aiMode === 'live' ? 'ύφος κατόχου · AI' : 'demo mode'}</Badge>
          <button className="btn btn-sm" onClick={end} title="Τέλος συζήτησης">
            <LogOut size={14} /> Τέλος
          </button>
        </header>
        <div className="dm-body" ref={box}>
          {!turns.length && <p className="dm-sys">Γράψε στο Twin του/της {persona.name.split(' ')[0]} για ό,τι θέλεις — π.χ. «τι λες, πάμε για ποτό την Παρασκευή;» ή «πού να πάω διακοπές;»</p>}
          {turns.map((t, i) =>
            t.role === 'user' ? (
              <div key={i} className="dm-row me">
                <div className="dm-col">
                  <div className="dm-bubble mine">{t.text}</div>
                </div>
              </div>
            ) : (
              <div key={i} className="dm-row head">
                <span className="dm-ava">
                  <Avatar persona={persona} size={28} />
                </span>
                <div className="dm-col">
                  <div className="dm-bubble">{t.text}</div>
                  {!!t.used?.length && (
                    <details className="dm-why tiny muted">
                      <summary>βάσει της μνήμης του ({t.used.length})</summary>
                      <ul className="plain">
                        {t.used.map((u) => (
                          <li key={u.id}>
                            {u.statement}{' '}
                            {u.refs[0] && (
                              <button type="button" className="cite" onClick={() => onOpen(u.refs[0])} title={`«${u.refs[0].quote}»`}>
                                πηγή
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              </div>
            ),
          )}
          {busy && (
            <div className="dm-row head">
              <span className="dm-ava">
                <Avatar persona={persona} size={28} />
              </span>
              <div className="dm-col">
                <div className="dm-bubble typing" aria-label={`${persona.name} γράφει…`}>
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </div>
          )}
        </div>
        <footer className="dm-foot private-input">
          <input
            value={text}
            maxLength={500}
            disabled={busy || full}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder={full ? 'Η συζήτηση έφτασε το όριο — πάτα «Τέλος» για νέα' : `Μήνυμα στο Twin του/της ${persona.name.split(' ')[0]}…`}
            aria-label="Μήνυμα"
          />
          <button className="btn btn-brand" onClick={send} disabled={busy || full || !text.trim()} aria-label="Αποστολή">
            <Send size={16} />
          </button>
        </footer>
      </div>
      {note && <p className="tiny muted">{note}</p>}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

export function PrivateChat({ id, state, onOpen }: { id?: string; state: AppState; onOpen: OpenSource }) {
  const persona = id ? state.personas.find((p) => p.id === id) : undefined;
  if (!persona) return <Picker state={state} />;
  return <Conversation key={persona.id} persona={persona} state={state} onOpen={onOpen} />;
}
