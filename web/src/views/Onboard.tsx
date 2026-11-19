import { ArrowLeft, ArrowRight, Check, Lock, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { answerText, DM_SENDERS, NONE, SECTIONS, type Answer, type Answers, type MoneyAnswer, type OnboardBody, type Question } from '../../../shared/onboarding';
import type { JobEvent, Persona } from '../../../shared/types';
import { api, type AppState } from '../api';
import { go } from '../components/Shell';
import { Avatar } from '../components/ui';

const EMOJIS = ['✨', '🎧', '📚', '🏄', '🎨', '⚽', '🍕', '🌿', '🚴', '🎮', '🏔️', '🌊'];
const DRAFT_KEY = 'twinsync.onboard.draft';

type Holdout = OnboardBody['holdouts'][number];
interface Draft {
  step: number;
  name: string;
  emoji: string;
  answers: Answers;
  holdouts: Holdout[];
}
const EMPTY: Draft = { step: 0, name: '', emoji: '✨', answers: {}, holdouts: [] };

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} aria-pressed={on}>
      <span className="toggle-knob" />
      {on ? <Lock size={13} /> : null} {label}
    </button>
  );
}

function QuestionField({ q, value, onChange, index }: { q: Question; value: Answer | undefined; onChange: (a: Answer | undefined) => void; index: number }) {
  if (q.type === 'dm') {
    const sender = DM_SENDERS[index % DM_SENDERS.length];
    return (
      <div className="ob-dm">
        <div className="ob-dm-in">
          <span className="ob-dm-name">{sender}</span>
          <div className="dm-bubble">{q.q}</div>
        </div>
        <input className="ob-dm-reply" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} placeholder="Γράψε όπως θα απαντούσες…" aria-label={`Απάντηση στο: ${q.q}`} />
      </div>
    );
  }
  return (
    <div className="ob-q">
      <label className="ob-label">
        {q.q} {q.optional && <span className="tiny muted">(προαιρετικό)</span>}
      </label>
      {q.help && <p className="tiny muted">{q.help}</p>}
      {q.type === 'text' && <textarea rows={2} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={q.placeholder} />}
      {q.type === 'money' && <MoneyField value={value as MoneyAnswer | undefined} onChange={onChange} />}
      {(q.type === 'chips' || q.type === 'multi') && (
        <div className="ob-chips">
          {q.options!.map((o) => {
            const list = Array.isArray(value) ? value : [];
            const on = q.type === 'chips' ? value === o : list.includes(o);
            const pick = () => {
              if (q.type === 'chips') return onChange(on ? undefined : o);
              if (o === NONE) return onChange(on ? [] : [NONE]);
              const next = on ? list.filter((x) => x !== o) : [...list.filter((x) => x !== NONE), o];
              onChange(next);
            };
            return (
              <button key={o} type="button" className={`chip ${on ? 'on' : ''}`} onClick={pick} aria-pressed={on}>
                {on && <Check size={13} />} {o}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MoneyField({ value, onChange }: { value: MoneyAnswer | undefined; onChange: (a: MoneyAnswer) => void }) {
  const v = value ?? { amount: null, strict: false };
  return (
    <div className="ob-money">
      <span className="ob-euro">
        <input type="number" min={0} inputMode="numeric" value={v.amount ?? ''} onChange={(e) => onChange({ ...v, amount: e.target.value === '' ? null : Number(e.target.value) })} placeholder="—" />€
      </span>
      <Toggle on={v.strict} onChange={(strict) => onChange({ ...v, strict })} label={v.strict ? 'Αυστηρό όριο' : 'Ενδεικτικό'} />
    </div>
  );
}

function HoldoutEditor({ items, onChange }: { items: Holdout[]; onChange: (h: Holdout[]) => void }) {
  const set = (i: number, h: Holdout) => onChange(items.map((x, k) => (k === i ? h : x)));
  return (
    <div className="ob-holdouts">
      {items.map((h, i) => (
        <div key={i} className="ob-holdout card">
          <div className="ob-holdout-head">
            <input value={h.question} onChange={(e) => set(i, { ...h, question: e.target.value })} placeholder="Η ερώτηση, π.χ. «Πού πήγαμε για τα γενέθλια του Νίκου;»" />
            <button className="icon-btn" onClick={() => onChange(items.filter((_, k) => k !== i))} aria-label="Αφαίρεση">
              <Trash2 size={16} />
            </button>
          </div>
          {h.options.map((o, k) => (
            <div key={k} className="ob-holdout-opt">
              <input type="radio" name={`h${i}`} checked={h.chosen === k} onChange={() => set(i, { ...h, chosen: k })} aria-label="Αυτό διάλεξα" />
              <input value={o.title} onChange={(e) => set(i, { ...h, options: h.options.map((x, j) => (j === k ? { ...x, title: e.target.value } : x)) })} placeholder={`Επιλογή ${k + 1} (π.χ. «Live bar, Ψυρρή»)`} />
              <input type="number" min={0} value={o.cost ?? ''} onChange={(e) => set(i, { ...h, options: h.options.map((x, j) => (j === k ? { ...x, cost: e.target.value === '' ? null : Number(e.target.value) } : x)) })} placeholder="€" className="ob-cost" />
            </div>
          ))}
          {h.options.length < 4 && (
            <button className="link-btn tiny" onClick={() => set(i, { ...h, options: [...h.options, { title: '', cost: null }] })}>
              + επιλογή
            </button>
          )}
          <input value={h.why} onChange={(e) => set(i, { ...h, why: e.target.value })} placeholder="Γιατί το διάλεξες; (δεν το βλέπει το Twin)" />
        </div>
      ))}
      {items.length < 3 && (
        <button className="btn" onClick={() => onChange([...items, { question: '', options: [{ title: '', cost: null }, { title: '', cost: null }], chosen: 0, why: '' }])}>
          <Plus size={15} /> Πρόσθεσε μια πραγματική επιλογή σου
        </button>
      )}
    </div>
  );
}

function BuildProgress({ jobId, onDone }: { jobId: string; onDone: (state: AppState, personaId: string) => void }) {
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ state: AppState; personaId: string } | null>(null);
  useEffect(() => {
    let alive = true;
    let since = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const j = await api.job(jobId, since);
        if (!alive) return;
        since = j.total;
        if (j.events.length) setEvents((e) => [...e, ...j.events]);
        if (j.status === 'done' && j.state) return setResult({ state: j.state, personaId: j.result?.personaId ?? '' });
        if (j.status === 'error') return setError(j.error ?? 'Σφάλμα');
      } catch (e) {
        if (alive) setError((e as Error).message);
        return;
      }
      timer = setTimeout(tick, 900);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [jobId]);
  const persona: Persona | undefined = result?.state.personas.find((p) => p.id === result.personaId);
  return (
    <div className="dm">
      <header className="dm-head">
        {persona ? <Avatar persona={persona} size={30} /> : <span className="spinner" />}
        <div>
          <b>{persona ? persona.name : 'Δημιουργία Twin'}</b>
          <div className="tiny muted">{result ? 'έτοιμο' : 'μαθαίνει από τις απαντήσεις σου…'}</div>
        </div>
      </header>
      <div className="dm-body">
        {events.map((e, i) => (
          <div key={i} className="dm-row head">
            <span className="dm-ava">✨</span>
            <div className="dm-col">
              <div className={`dm-bubble ${e.kind}`}>{e.text}</div>
            </div>
          </div>
        ))}
        {!result && !error && (
          <div className="dm-row head">
            <span className="dm-ava">✨</span>
            <div className="dm-col">
              <div className="dm-bubble typing">
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </div>
      {result && (
        <footer className="dm-foot">
          <button className="btn" onClick={() => onDone(result.state, '')}>
            <Plus size={15} /> Επόμενο άτομο
          </button>
          <button className="btn btn-brand" onClick={() => onDone(result.state, result.personaId)}>
            Δες το Twin <ArrowRight size={16} />
          </button>
        </footer>
      )}
    </div>
  );
}

/** The in-app interview that builds a twin. */
export function Onboard({ state, onState }: { state: AppState; onState: (s: AppState) => void }) {
  const [d, setD] = useState<Draft>(loadDraft);
  const [jobId, setJobId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    } catch {
      /* private mode: the draft simply is not kept */
    }
  }, [d]);

  const steps = [...SECTIONS.map((s) => ({ id: s.id, title: s.title, emoji: s.emoji })), { id: 'test', title: 'Τεστ', emoji: '🎯' }, { id: 'done', title: 'Τέλος', emoji: '🚀' }];
  const step = Math.min(d.step, steps.length - 1);
  const section = SECTIONS[step];
  const all = SECTIONS.flatMap((s) => s.questions);
  const answered = useMemo(() => all.filter((q) => answerText(q, d.answers[q.id])).length, [all, d.answers]);
  const missing = all.filter((q) => !q.optional && !answerText(q, d.answers[q.id]));
  const setAnswer = (id: string, a: Answer | undefined) => setD((x) => ({ ...x, answers: { ...x.answers, [id]: a as Answer } }));
  const to = (i: number) => {
    setD((x) => ({ ...x, step: i }));
    window.scrollTo({ top: 0 });
  };

  const submit = async () => {
    setErr(null);
    try {
      const answers = Object.fromEntries(Object.entries(d.answers).filter(([, v]) => v !== undefined && v !== null));
      const r = await api.onboard({ name: d.name, emoji: d.emoji, answers, holdouts: d.holdouts.filter((h) => h.question.trim()) });
      setJobId(r.jobId);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (jobId) {
    return (
      <div className="narrow">
        <BuildProgress
          jobId={jobId}
          onDone={(s, personaId) => {
            onState(s);
            try {
              localStorage.removeItem(DRAFT_KEY);
            } catch {
              /* ignore */
            }
            if (personaId) go(`/twin/${personaId}`);
            else {
              setJobId(null);
              setD(EMPTY);
              window.scrollTo({ top: 0 });
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className="narrow onboard">
      <button className="link-btn small" onClick={() => go('/twins')}>
        <ArrowLeft size={14} /> Twins
      </button>
      <h2>Φτιάξε το Twin σου</h2>
      <p className="muted small">
        Περίπου 5 λεπτά. Οι ερωτήσεις είναι διαλεγμένες για ό,τι χρειάζεται το Twin για να αποφασίζει και να γράφει σαν εσένα. Ό,τι πεις κρατιέται αυτούσιο ως πηγή, με το πλαίσιό του — π.χ. ένα ποσό για «διήμερο στην Ελλάδα» δεν γίνεται κανόνας για «4 μέρες στο εξωτερικό».
      </p>
      <ol className="ob-steps">
        {steps.map((s, i) => (
          <li key={s.id}>
            <button className={i === step ? 'now' : i < step ? 'done' : ''} onClick={() => to(i)} title={s.title}>
              <span>{s.emoji}</span>
              <small>{s.title}</small>
            </button>
          </li>
        ))}
      </ol>
      <div className="ob-progress">
        <span style={{ width: `${(answered / all.length) * 100}%` }} />
      </div>

      <section className="card ob-card">
        {section && (
          <>
            <h3>
              {section.emoji} {section.title}
            </h3>
            <p className="muted small">{section.intro}</p>
            {section.id === 'me' && (
              <div className="ob-q">
                <label className="ob-label">Το όνομά σου</label>
                <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="π.χ. Γρηγόρης" autoFocus />
                <div className="emoji-pick">
                  {EMOJIS.map((e) => (
                    <button key={e} className={e === d.emoji ? 'on' : ''} onClick={() => setD({ ...d, emoji: e })}>
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {section.id === 'voice' && <div className="dm-sys">Η παρέα σου γράφει στο group…</div>}
            {section.questions.map((q, i) => (
              <QuestionField key={q.id} q={q} index={i} value={d.answers[q.id]} onChange={(a) => setAnswer(q.id, a)} />
            ))}
          </>
        )}

        {steps[step].id === 'test' && (
          <>
            <h3>🎯 Κρυφό τεστ (προαιρετικό)</h3>
            <p className="muted small">
              Γράψε 1–3 πραγματικές επιλογές που έκανες πρόσφατα. Το Twin δεν τις βλέπει ποτέ — στη σελίδα «Αξιολόγηση» ελέγχουμε αν μαντεύει σωστά τι διάλεξες. Έτσι μετράμε πόσο σου μοιάζει.
            </p>
            <HoldoutEditor items={d.holdouts} onChange={(holdouts) => setD({ ...d, holdouts })} />
          </>
        )}

        {steps[step].id === 'done' && (
          <>
            <h3>🚀 Έτοιμο για δημιουργία</h3>
            <p>
              <b>{answered}</b> από {all.length} απαντήσεις{d.holdouts.length ? ` · ${d.holdouts.length} κρυφά τεστ` : ''}.
            </p>
            {missing.length > 0 && (
              <div className="notice small">
                Λείπουν {missing.length} βασικές ερωτήσεις — το Twin θα είναι πιο αβέβαιο εκεί:
                <ul>
                  {missing.slice(0, 6).map((q) => (
                    <li key={q.id}>
                      <button className="link-btn tiny" onClick={() => to(SECTIONS.findIndex((s) => s.questions.includes(q)))}>
                        {q.q}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="tiny muted">
              Οι απαντήσεις σου αποθηκεύονται μόνο σε αυτόν τον server (Docker volume). Με live AI στέλνονται στον πάροχο AI για ανάλυση. Μπορείς να διορθώσεις ή να διαγράψεις οτιδήποτε από το προφίλ.
            </p>
            {state.personas.some((p) => p.name.trim() === d.name.trim()) && <p className="notice small">Υπάρχει ήδη Twin με αυτό το όνομα — θα δημιουργηθεί δεύτερο.</p>}
            <button className="btn btn-brand big" disabled={d.name.trim().length < 2} onClick={submit}>
              <Sparkles size={17} /> Δημιούργησε το Twin {d.name.trim() ? `του/της ${d.name.trim().split(' ')[0]}` : ''}
            </button>
            {d.name.trim().length < 2 && <p className="tiny muted">Συμπλήρωσε το όνομά σου στο πρώτο βήμα.</p>}
            {err && <p className="error">{err}</p>}
          </>
        )}
      </section>

      <div className="ob-nav">
        <button className="btn" disabled={step === 0} onClick={() => to(step - 1)}>
          <ArrowLeft size={15} /> Πίσω
        </button>
        <span className="tiny muted">
          {answered}/{all.length} απαντήσεις · αποθηκεύεται αυτόματα
        </span>
        {step < steps.length - 1 && (
          <button className="btn btn-brand" onClick={() => to(step + 1)}>
            Επόμενο <ArrowRight size={15} />
          </button>
        )}
      </div>
    </div>
  );
}
