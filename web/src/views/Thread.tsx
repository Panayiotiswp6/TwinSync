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
import { Avatar, AvatarStack, Badge, CATEGORY, Cite, Empty, InfoTip, ScoreRing, Spinner, timeAgo, type OpenSource } from '../components/ui';

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
        <div className="opt-foot">
          {r.violations.length ? (
            <span className="violation">⛔ Δεν καλύπτει: {[...new Set(r.violations.map((v) => name(v.personaId).split(' ')[0]))].join(', ')}</span>
          ) : r.warnings.length ? (
            <span className="tiny warn-text">⚠ {r.warnings.length === 1 ? '1 επισήμανση' : `${r.warnings.length} επισημάνσεις`}</span>
          ) : (
            <span className="tiny muted">{o.synthetic ? 'συνθετικό demo' : o.venue?.catalogId ? 'από τον κατάλογο' : ''}</span>
          )}
          <InfoTip label={`Λεπτομέρειες: ${o.title}`} tone={r.violations.length ? 'bad' : r.warnings.length ? 'warn' : undefined} wide>
            {r.violations.map((v) => (
              <p key={v.memoryId + o.id} className="tip-note">
                ⛔ <b>{name(v.personaId)}</b>: {v.text}{' '}
                <Badge tone={v.checkedBy === 'code' ? 'info' : 'ai'} title={v.checkedBy === 'code' ? 'Αριθμητικός έλεγχος σε κώδικα' : 'Κρίση του AI πάνω σε υποχρεωτικό στοιχείο μνήμης'}>
                  {v.checkedBy === 'code' ? 'κώδικας' : 'κρίση'}
                </Badge>
                {v.scope === 'request' && <Badge tone="warn">μόνο αυτό</Badge>} <Cite refs={refsOf(memory, v.memoryId)} onOpen={onOpen} />
              </p>
            ))}
            {r.warnings.map((w) => (
              <p key={w} className="tip-note warn-text">
                ⚠ {w}
              </p>
            ))}
            <Checks checks={o.checks?.filter((c) => c.field === 'existence' || c.field === 'program')} compact />
            {o.costNote && <p className="tip-note muted">{o.costNote}</p>}
          </InfoTip>
        </div>
      </div>
    </article>
  );
}

