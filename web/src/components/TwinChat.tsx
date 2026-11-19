import { ArrowRight, Info } from 'lucide-react';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { ChatLine, JobEvent, Persona, TwinChat } from '../../../shared/types';
import { api, type AppState } from '../api';
import { Avatar, AvatarStack, Badge } from './ui';

/** Instagram-like group DM header. */
function DmHead({ people, live, sub }: { people: Persona[]; live: boolean; sub: string }) {
  return (
    <header className="dm-head">
      <AvatarStack personas={people} size={30} />
      <div>
        <b>{people.map((p) => p.name.split(' ')[0]).join(', ')}</b>
        <div className="tiny muted">
          <span className={`dm-dot ${live ? 'on' : ''}`} /> {sub}
        </div>
      </div>
    </header>
  );
}

function Bubble({ p, text, kind, showHead }: { p: Persona; text: string; kind: JobEvent['kind']; showHead: boolean }) {
  return (
    <div className={`dm-row ${showHead ? 'head' : ''}`}>
      <span className="dm-ava">{showHead && <Avatar persona={p} size={28} />}</span>
      <div className="dm-col">
        {showHead && <span className="dm-name">{p.name}</span>}
        <div className={`dm-bubble ${kind}`}>
          {kind === 'think' && <span className="dm-tag">💭 σκέφτεται</span>}
          {kind === 'vote' && <span className="dm-tag">🗳️ ψηφίζει</span>}
          {text}
        </div>
      </div>
    </div>
  );
}

function Typing({ p }: { p: Persona }) {
  return (
    <div className="dm-row head">
      <span className="dm-ava">
        <Avatar persona={p} size={28} />
      </span>
      <div className="dm-col">
        <div className="dm-bubble typing" aria-label={`${p.name} γράφει…`}>
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}

function renderEvents(events: JobEvent[], people: Persona[]) {
  const out: ReactElement[] = [];
  let prev = '';
  events.forEach((e, i) => {
    const p = people.find((x) => x.id === e.who);
    if (!p || e.kind === 'info' || e.kind === 'join' || e.kind === 'options' || e.kind === 'error') {
      prev = '';
      out.push(
        e.kind === 'options' ? (
          <div key={i} className="dm-card">
            <span className="tiny muted">Επιλογές που βρέθηκαν</span>
            {e.text.split('\n').map((l) => (
              <div key={l}>{l}</div>
            ))}
          </div>
        ) : (
          <p key={i} className={`dm-sys ${e.kind === 'error' ? 'bad' : ''}`}>
            {p && e.kind === 'join' && <Avatar persona={p} size={16} />} {e.text}
          </p>
        ),
      );
      return;
    }
    out.push(<Bubble key={i} p={p} text={e.text} kind={e.kind} showHead={prev !== p.id} />);
    prev = p.id;
  });
  return out;
}

/** Live: polls a job and plays its events as a group DM, with typing indicators. */
export function LiveTwinChat({ jobId, people, onDone, onError }: { jobId: string; people: Persona[]; onDone: (state: AppState, result: Record<string, string>) => void; onError: (msg: string) => void }) {
  const [queue, setQueue] = useState<JobEvent[]>([]);
  const [shown, setShown] = useState<JobEvent[]>([]);
  const [typing, setTyping] = useState<Persona | null>(null);
  const [done, setDone] = useState<{ state: AppState; result: Record<string, string> } | null>(null);
  const since = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const fail = useRef(onError);
  fail.current = onError;

  // Poll the job.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const j = await api.job(jobId, since.current);
        if (!alive) return;
        since.current = j.total;
        if (j.events.length) setQueue((q) => [...q, ...j.events]);
        if (j.status === 'done' && j.state) return setDone({ state: j.state, result: j.result ?? {} });
        if (j.status === 'error') return fail.current(j.error ?? 'Σφάλμα');
      } catch (e) {
        if (!alive) return;
        if ((e as Error).message === 'not found') return fail.current('Η εργασία χάθηκε (επανεκκίνηση server;)');
      }
      timer = setTimeout(tick, 800);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [jobId]);

  // Play the queue one message at a time; dialogue lines get a typing indicator first.
  const who = useRef(people);
  who.current = people;
  const head = queue[0];
  useEffect(() => {
    if (!head) return;
    const p = who.current.find((x) => x.id === head.who);
    const say = head.kind === 'say' && !!p;
    setTyping(say ? p! : null);
    const t = setTimeout(
      () => {
        setTyping(null);
        setShown((s) => [...s, head]);
        setQueue((q) => q.slice(1));
      },
      say ? Math.min(2200, 700 + head.text.length * 18) : head.kind === 'think' ? 650 : 380,
    );
    return () => clearTimeout(t);
  }, [head]);

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: 'smooth' });
  }, [shown, typing]);

  const finished = done && !queue.length && !typing;
  const waiting = !done && !queue.length && !typing;
  const someone = people[(shown.length + 1) % Math.max(people.length, 1)];
  return (
    <div className="dm">
      <DmHead people={people} live={!finished} sub={finished ? 'ολοκληρώθηκε' : 'τα Twins συζητούν τώρα'} />
      <div className="dm-body" ref={box}>
        {renderEvents(shown, people)}
        {typing && <Typing p={typing} />}
        {waiting && someone && <Typing p={someone} />}
      </div>
      <footer className="dm-foot">
        {finished ? (
          <button className="btn btn-brand" onClick={() => onDone(done!.state, done!.result)}>
            Δες την πρόταση <ArrowRight size={16} />
          </button>
        ) : (
          <>
            <span className="tiny muted">Live AI: συνήθως 30–60″. Τα Twins γράφουν όπως οι κάτοχοί τους.</span>
            {done && (
              <button className="link-btn small" onClick={() => onDone(done.state, done.result)}>
                Παράλειψη →
              </button>
            )}
          </>
        )}
      </footer>
    </div>
  );
}

/** Static: the stored negotiation of a decision. */
export function TwinChatView({ chat, people }: { chat: TwinChat | undefined; people: Persona[] }) {
  if (!chat?.lines.length) return null;
  const events: JobEvent[] = chat.lines.map((l: ChatLine, i) => ({ at: i, who: l.personaId, kind: 'say', text: l.text }));
  return (
    <section>
      <h3 className="sec-title">
        Η συζήτηση των Twins <Badge tone={chat.mode === 'live' ? 'ai' : 'neutral'}>{chat.mode === 'live' ? 'ύφος κάθε κατόχου · AI' : 'πρότυπο'}</Badge>
      </h3>
      <div className="dm dm-static">
        <DmHead people={people} live={false} sub="ομαδική συνομιλία" />
        <div className="dm-body">{renderEvents(events, people)}</div>
        {chat.note && (
          <footer className="dm-foot tiny muted">
            <Info size={13} /> {chat.note}
          </footer>
        )}
      </div>
      <p className="tiny muted">Κάθε μήνυμα ελέγχεται σε κώδικα: αριθμοί και επιλογές πρέπει να υπάρχουν στα δεδομένα της απόφασης, αλλιώς απορρίπτεται.</p>
    </section>
  );
}
