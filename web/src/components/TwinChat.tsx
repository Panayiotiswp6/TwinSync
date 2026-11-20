import { ArrowRight, Check, Pencil, RefreshCw, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { ChatLine, JobEvent, Persona, TwinChat } from '../../../shared/types';
import { api, type AppState } from '../api';
import { Avatar, AvatarStack, Badge, InfoTip, shortName } from './ui';

/** Instagram-like group DM header. */
function DmHead({ people, live, sub }: { people: Persona[]; live: boolean; sub: string }) {
  return (
    <header className="dm-head">
      <AvatarStack personas={people} size={30} />
      <div>
        <b>{people.map((p) => shortName(p, people)).join(', ')}</b>
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

/** Each twin with a small thought cloud: it pulses while they think; tap it to read what they remember. */
function Thinkers({ people, thoughts, thinking }: { people: Persona[]; thoughts: Record<string, string[]>; thinking: boolean }) {
  const who = people.filter((p) => thoughts[p.id]?.length);
  if (!who.length) return null;
  return (
    <div className="dm-thinkers">
      {who.map((p) => (
        <span key={p.id} className="thinker">
          <Avatar persona={p} size={22} />
          <span className="tiny">{shortName(p, people)}</span>
          <InfoTip
            className={`cloud ${thinking ? 'pulse' : ''}`}
            trigger={<span aria-hidden>💭</span>}
            label={`Τι σκέφτεται ${p.name}`}
            title={`${p.name.split(' ')[0]} — τι θυμάται`}
            wide
          >
            <ul className="tip-bullets">
              {thoughts[p.id].map((t, i) => (
                <li key={i}>{t.replace(/^Θυμάμαι:\s*/, '')}</li>
              ))}
            </ul>
          </InfoTip>
        </span>
      ))}
    </div>
  );
}

/** Live: polls a job and plays its events as a group DM, with typing indicators. */
export function LiveTwinChat({ jobId, people, onDone, onError }: { jobId: string; people: Persona[]; onDone: (state: AppState, result: Record<string, string>) => void; onError: (msg: string) => void }) {
  const [queue, setQueue] = useState<JobEvent[]>([]);
  const [shown, setShown] = useState<JobEvent[]>([]);
  const [typing, setTyping] = useState<Persona | null>(null);
  const [done, setDone] = useState<{ state: AppState; result: Record<string, string> } | null>(null);
  const [thoughts, setThoughts] = useState<Record<string, string[]>>({});
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
        if (j.events.length) {
          // Thoughts ("Θυμάμαι: …") do not go into the chat: they gather behind each twin's thought cloud.
          const think = j.events.filter((e) => e.kind === 'think' && e.who !== 'system');
          if (think.length)
            setThoughts((t) => {
              const n = { ...t };
              for (const e of think) n[e.who] = [...(n[e.who] ?? []), e.text];
              return n;
            });
          const rest = j.events.filter((e) => !(e.kind === 'think' && e.who !== 'system'));
          if (rest.length) setQueue((q) => [...q, ...rest]);
        }
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
      <Thinkers people={people} thoughts={thoughts} thinking={!finished} />
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

/** One stored chat line; the owner can correct what their twin said (pencil). */
function EditableLine({ p, text, edited, showHead, onEdit, onUndo }: { p: Persona; text: string; edited: boolean; showHead: boolean; onEdit?: (t: string) => void; onUndo?: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className={`dm-row ${showHead ? 'head' : ''}`}>
      <span className="dm-ava">{showHead && <Avatar persona={p} size={28} />}</span>
      <div className="dm-col">
        {showHead && <span className="dm-name">{p.name}</span>}
        {draft !== null ? (
          <div className="dm-edit">
            <textarea rows={2} value={draft} maxLength={300} autoFocus onChange={(e) => setDraft(e.target.value)} aria-label={`Διόρθωση μηνύματος: ${p.name}`} />
            <div className="dm-edit-actions">
              <button className="btn btn-sm" onClick={() => setDraft(null)}>
                Άκυρο
              </button>
              <button
                className="btn btn-sm btn-brand"
                disabled={draft.trim().length < 2 || draft.trim() === text}
                onClick={() => {
                  onEdit?.(draft.trim());
                  setDraft(null);
                }}
              >
                <Check size={14} /> Αποθήκευση
              </button>
            </div>
          </div>
        ) : (
          <div className="dm-line">
            <div className={`dm-bubble say ${edited ? 'edited' : ''}`}>{text}</div>
            {onEdit && (
              <button className="dm-pen" onClick={() => setDraft(text)} aria-label={`Διόρθωση: ${p.name}`} title="Διόρθωσε τι είπε το Twin σου">
                <Pencil size={13} />
              </button>
            )}
            {edited && onUndo && (
              <button className="dm-pen" onClick={onUndo} aria-label="Αναίρεση διόρθωσης" title="Αναίρεση">
                <RotateCcw size={13} />
              </button>
            )}
          </div>
        )}
        {edited && draft === null && <span className="dm-edited tiny">διορθώθηκε</span>}
      </div>
    </div>
  );
}

/** Static: the stored negotiation of a decision. Owners can correct their twin's lines and re-run from them. */
export function TwinChatView({ chat, people, onRegenerate, preview }: { chat: TwinChat | undefined; people: Persona[]; onRegenerate?: (edits: { personaId: string; text: string }[]) => void; preview?: number }) {
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [all, setAll] = useState(false);
  if (!chat?.lines.length) return null;
  const shown = preview && !all ? chat.lines.slice(0, preview) : chat.lines;
  const n = Object.keys(edits).length;
  let prev = '';
  return (
    <section>
      <h3 className="sec-title meta-row">
        Η συζήτηση των Twins <Badge tone={chat.mode === 'live' ? 'ai' : 'neutral'}>{chat.mode === 'live' ? 'ύφος κάθε κατόχου · AI' : 'πρότυπο'}</Badge>
        <InfoTip label="Πώς ελέγχεται η συζήτηση">
          {chat.note && <p className="tip-note">{chat.note}</p>}
          Κάθε μήνυμα ελέγχεται σε κώδικα: αριθμοί και επιλογές πρέπει να υπάρχουν στα δεδομένα της απόφασης, αλλιώς απορρίπτεται. Με το μολύβι διορθώνεις τι είπε το Twin σου — η διόρθωση μετράει ως δική σου επιθυμία για αυτό το σχέδιο.
        </InfoTip>
      </h3>
      <div className="dm dm-static">
        <DmHead people={people} live={false} sub="ομαδική συνομιλία" />
        <div className="dm-body">
          {shown.map((l: ChatLine, i) => {
            const p = people.find((x) => x.id === l.personaId);
            if (!p) return null;
            const head = prev !== p.id;
            prev = p.id;
            return (
              <EditableLine
                key={i}
                p={p}
                text={edits[i] ?? l.text}
                edited={edits[i] !== undefined}
                showHead={head}
                onEdit={onRegenerate ? (t) => setEdits((e) => ({ ...e, [i]: t })) : undefined}
                onUndo={() =>
                  setEdits((e) => {
                    const { [i]: _drop, ...rest } = e;
                    return rest;
                  })
                }
              />
            );
          })}
        </div>
        {shown.length < chat.lines.length && (
          <button className="dm-more" onClick={() => setAll(true)}>
            Δες όλη τη συζήτηση ({chat.lines.length} μηνύματα)
          </button>
        )}
        {n > 0 && onRegenerate && (
          <footer className="dm-foot dm-regen">
            <span className="small">
              <b>Διορθώσεις σε αναμονή:</b> {n === 1 ? '1 μήνυμα' : `${n} μηνύματα`}. Με «Regenerate» γίνονται επιθυμίες σας και τα Twins ξανααποφασίζουν.
            </span>
            <button className="btn btn-brand" onClick={() => onRegenerate(Object.entries(edits).map(([i, text]) => ({ personaId: chat.lines[Number(i)].personaId, text })))}>
              <RefreshCw size={15} /> Regenerate
            </button>
          </footer>
        )}
      </div>
    </section>
  );
}