/** "Θα έκανε το Clumsies;": for each twin, does the named place fit — and if not, why. */
function PickVerdict({ d, o, people }: { d: Decision; o: CandidateOption; people: Persona[] }) {
  const r = d.outcome.results.find((x) => x.optionId === o.id);
  const rows = people.map((p) => {
    const ev = d.evaluations.find((e) => e.personaId === p.id && e.optionId === o.id);
    const viol = r?.violations.filter((v) => v.personaId === p.id) ?? [];
    const stance = d.outcome.concessions.find((c) => c.personaId === p.id)?.stance ?? 'agree';
    const fits = !viol.length && stance !== 'object';
    const against = ev?.reasons.find((x) => x.effect !== 'for')?.text;
    const pro = ev?.reasons.find((x) => x.effect === 'for')?.text;
    const why = viol[0]?.text ?? (stance === 'agree' ? (ev?.verdict || pro) : against ?? ev?.verdict) ?? '';
    return { p, fits, mild: fits && stance === 'agree_with_concession', why, score: ev?.score ?? r?.scores[p.id] ?? 0 };
  });
  const clash = rows.filter((x) => !x.fits);
  return (
    <div className={`pick-verdict ${clash.length ? 'clash' : 'fit'}`}>
      <p className="pick-head">
        {clash.length ? (
          <>
            <X size={16} /> Δεν ταιριάζει σε όλους — αντικρούεται με: <b>{clash.map((x) => x.p.name.split(' ')[0]).join(', ')}</b>
          </>
        ) : (
          <>
            <Check size={16} /> Ταιριάζει σε όλη την παρέα
          </>
        )}
      </p>
      <ul className="plain">
        {rows.map((x) => (
          <li key={x.p.id} className="pick-row">
            <Avatar persona={x.p} size={30} />
            <div>
              <b>{x.p.name}</b> <Badge tone={x.fits ? (x.mild ? 'warn' : 'good') : 'bad'}>{x.fits ? (x.mild ? 'Με παραχώρηση' : 'Ταιριάζει') : 'Δεν ταιριάζει'}</Badge>
              {x.why && <p className="small muted">{x.why}</p>}
            </div>
            <ScoreRing value={x.score} size={38} />
          </li>
        ))}
      </ul>
    </div>
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
              {m.rule && <b className="tiny"> {m.rule.metric === 'avoid_place' ? `όχι ξανά: ${m.rule.value.split('|').join(', ')}` : m.rule.metric === 'max_cost' ? `≤${m.rule.value}€` : `έως ${describeDeadline(m.rule.value)}`}</b>}
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
        <InfoTip label="Πώς λειτουργεί το όριο">Τα αριθμητικά όρια ελέγχονται σε κώδικα: η απόφαση ξαναϋπολογίζεται αμέσως, χωρίς νέες αξιολογήσεις από τα Twins.</InfoTip>
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

  const regenerateFromChat = async (edits: { personaId: string; text: string }[]) => {
    setBusy('chat');
    setErr(null);
    try {
      setJob((await api.chatEdits(req.id, edits)).jobId);
    } catch (e) {
      setErr((e as Error).message);
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
            <p className="tiny muted meta-row">
              <span>
                {req.days} {req.days === 1 ? 'μέρα' : 'μέρες'} · {req.where === 'abroad' ? 'εξωτερικό' : req.where === 'domestic' ? 'Ελλάδα' : 'στην πόλη'}
                {req.city ? ` · ${req.kind === 'trip' ? 'από' : ''} ${req.city}` : ''}
                {req.area ? ` · ${req.area}` : ''}
                {req.place ? ` · ${req.place}` : ''}
              </span>
              <InfoTip size={13} label="Πλαίσιο αιτήματος">
                Τα όρια του προφίλ εφαρμόζονται μόνο όπου ταιριάζει το πλαίσιο (μέρες, Ελλάδα ή εξωτερικό, έξοδος στην πόλη).
                {req.cityAssumed ? ' Η πόλη είναι παραδοχή — αλλάζει στη φόρμα αιτήματος.' : ''}
              </InfoTip>
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
          </span>
        ))}
        <InfoTip title="Πώς πάρθηκε η απόφαση" label="Βήματα απόφασης" wide>
          <ul className="plain tip-list">
            {d.steps.map((s) => (
              <li key={s.key + s.label}>
                <b>{s.label}</b> <Badge tone={s.mode === 'ai' ? 'ai' : s.mode === 'code' ? 'info' : 'neutral'}>{s.mode === 'ai' ? 'AI' : s.mode === 'code' ? 'κώδικας' : s.mode}</Badge>
                <div className="muted small">{s.detail}</div>
              </li>
            ))}
          </ul>
        </InfoTip>
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
      ) : chosen ? (
        <section className={`hero card ${d.outcome.status === 'compromise' ? 'compromise' : ''}`}>
          <div className="hero-cover">
            <span className="hero-emoji">{chosen.emoji}</span>
            <div>
              <span className="eyebrow light meta-row">
                {req.pick ? 'Η επιλογή σας — τι λένε τα Twins' : d.outcome.status === 'compromise' ? (d.outcome.noCommonTime ? 'Δεν υπάρχει κοινή ώρα — η πιο κοντινή πρόταση' : 'Η πιο κοντινή πρόταση για όλους') : 'Η κοινή πρόταση των Twins'}
                <InfoTip size={13} title="Πώς κατέληξαν" label="Πώς κατέληξαν" wide>
                  <ul className="plain tip-list">
                    {d.outcome.rationale.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                  <p className="tip-note muted">
                    Όρια στάσης: ≥{STANCE_THRESHOLDS.agree} συμφωνεί · {STANCE_THRESHOLDS.concede}–{STANCE_THRESHOLDS.agree - 1} με παραχώρηση · &lt;{STANCE_THRESHOLDS.concede} διαφωνεί.
                  </p>
                </InfoTip>
              </span>
              <h2>{chosen.venue?.name ?? chosen.title}</h2>
              <PlanHead o={chosen} booking />
            </div>
          </div>
          <div className="hero-body">
            {d.outcome.status === 'compromise' && !req.pick && (
              <div className="not-covered">
                <p className="small meta-row">
                  <b>Δεν καλύπτει πλήρως όλους.</b>
                  <InfoTip size={14} label="Τι σημαίνει" tone="warn">
                    Όποιος δεν καλύπτεται το αποφασίζει ο ίδιος με την έγκρισή του — τα Twins δεν το δέχονται για λογαριασμό του.
                  </InfoTip>
                </p>
                <ul className="plain">
                  {d.outcome.results
                    .find((r) => r.optionId === chosen.id)
                    ?.violations.map((v) => (
                      <li key={v.memoryId} className="violation">
                        ⚠ <b>{name(v.personaId)}</b>: {v.text}
                      </li>
                    ))}
                </ul>
                {d.outcome.relaxations.length > 0 && (
                  <details className="more">
                    <summary>Τι άλλο θα άνοιγε επιλογές</summary>
                    <ul className="plain relax small">
                      {d.outcome.relaxations.map((r) => {
                        const m = d.inputs.find((x) => x.id === r.memoryId);
                        const owner = people.find((p) => p.id === r.personaId);
                        return (
                          <li key={r.memoryId + r.optionId}>
                            → {r.text}{' '}
                            {m?.rule && m.rule.metric !== 'avoid_place' && owner && (
                              <button className="btn btn-sm" disabled={!!busy} onClick={() => relax(r.memoryId, r.optionId)} title="Αλλάζει μόνο για αυτό το αίτημα, από τον ίδιο τον κάτοχο">
                                <Avatar persona={owner} size={18} /> Το αλλάζω εγώ, μόνο για αυτό
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                )}
              </div>
            )}
            {req.pick && <PickVerdict d={d} o={chosen} people={people} />}
            <PlanDetails o={chosen} people={people} memory={d.inputs} onOpen={onOpen} edit={{ decisionId: d.id, onState }} />
            {!req.pick && (
            <div className="concessions">
              {d.outcome.concessions.map((c) => {
                const p = people.find((x) => x.id === c.personaId)!;
                return (
                  <div key={c.personaId} className="concession">
                    <Avatar persona={p} size={34} />
                    <div>
                      <b className="conc-name">{p.name}</b>
                      <div className="conc-head">
                        <Badge tone={STANCE[c.stance].tone}>{STANCE[c.stance].label}</Badge>
                        {c.items.length ? (
                          <InfoTip size={14} label={`Τι δίνει ο/η ${p.name}`} title="Τι δίνει">
                            <ul className="plain tip-list">
                              {c.items.map((i) => (
                                <li key={i}>↘ {i}</li>
                              ))}
                            </ul>
                          </InfoTip>
                        ) : null}
                      </div>
                    </div>
                    <ScoreRing value={c.finalScore} size={42} />
                  </div>
                );
              })}
            </div>
            )}
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

      {!busy && <TwinChatView chat={d.chat} people={people} onRegenerate={regenerateFromChat} />}

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
        <h3 className="sec-title meta-row">
          Υποψήφιες επιλογές ({d.options.length})
          {(!!d.rejectedOptions?.length || d.outcome.rationale.length > 0) && (
            <InfoTip title="Πώς επιλέχθηκαν" label="Πώς επιλέχθηκαν" wide>
              {!!d.rejectedOptions?.length && (
                <>
                  <p className="infotip-title">Απορρίφθηκαν πριν την ψηφοφορία ({d.rejectedOptions.length}) — έλεγχος σε κώδικα</p>
                  <ul className="plain tip-list">
                    {d.rejectedOptions.map((r, i) => (
                      <li key={r.title + i}>
                        «{r.title}»: <span className="muted">{r.reason}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <p className="infotip-title">Η αιτιολόγηση του κώδικα</p>
              <ul className="plain tip-list">
                {d.outcome.rationale.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </InfoTip>
          )}
        </h3>
        <div className="carousel">
          {d.options.map((o) => (
            <OptionCard key={o.id} o={o} d={d} people={people} onOpen={onOpen} memory={d.inputs} />
          ))}
        </div>
      </section>

      <p className="tiny muted center">
        {d.id} · {d.aiModel ? `AI: ${d.aiModel}` : 'demo mode'} · {d.inputs.length} αναμνήσεις χρησιμοποιήθηκαν ·{' '}
        {name(people[0]?.id ?? '')} {people.length > 1 ? `+${people.length - 1}` : ''}
      </p>
    </div>
  );
}
