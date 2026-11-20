import { Bot, Check, Code2, Heart, RefreshCw, Send, Shuffle, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import type { CandidateOption, Decision, MemoryItem, Persona } from '../../../shared/types';
import { describeDeadline, formatWhen } from '../../../shared/time';
import { STANCE_THRESHOLDS } from '../../../shared/decide';
import { api, type AppState } from '../api';
import { Working } from '../components/Composer';
import { Checks, PlanDetails, PlanHead } from '../components/Plan';
import { LiveTwinChat, TwinChatView } from '../components/TwinChat';
import { KIND_LABEL } from '../../../shared/plan';
import { Avatar, AvatarStack, Badge, CATEGORY, Cite, Empty, ScoreRing, Spinner, timeAgo, type OpenSource } from '../components/ui';

const STANCE = {
  agree: { label: 'Συμφωνεί', tone: 'good' },
  agree_with_concession: { label: 'Με παραχώρηση', tone: 'warn' },
  object: { label: 'Διαφωνεί', tone: 'bad' },
} as const;

function refsOf(memory: MemoryItem[], id: string) {
  return memory.find((m) => m.id === id)?.refs ?? [];
}

function OptionCard({ o, d, people, onOpen, memory }: { o: CandidateOption; d: Decision; people: Persona[]; onOpen: OpenSource; memory: MemoryItem[] }) {
  const r = d.outcome.results.find((x) => x.optionId === o.id)!;
  const chosen = d.outcome.chosenOptionId === o.id;
  const name = (id: string) => people.find((p) => p.id === id)?.name ?? id;
  return (
    <article className={`opt ${chosen ? 'opt-chosen' : ''} ${r.feasible ? '' : 'opt-out'}`}>
      <div className="opt-cover">
        <span className="opt-emoji">{o.emoji}</span>
        {chosen ? <Badge tone="good">Κοινή πρόταση</Badge> : r.feasible ? <Badge tone="neutral">Εφικτό</Badge> : <Badge tone="bad">Αποκλείεται</Badge>}
      </div>
      <div className="opt-body">
        <h4>{o.title}</h4>
        <p className="tiny muted">{o.venue ? [o.venue.address, o.venue.area, o.venue.city].filter(Boolean).join(', ') : o.location}</p>
        <div className="opt-chips">
          <span>{o.costPerPerson !== null ? `≈${o.costPerPerson}€/άτομο` : 'κόστος ;'}</span>
          {o.startsAt && <span>{formatWhen(o.startsAt)}</span>}
          {o.itinerary && <span>{o.itinerary.days.length} μέρες</span>}
          {o.synthetic && <span>συνθετικό</span>}
        </div>
        <p className="small">{o.summary}</p>
        <ul className="feat">
          {o.features.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <div className="opt-scores">
          {people.map((p) => (
            <span key={p.id} className="opt-score" title={`${p.name}: ${r.scores[p.id]}/100`}>
              <Avatar persona={p} size={22} />
              <b>{r.scores[p.id]}</b>
            </span>
          ))}
        </div>
        {r.violations.map((v) => (
          <p key={v.memoryId + o.id} className="violation">
            ⛔ <b>{name(v.personaId)}</b>: {v.text}{' '}
            <Badge tone={v.checkedBy === 'code' ? 'info' : 'ai'} title={v.checkedBy === 'code' ? 'Αριθμητικός έλεγχος σε κώδικα' : 'Κρίση του AI πάνω σε υποχρεωτικό στοιχείο μνήμης'}>
              {v.checkedBy === 'code' ? 'κώδικας' : 'κρίση'}
            </Badge>
            {v.scope === 'request' && <Badge tone="warn">μόνο αυτό</Badge>} <Cite refs={refsOf(memory, v.memoryId)} onOpen={onOpen} />
          </p>
        ))}
        {r.warnings.map((w) => (
          <p key={w} className="tiny warn-text">
            ⚠ {w}
          </p>
        ))}
        <Checks checks={o.checks?.filter((c) => c.field === 'existence' || c.field === 'program')} compact />
        <p className="tiny muted">
          {o.costNote} {o.origin === 'ai' ? '· εκτίμηση AI, όχι κράτηση' : o.synthetic ? '· συνθετικό demo' : '· επιμελημένος κατάλογος'}
        </p>
      </div>
    </article>
  );
}

function Wishes({ req, d, people, state, onState, onOpen }: { req: AppState['requests'][number]; d: Decision; people: Persona[]; state: AppState; onState: (s: AppState) => void; onOpen: OpenSource }) {
  const [who, setWho] = useState(people[0]?.id ?? '');
  const [text, setText] = useState('');
  const [scope, setScope] = useState<'request' | 'profile'>('request');
  const [fresh, setFresh] = useState(false);
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const items = state.memory.filter((m) => m.scope === 'request' && m.requestId === req.id && m.status === 'confirmed');
  const run = async (label: string, fn: () => Promise<{ state: AppState }>) => {
    setBusy(label);
    setErr(null);
    try {
      onState((await fn()).state);
      setText('');
      setLimit('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="card wishes-card">
      <h3>Επιθυμίες μόνο για αυτό το αίτημα</h3>
      <div className="wish-chips">
        {items.map((m) => {
          const p = people.find((x) => x.id === m.personaId);
          return (
            <span key={m.id} className={`wish-chip ${m.hard ? 'hard' : ''}`}>
              {p && <Avatar persona={p} size={20} />}
              {m.statement}
              {m.rule && <b className="tiny"> {m.rule.metric === 'max_cost' ? `≤${m.rule.value}€` : `έως ${describeDeadline(m.rule.value)}`}</b>}
              <Cite refs={m.refs} onOpen={onOpen} />
              <button className="chip-x" aria-label="Αφαίρεση" onClick={() => run('remove', () => api.removeItem(req.id, m.id))}>
                <X size={12} />
              </button>
            </span>
          );
        })}
        {!items.length && <span className="small muted">Καμία ακόμα — μόνο η μόνιμη μνήμη κάθε Twin.</span>}
      </div>
      <div className="wish-form">
        <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Ποιος">
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="π.χ. «θέλω να γνωρίσουμε νέα άτομα», «μέχρι Δευτέρα να έχουμε γυρίσει»" />
        <select value={scope} onChange={(e) => setScope(e.target.value as 'request' | 'profile')} aria-label="Ισχύς">
          <option value="request">Μόνο για αυτό</option>
          <option value="profile">Αποθήκευση στο προφίλ</option>
        </select>
        <label className="tiny muted fresh" title="Μια ποιοτική επιθυμία μπορεί να αλλάξει ΤΙ πρέπει να προταθεί">
          <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} /> και νέες επιλογές
        </label>
        <button className="btn btn-brand" disabled={!!busy || text.trim().length < 3} onClick={() => run('wish', () => api.addWish(req.id, who, text, scope, fresh))}>
          {busy === 'wish' ? <Spinner /> : <Send size={15} />}
        </button>
      </div>
      <div className="wish-form limit">
        <span className="small">Γρήγορο όριο κόστους για {people.find((p) => p.id === who)?.name}:</span>
        <input type="number" min={1} value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="€ / άτομο" />
        <button className="btn" disabled={!!busy || !Number(limit)} onClick={() => run('limit', () => api.setLimit(req.id, who, Number(limit)))} title="Ελέγχεται σε κώδικα — οι αξιολογήσεις των Twins δεν ξαναγίνονται">
          {busy === 'limit' ? <Spinner /> : 'Εφαρμογή'}
        </button>
        <span className="tiny muted">αριθμητικά όρια → άμεσος επανυπολογισμός σε κώδικα</span>
      </div>
      {busy === 'wish' && <Working live={state.status.aiMode === 'live'} steps={['Κατανόηση επιθυμίας', 'Ανάκτηση μνήμης', 'Τα Twins ξανααξιολογούν', 'Κοινή απόφαση']} />}
      {err && <p className="error">{err}</p>}
      {d.diff && d.diff.changes.length > 0 && (
        <div className="diff">
          <b>Τι άλλαξε από την προηγούμενη εκτέλεση:</b>
          <ul>
            {d.diff.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Messages({ d, people, state, onState, onOpen }: { d: Decision; people: Persona[]; state: AppState; onState: (s: AppState) => void; onOpen: OpenSource }) {
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const run = async (fn: () => Promise<AppState>) => {
    setBusy(true);
    try {
      onState(await fn());
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card chat">
      <header className="chat-head">
        <h3>Τα Twins γράφουν στο group</h3>
        {d.messages && state.status.aiMode === 'live' && (
          <button className="btn btn-sm" disabled={busy} onClick={() => run(() => api.messages(d.id, true))}>
            <RefreshCw size={14} /> Ξαναγράψε
          </button>
        )}
      </header>
      {!d.messages ? (
        <div className="chat-empty">
          <p className="small muted">Κάθε Twin γράφει ένα προσχέδιο με το ύφος του κατόχου του — μόνο με γεγονότα της απόφασης. Δεν στέλνεται τίποτα χωρίς έγκριση.</p>
          <button className="btn btn-brand" disabled={busy} onClick={() => run(() => api.messages(d.id))}>
            {busy ? <Spinner label="Γράφουν…" /> : <><Sparkles size={15} /> Γράψε τα μηνύματα</>}
          </button>
        </div>
      ) : (
        <>
          {d.messagesNote && <p className="notice small">{d.messagesNote}</p>}
          <ul className="plain bubbles">
            {d.messages.map((m) => {
              const p = people.find((x) => x.id === m.personaId)!;
              const editing = edit[m.personaId] !== undefined;
              return (
                <li key={m.personaId} className="bubble-row">
                  <Avatar persona={p} size={34} />
                  <div className="bubble-col">
                    <span className="tiny muted">
                      {p.name} · {m.mode === 'live' ? 'AI με το ύφος του' : 'πρότυπο'} · {m.status === 'approved' ? '✓ εγκρίθηκε' : 'προσχέδιο'}
                    </span>
                    {editing ? (
                      <textarea className="input" rows={2} value={edit[m.personaId]} onChange={(e) => setEdit({ ...edit, [m.personaId]: e.target.value })} />
                    ) : (
                      <p className="bubble">
                        {m.text}
                      </p>
                    )}
                    {m.guardNote && <p className="tiny warn-text">⚠ {m.guardNote}</p>}
                    <div className="bubble-actions">
                      {m.status !== 'approved' && (
                        <>
                          <button
                            className="btn btn-sm btn-brand"
                            disabled={busy}
                            onClick={() =>
                              run(async () => {
                                const s = await api.approveMessage(d.id, m.personaId, edit[m.personaId]);
                                setEdit(({ [m.personaId]: _drop, ...rest }) => rest);
                                return s;
                              })
                            }
                          >
                            <Check size={14} /> {editing ? 'Αποθήκευση & έγκριση' : 'Εγκρίνω'}
                          </button>
                          {!editing && (
                            <button className="btn btn-sm" onClick={() => setEdit({ ...edit, [m.personaId]: m.text })}>
                              Αλλαγή
                            </button>
                          )}
                        </>
                      )}
                      <details className="more">
                        <summary>Πού βασίστηκε</summary>
                        <p className="tiny">
                          Ύφος από: <Cite refs={m.styleSourceIds.map((id) => ({ sourceId: id, quote: '' }))} onOpen={onOpen} />
                        </p>
                        <ul className="tiny muted">
                          {m.facts.map((f) => (
                            <li key={f}>{f}</li>
                          ))}
                        </ul>
                      </details>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

export function Thread({ id, state, onState, onOpen }: { id: string; state: AppState; onState: (s: AppState) => void; onOpen: OpenSource }) {
  const req = state.requests.find((r) => r.id === id);
  const decisions = state.decisions.filter((d) => d.requestId === id);
  const d = decisions.at(-1);
  const [busy, setBusy] = useState<string | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!req || !d) return <Empty emoji="🔎" title="Το αίτημα δεν βρέθηκε" />;
  const people = req.participants.map((pid) => state.personas.find((p) => p.id === pid)!).filter(Boolean);
  const name = (pid: string) => people.find((p) => p.id === pid)?.name ?? pid;
  const chosen = d.options.find((o) => o.id === d.outcome.chosenOptionId);
  const live = state.status.aiMode === 'live';

  const relax = async (memoryId: string, optionId: string) => {
    setBusy('relax');
    setErr(null);
    try {
      onState((await api.relax(req.id, memoryId, optionId)).state);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const rerun = async (regenerate: boolean) => {
    setBusy(regenerate ? 'regen' : 'rerun');
    setErr(null);
    try {
      setJob((await api.rerunAsync(req.id, regenerate)).jobId);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  };

  return (
    <div className="thread">
      <header className="thread-head card">
        <span className="thread-cat">
          {CATEGORY[req.category].emoji}
        </span>
        <div>
          <p className="eyebrow">
            {req.kind ? KIND_LABEL[req.kind] : CATEGORY[req.category].label} · {timeAgo(req.createdAt)} · {decisions.length} εκτελέσεις
          </p>
          <h2>{req.title}</h2>
          <p className="small muted">
            «{req.text}» {req.periodStart && `· ${formatWhen(req.periodStart)} → ${formatWhen(req.periodEnd)}`}
          </p>
          {req.days && (
            <p className="tiny muted">
              Πλαίσιο: {req.days} {req.days === 1 ? 'μέρα' : 'μέρες'} · {req.where === 'abroad' ? 'εξωτερικό' : req.where === 'domestic' ? 'Ελλάδα' : 'στην πόλη'}
              {req.city ? ` · ${req.kind === 'trip' ? 'αφετηρία' : 'πόλη'}: ${req.city}${req.cityAssumed ? ' (παραδοχή — αλλάζει στη φόρμα αιτήματος)' : ''}` : ''}
              {req.area ? ` · περιοχή: ${req.area}` : ''}
              {req.place ? ` · ${req.place}` : ''} — τα όρια του προφίλ εφαρμόζονται μόνο όπου ταιριάζει το πλαίσιο.
            </p>
          )}
        </div>
        <AvatarStack personas={people} size={30} />
      </header>

      <Wishes req={req} d={d} people={people} state={state} onState={onState} onOpen={onOpen} />

      <section className="steps">
        {d.steps.map((s) => (
          <span key={s.key + s.label} className={`step step-${s.mode}`} title={s.detail}>
            {s.mode === 'ai' ? <Bot size={14} /> : s.mode === 'code' ? <Code2 size={14} /> : <Shuffle size={14} />}
            <b>{s.label}</b>
            <span className="tiny">{s.detail}</span>
          </span>
        ))}
      </section>

      {busy ? (
        job ? (
          <LiveTwinChat
            jobId={job}
            people={people}
            onDone={(st) => {
              onState(st);
              setBusy(null);
              setJob(null);
            }}
            onError={(m) => {
              setErr(m);
              setBusy(null);
              setJob(null);
            }}
          />
        ) : (
          <div className="card">
            <Spinner label="Ξεκινάει…" />
          </div>
        )
      ) : chosen && d.outcome.status === 'compromise' ? (
        <section className="hero card compromise">
          <div className="hero-cover">
            <span className="hero-emoji">{d.outcome.noCommonTime ? '⏱️' : '⚖️'}</span>
            <div>
              <span className="eyebrow light">Χρειάζεται απόφαση των κατόχων</span>
              <h2>{d.outcome.noCommonTime ? 'Δεν υπάρχει κοινή ώρα' : 'Δεν υπάρχει πρόταση που να χωράει σε όλα τα αυστηρά όρια'}</h2>
              <p className="small muted">Τα Twins δεν δέχονται παραβίαση ορίου για λογαριασμό κανενός. Τι θα άνοιγε επιλογές:</p>
            </div>
          </div>
          <div className="hero-body">
            <ul className="plain relax">
              {d.outcome.relaxations.map((r) => {
                const m = d.inputs.find((x) => x.id === r.memoryId);
                const owner = people.find((p) => p.id === r.personaId);
                return (
                  <li key={r.memoryId + r.optionId}>
                    → {r.text}{' '}
                    {m?.rule && owner && (
                      <button className="btn btn-sm" disabled={!!busy} onClick={() => relax(r.memoryId, r.optionId)} title="Αλλάζει μόνο για αυτό το αίτημα, από τον ίδιο τον κάτοχο">
                        <Avatar persona={owner} size={18} /> Το αλλάζω εγώ, μόνο για αυτό
                      </button>
                    )}
                  </li>
                );
              })}
              {!d.outcome.relaxations.length && <li>Καμία μεμονωμένη αλλαγή δεν αρκεί — αλλάξτε μια επιθυμία ή ζητήστε νέες επιλογές.</li>}
            </ul>
            <div className="hypo">
              <p className="eyebrow">Πιο κοντινή εναλλακτική — υποθετική, όχι εφικτή χωρίς αλλαγή</p>
              <h3>
                {chosen.emoji} {chosen.title}
              </h3>
              <PlanHead o={chosen} />
              {d.outcome.results
                .find((r) => r.optionId === chosen.id)
                ?.violations.map((v) => (
                  <p key={v.memoryId} className="violation">
                    ⛔ <b>{name(v.personaId)}</b>: {v.text}
                  </p>
                ))}
            </div>
            <ul className="plain rationale small">
              {d.outcome.rationale.slice(-1).map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        </section>
      ) : chosen ? (
        <section className="hero card">
          <div className="hero-cover">
            <span className="hero-emoji">{chosen.emoji}</span>
            <div>
              <span className="eyebrow light">Η κοινή πρόταση των Twins</span>
              <h2>{chosen.venue?.name ?? chosen.title}</h2>
              <PlanHead o={chosen} />
            </div>
          </div>
          <div className="hero-body">
            <PlanDetails o={chosen} people={people} memory={d.inputs} onOpen={onOpen} />
            <ul className="plain rationale">
              {d.outcome.rationale.slice(-2).map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <div className="concessions">
              {d.outcome.concessions.map((c) => {
                const p = people.find((x) => x.id === c.personaId)!;
                return (
                  <div key={c.personaId} className="concession">
                    <Avatar persona={p} size={34} />
                    <div>
                      <div className="conc-head">
                        <b>{p.name}</b> <Badge tone={STANCE[c.stance].tone}>{STANCE[c.stance].label}</Badge>
                      </div>
                      {c.items.length ? (
                        <ul className="plain tiny">
                          {c.items.map((i) => (
                            <li key={i}>↘ {i}</li>
                          ))}
                        </ul>
                      ) : (
                        <span className="tiny muted">Παίρνει τη δική του ψήφο.</span>
                      )}
                    </div>
                    <ScoreRing value={c.finalScore} size={42} />
                  </div>
                );
              })}
            </div>
            <div className="approvals">
              {people.map((p) => {
                const a = d.approvals[p.id];
                return (
                  <button
                    key={p.id}
                    className={`approve ${a}`}
                    disabled={a !== 'pending'}
                    onClick={async () => onState(await api.approve(d.id, p.id, true))}
                    title={a === 'pending' ? `${p.name}: έγκριση` : a === 'approved' ? 'Ενέκρινε' : 'Απέρριψε'}
                  >
                    <Heart size={18} fill={a === 'approved' ? 'currentColor' : 'none'} />
                    <Avatar persona={p} size={22} />
                    {a === 'pending' ? 'Εγκρίνω' : a === 'approved' ? 'Ενέκρινε' : 'Απέρριψε'}
                  </button>
                );
              })}
              {d.approvals[people[0]?.id] === 'pending' && (
                <button className="link-btn tiny" onClick={async () => onState(await api.approve(d.id, people[0].id, false))}>
                  απόρριψη
                </button>
              )}
            </div>
            {d.status === 'approved' && <p className="ok-box">✓ Εγκρίθηκε από όλους. Η κράτηση γίνεται από ανθρώπους — τα Twins δεν κλείνουν τίποτα.</p>}
            {d.status === 'rejected' && <p className="notice">Απορρίφθηκε. Προσθέστε μια επιθυμία ή ζητήστε νέες επιλογές.</p>}
            <p className="tiny muted">
              Όρια στάσης: ≥{STANCE_THRESHOLDS.agree} συμφωνεί · {STANCE_THRESHOLDS.concede}–{STANCE_THRESHOLDS.agree - 1} με παραχώρηση · &lt;{STANCE_THRESHOLDS.concede} διαφωνεί.
            </p>
          </div>
        </section>
      ) : (
        <section className="hero card deadlock">
          <div className="hero-cover">
            <span className="hero-emoji">🤔</span>
            <div>
              <span className="eyebrow light">Χωρίς επιλογές</span>
              <h2>Δεν βρέθηκαν υποψήφιες επιλογές — ζητήστε νέες</h2>
            </div>
          </div>
          <div className="hero-body">
            <p className="small">Δοκιμάστε «Νέες επιλογές». Τι θα βοηθούσε:</p>
            <ul className="plain relax">
              {d.outcome.relaxations.map((r) => (
                <li key={r.memoryId + r.optionId}>→ {r.text}</li>
              ))}
              {!d.outcome.relaxations.length && <li>Καμία μεμονωμένη αλλαγή δεν αρκεί — αφαιρέστε μια επιθυμία ή ζητήστε νέες επιλογές.</li>}
            </ul>
          </div>
        </section>
      )}

      {!busy && <TwinChatView chat={d.chat} people={people} />}

      <div className="thread-actions">
        <button className="btn" disabled={!!busy} onClick={() => rerun(false)}>
          <RefreshCw size={15} /> Ξανατρέξε
        </button>
        <button className="btn btn-brand" disabled={!!busy} onClick={() => rerun(true)}>
          <Sparkles size={15} /> Νέες επιλογές {live ? '(AI)' : '(demo)'}
        </button>
        {err && <span className="error">{err}</span>}
      </div>

      <section>
        <h3 className="sec-title">Τι ψηφίζει κάθε Twin</h3>
        <div className="votes">
          {d.outcome.votes.map((v) => {
            const p = people.find((x) => x.id === v.personaId)!;
            const o = d.options.find((x) => x.id === v.optionId);
            return (
              <article key={v.personaId} className="vote card">
                <header className="vote-head">
                  <Avatar persona={p} size={40} ring />
                  <div>
                    <b>{p.name}</b>
                    <div className="tiny muted">το Twin ψηφίζει</div>
                    <div className="vote-option">
                      {o ? (
                        <>
                          {o.emoji} {o.title}
                        </>
                      ) : (
                        'καμία επιλογή'
                      )}
                    </div>
                  </div>
                  <ScoreRing value={v.score} />
                </header>
                {v.verdict && <p className="verdict">“{v.verdict}”</p>}
                <ul className="plain reasons">
                  {v.reasons.map((r, i) => (
                    <li key={i} className={r.effect}>
                      {r.effect === 'for' ? '＋' : '－'} {r.text} <Cite refs={refsOf(d.inputs, r.memoryId)} onOpen={onOpen} />
                    </li>
                  ))}
                </ul>
                {v.unknowns.length > 0 && (
                  <details className="more">
                    <summary>Αβεβαιότητες ({v.unknowns.length})</summary>
                    <ul className="tiny muted">
                      {v.unknowns.map((u) => (
                        <li key={u}>? {u}</li>
                      ))}
                    </ul>
                  </details>
                )}
                <span className="tiny muted">Βεβαιότητα ψήφου: {{ low: 'χαμηλή', medium: 'μέτρια', high: 'υψηλή' }[v.confidence]}</span>
              </article>
            );
          })}
        </div>
      </section>

      <section>
        <h3 className="sec-title">Υποψήφιες επιλογές ({d.options.length})</h3>
        {!!d.rejectedOptions?.length && (
          <details className="more">
            <summary>Απορρίφθηκαν πριν την ψηφοφορία ({d.rejectedOptions.length}) — έλεγχος σε κώδικα</summary>
            <ul className="small">
              {d.rejectedOptions.map((r, i) => (
                <li key={r.title + i}>
                  «{r.title}»: {r.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="carousel">
          {d.options.map((o) => (
            <OptionCard key={o.id} o={o} d={d} people={people} onOpen={onOpen} memory={d.inputs} />
          ))}
        </div>
        {d.outcome.rationale.length > 2 && (
          <details className="more">
            <summary>Όλη η αιτιολόγηση του κώδικα</summary>
            <ul className="small">
              {d.outcome.rationale.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <Messages d={d} people={people} state={state} onState={onState} onOpen={onOpen} />

      <p className="tiny muted center">
        {d.id} · {d.aiModel ? `AI: ${d.aiModel}` : 'demo mode'} · {d.inputs.length} αναμνήσεις χρησιμοποιήθηκαν ·{' '}
        {name(people[0]?.id ?? '')} {people.length > 1 ? `+${people.length - 1}` : ''}
      </p>
    </div>
  );
}
