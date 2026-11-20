import { AlertTriangle, BookOpen, CalendarClock, Check, ChevronDown, Clock, MapPin, Pencil, RefreshCw, Send, Sparkles, Wallet, X } from 'lucide-react';
import { useState } from 'react';
import type { CandidateOption, Decision, MemoryItem, Persona } from '../../../shared/types';
import { describeDeadline, formatWhen, localParts, parseIso } from '../../../shared/time';
import { STANCE_THRESHOLDS } from '../../../shared/decide';
import { api, type AppState } from '../api';
import { Working } from '../components/Composer';
import { Booking, Checks, PlanDetails } from '../components/Plan';
import { LiveTwinChat, TwinChatView } from '../components/TwinChat';
import { KIND_LABEL } from '../../../shared/plan';
import { Avatar, AvatarStack, CATEGORY, Cite, Empty, InfoTip, Spinner, shortName, timeAgo, type OpenSource } from '../components/ui';

type Req = AppState['requests'][number];

const STANCE = {
  agree: { label: 'Συμφωνεί', tone: 'good' },
  agree_with_concession: { label: 'Με παραχώρηση', tone: 'warn' },
  object: { label: 'Διαφωνεί', tone: 'bad' },
} as const;

const refsOf = (memory: MemoryItem[], id: string) => memory.find((m) => m.id === id)?.refs ?? [];
const ymd = (iso: string | null) => {
  const d = parseIso(iso);
  if (!d) return '';
  const p = localParts(d);
  return `${p.y}-${p.m}-${p.d}`;
};
const hhmm = (iso: string | null) => {
  const d = parseIso(iso);
  if (!d) return '';
  const p = localParts(d);
  return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
};

/** Compact request header: title on its own, the essentials in one line, the full request on demand. */
function ReqHeader({ req, people, runs }: { req: Req; people: Persona[]; runs: number }) {
  const where = [req.kind === 'trip' ? (req.place || (req.where === 'abroad' ? 'Εξωτερικό' : 'Ελλάδα')) : req.city, req.kind === 'trip' ? '' : req.area].filter(Boolean).join(' · ');
  return (
    <header className="req-head">
      <p className="eyebrow">
        {req.kind ? KIND_LABEL[req.kind] : CATEGORY[req.category].label} · {timeAgo(req.createdAt)}
        {runs > 1 ? ` · ${runs} εκτελέσεις` : ''}
      </p>
      <h1 className="req-title">{req.title}</h1>
      <div className="req-meta">
        {req.periodStart && (
          <span className="nowrap">
            <CalendarClock size={14} /> {formatWhen(req.periodStart)}
          </span>
        )}
        {where && (
          <span>
            <MapPin size={14} /> {where}
          </span>
        )}
        <span className="req-people">
          <AvatarStack personas={people} size={22} /> {people.map((p) => shortName(p, people)).join(', ')}
        </span>
      </div>
      <details className="req-more">
        <summary>
          Το αίτημα <ChevronDown size={14} />
        </summary>
        <p className="small">«{req.text}»</p>
        <p className="tiny muted">
          {req.periodStart && `${formatWhen(req.periodStart)} → ${formatWhen(req.periodEnd)} · `}
          {req.days ? `${req.days} ${req.days === 1 ? 'μέρα' : 'μέρες'} · ` : ''}
          {req.where === 'abroad' ? 'εξωτερικό' : req.where === 'domestic' ? 'Ελλάδα' : 'στην πόλη'}
          {req.city ? ` · ${req.kind === 'trip' ? 'αφετηρία' : 'πόλη'}: ${req.city}${req.cityAssumed ? ' (παραδοχή)' : ''}` : ''}
          {req.pick ? ` · έλεγχος για: ${req.pick}` : ''}. Τα όρια του προφίλ εφαρμόζονται μόνο όπου ταιριάζει το πλαίσιο.
        </p>
      </details>
    </header>
  );
}

/** One short, sourced reason: the person who is least happy, and what in their memory the plan meets. */
function topReason(d: Decision, o: CandidateOption, people: Persona[]) {
  const r = d.outcome.results.find((x) => x.optionId === o.id);
  const order = [...people].sort((a, b) => (r?.scores[a.id] ?? 0) - (r?.scores[b.id] ?? 0));
  const sourced = (o.why ?? []).filter((w) => refsOf(d.inputs, w.memoryId).length);
  for (const p of order) {
    const w = sourced.find((x) => x.personaId === p.id);
    if (w) return { p, text: w.text, ref: refsOf(d.inputs, w.memoryId)[0] };
  }
  for (const p of order) {
    const ev = d.evaluations.find((e) => e.personaId === p.id && e.optionId === o.id);
    const reason = ev?.reasons.find((x) => x.effect === 'for' && refsOf(d.inputs, x.memoryId).length);
    if (reason) return { p, text: reason.text, ref: refsOf(d.inputs, reason.memoryId)[0] };
  }
  return null;
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
    const why = viol[0]?.text ?? (stance === 'agree' ? ev?.verdict || pro : (against ?? ev?.verdict)) ?? '';
    return { p, fits, why };
  });
  const clash = rows.filter((x) => !x.fits);
  return (
    <div className={`callout ${clash.length ? 'bad' : 'good'}`}>
      <p className="callout-head">
        {clash.length ? <X size={16} /> : <Check size={16} />}
        {clash.length ? (
          <span>
            Δεν ταιριάζει σε όλους — αντικρούεται με: <b>{clash.map((x) => shortName(x.p, people)).join(', ')}</b>
          </span>
        ) : (
          <span>Ταιριάζει σε όλη την παρέα</span>
        )}
      </p>
      <ul className="plain callout-list">
        {rows
          .filter((x) => x.why)
          .map((x) => (
            <li key={x.p.id}>
              <b>{shortName(x.p, people)}:</b> {x.why}
            </li>
          ))}
      </ul>
    </div>
  );
}

/** Twin's estimate (score, stance) next to — and clearly apart from — the human's approval. */
function People({ d, people, onState }: { d: Decision; people: Persona[]; onState: (s: AppState) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (pid: string, ok: boolean) => {
    setBusy(pid);
    try {
      onState(await api.approve(d.id, pid, ok));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="people">
      {people.map((p) => {
        const c = d.outcome.concessions.find((x) => x.personaId === p.id);
        const a = d.approvals[p.id];
        return (
          <div key={p.id} className="person">
            <Avatar persona={p} size={30} />
            <div className="person-main">
              <b>{shortName(p, people)}</b>
              <span className="person-est">
                <span className="lbl">Εκτίμηση Twin</span>
                {c ? (
                  <>
                    <b className={`score s-${STANCE[c.stance].tone}`}>{c.finalScore}</b>
                    <span className={`state ${STANCE[c.stance].tone}`}>{STANCE[c.stance].label}</span>
                    {!!c.items.length && (
                      <InfoTip size={13} label={`Τι δίνει: ${p.name}`} title="Τι δίνει">
                        <ul className="tip-bullets">
                          {c.items.map((i) => (
                            <li key={i}>{i}</li>
                          ))}
                        </ul>
                      </InfoTip>
                    )}
                  </>
                ) : (
                  <span className="muted">—</span>
                )}
              </span>
            </div>
            <div className="person-appr">
              <span className="lbl">Έγκριση</span>
              {a === 'pending' ? (
                <span className="appr-actions">
                  <button className="btn btn-sm btn-brand" disabled={!!busy} onClick={() => act(p.id, true)} aria-label={`Εγκρίνω: ${p.name}`}>
                    {busy === p.id ? <Spinner /> : <Check size={14} />} Εγκρίνω
                  </button>
                  <button className="link-btn tiny" disabled={!!busy} onClick={() => act(p.id, false)} aria-label={`Απόρριψη: ${p.name}`}>
                    όχι
                  </button>
                </span>
              ) : (
                <span className={`state ${a === 'approved' ? 'good' : 'bad'}`}>{a === 'approved' ? '✓ Ενέκρινε' : 'Απέρριψε'}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Proposal({ req, d, o, people, onState, onOpen, onRelax, busy }: { req: Req; d: Decision; o: CandidateOption; people: Persona[]; onState: (s: AppState) => void; onOpen: OpenSource; onRelax: (memoryId: string, optionId: string) => void; busy: boolean }) {
  const r = d.outcome.results.find((x) => x.optionId === o.id);
  const name = (pid: string) => {
    const p = people.find((x) => x.id === pid);
    return p ? shortName(p, people) : pid;
  };
  const approved = Object.values(d.approvals).filter((a) => a === 'approved').length;
  const reason = topReason(d, o, people);
  const where = o.venue ? [o.venue.address, o.venue.area, o.venue.city].filter(Boolean).join(', ') : o.itinerary ? `${o.itinerary.destination}, ${o.itinerary.country} · από ${o.itinerary.origin}` : o.location;
  const compromise = d.outcome.status === 'compromise';
  const status = req.pick
    ? { tone: 'neutral', text: 'Η επιλογή σας' }
    : d.status === 'approved'
      ? { tone: 'good', text: 'Εγκρίθηκε από όλους' }
      : compromise
        ? { tone: 'warn', text: d.outcome.noCommonTime ? 'Δεν υπάρχει κοινή ώρα — η πιο κοντινή πρόταση' : 'Η πιο κοντινή πρόταση — δεν καλύπτει όλους' }
        : { tone: 'good', text: 'Κοινή πρόταση των Twins' };
  return (
    <section className={`proposal card ${compromise && !req.pick ? 'is-compromise' : ''}`}>
      <div className="proposal-top">
        <span className={`state ${status.tone}`}>{status.text}</span>
        <span className="tiny muted">
          {approved}/{people.length} εγκρίσεις
        </span>
      </div>
      <h2 className="proposal-title">{o.venue?.name ?? o.title}</h2>
      <dl className="facts">
        {where && (
          <div>
            <dt>
              <MapPin size={14} /> Πού
            </dt>
            <dd>{where}</dd>
          </div>
        )}
        {o.startsAt && (
          <div>
            <dt>
              <Clock size={14} /> {o.itinerary ? 'Αναχώρηση' : 'Πότε'}
            </dt>
            <dd className="nowrap">{formatWhen(o.startsAt)}</dd>
          </div>
        )}
        {o.itinerary ? (
          <div>
            <dt>
              <Clock size={14} /> Επιστροφή
            </dt>
            <dd className="nowrap">{formatWhen(o.itinerary.return.at)}</dd>
          </div>
        ) : (
          o.endsAt && (
            <div>
              <dt>
                <Clock size={14} /> Λήξη
              </dt>
              <dd className="nowrap">{ymd(o.endsAt) === ymd(o.startsAt) || (parseIso(o.endsAt)!.getTime() - (parseIso(o.startsAt)?.getTime() ?? 0)) < 12 * 3600e3 ? hhmm(o.endsAt) : formatWhen(o.endsAt)}</dd>
            </div>
          )
        )}
        {o.costPerPerson !== null && (
          <div>
            <dt>
              <Wallet size={14} /> Κόστος
            </dt>
            <dd>≈{o.costPerPerson}€ / άτομο</dd>
          </div>
        )}
      </dl>

      {reason && (
        <p className="reason">
          <span>
            <b>{shortName(reason.p, people)}:</b> {reason.text}
          </span>
          <button type="button" className="mem-link" onClick={() => onOpen(reason.ref)}>
            <BookOpen size={14} /> Δες τη μνήμη
          </button>
        </p>
      )}

      {compromise && !req.pick && !!r?.violations.length && (
        <div className="callout bad" role="alert">
          <p className="callout-head">
            <AlertTriangle size={16} /> <span>Παραβιάζει αυστηρό όριο — το αποφασίζει ο ίδιος με την έγκρισή του</span>
          </p>
          <ul className="plain callout-list">
            {r.violations.map((v) => (
              <li key={v.memoryId}>
                <b>{name(v.personaId)}:</b> {v.text} <Cite refs={refsOf(d.inputs, v.memoryId)} onOpen={onOpen} />
              </li>
            ))}
          </ul>
          {d.outcome.relaxations.some((x) => d.inputs.find((m) => m.id === x.memoryId)?.rule?.metric !== 'avoid_place') && (
            <div className="callout-actions">
              {d.outcome.relaxations.filter((x, i, all) => all.findIndex((y) => y.memoryId === x.memoryId) === i).map((x) => {
                const m = d.inputs.find((y) => y.id === x.memoryId);
                const owner = people.find((p) => p.id === x.personaId);
                if (!m?.rule || m.rule.metric === 'avoid_place' || !owner) return null;
                return (
                  <button key={x.memoryId + x.optionId} className="btn btn-sm" disabled={busy} onClick={() => onRelax(x.memoryId, x.optionId)} title={x.text}>
                    <Avatar persona={owner} size={18} /> {shortName(owner, people)}: το αλλάζω, μόνο για αυτό
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {!!r?.unverified?.length && (
        <div className="callout warn">
          <p className="callout-head">
            <AlertTriangle size={16} /> <span>Θέλει επιβεβαίωση</span>
          </p>
          <ul className="plain callout-list">
            {r.unverified.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </div>
      )}

      {req.pick && <PickVerdict d={d} o={o} people={people} />}

      <People d={d} people={people} onState={onState} />

      {o.venue?.phone && (
        <div className="proposal-extra">
          <Booking phone={o.venue.phone} />
        </div>
      )}
      <PlanDetails o={o} people={people} memory={d.inputs} onOpen={onOpen} edit={{ decisionId: d.id, onState }} />
      {d.status === 'approved' && <p className="ok-box">Εγκρίθηκε από όλους. Την κράτηση την κάνουν άνθρωποι — τα Twins δεν κλείνουν τίποτα.</p>}
      {d.status === 'rejected' && <p className="notice">Απορρίφθηκε. Προσθέστε μια επιθυμία ή ζητήστε νέες επιλογές.</p>}
    </section>
  );
}

/** Active constraints at a glance; the full wishes form only on «Επεξεργασία επιθυμιών». */
function Constraints({ req, d, people, state, onState, onOpen }: { req: Req; d: Decision; people: Persona[]; state: AppState; onState: (s: AppState) => void; onOpen: OpenSource }) {
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState(people[0]?.id ?? '');
  const [text, setText] = useState('');
  const [scope, setScope] = useState<'request' | 'profile'>('request');
  const [fresh, setFresh] = useState(false);
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const items = state.memory.filter((m) => m.scope === 'request' && m.requestId === req.id && m.status === 'confirmed');
  const strict = d.inputs.filter((m) => m.scope === 'profile' && m.hard).slice(0, 6);
  const ruleText = (m: MemoryItem) => (m.rule ? (m.rule.metric === 'avoid_place' ? `όχι ξανά: ${m.rule.value.split('|').join(', ')}` : m.rule.metric === 'max_cost' ? `≤${m.rule.value}€` : `έως ${describeDeadline(m.rule.value)}`) : '');
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
  const chip = (m: MemoryItem, removable: boolean) => {
    const p = people.find((x) => x.id === m.personaId);
    return (
      <span key={m.id} className={`wish-chip ${m.hard ? 'hard' : ''}`} title={m.statement}>
        {p && <Avatar persona={p} size={18} />}
        <span className="wish-text">{m.rule ? ruleText(m) : m.statement}</span>
        <Cite refs={m.refs.slice(0, 1)} onOpen={onOpen} />
        {removable && (
          <button className="chip-x" aria-label="Αφαίρεση" disabled={!!busy} onClick={() => run('remove', () => api.removeItem(req.id, m.id))}>
            <X size={12} />
          </button>
        )}
      </span>
    );
  };
  return (
    <section className="card section constraints">
      <header className="section-head">
        <h3>Επιθυμίες και όρια</h3>
        <button className="btn btn-sm" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
          <Pencil size={14} /> {open ? 'Κλείσιμο' : 'Επεξεργασία επιθυμιών'}
        </button>
      </header>
      <div className="wish-chips">
        {items.map((m) => chip(m, open))}
        {strict.map((m) => chip(m, false))}
        {!items.length && !strict.length && <span className="small muted">Μόνο η μόνιμη μνήμη κάθε Twin — καμία επιθυμία για αυτό το αίτημα.</span>}
      </div>
      {open && (
        <div className="wish-edit">
          <div className="wish-form">
            <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Ποιος">
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="π.χ. «θέλω να γνωρίσουμε νέα άτομα», «μέχρι Δευτέρα να έχουμε γυρίσει»" aria-label="Νέα επιθυμία" />
            <select value={scope} onChange={(e) => setScope(e.target.value as 'request' | 'profile')} aria-label="Ισχύς">
              <option value="request">Μόνο για αυτό</option>
              <option value="profile">Αποθήκευση στο προφίλ</option>
            </select>
            <label className="tiny muted fresh" title="Μια ποιοτική επιθυμία μπορεί να αλλάξει ΤΙ πρέπει να προταθεί">
              <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} /> και νέες επιλογές
            </label>
            <button className="btn btn-brand" disabled={!!busy || text.trim().length < 3} onClick={() => run('wish', () => api.addWish(req.id, who, text, scope, fresh))} aria-label="Προσθήκη επιθυμίας">
              {busy === 'wish' ? <Spinner /> : <Send size={15} />}
            </button>
          </div>
          <div className="wish-form limit">
            <span className="small">Γρήγορο όριο κόστους για {people.find((p) => p.id === who)?.name}:</span>
            <input type="number" min={1} value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="€ / άτομο" aria-label="Όριο κόστους" />
            <button className="btn" disabled={!!busy || !Number(limit)} onClick={() => run('limit', () => api.setLimit(req.id, who, Number(limit)))}>
              {busy === 'limit' ? <Spinner /> : 'Εφαρμογή'}
            </button>
            <InfoTip label="Πώς λειτουργεί το όριο">Τα αριθμητικά όρια ελέγχονται σε κώδικα: η απόφαση ξαναϋπολογίζεται αμέσως, χωρίς νέες αξιολογήσεις από τα Twins.</InfoTip>
          </div>
          {busy === 'wish' && <Working live={state.status.aiMode === 'live'} steps={['Κατανόηση επιθυμίας', 'Ανάκτηση μνήμης', 'Τα Twins ξανααξιολογούν', 'Κοινή απόφαση']} />}
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </section>
  );
}

/** The pipeline, the code's reasoning and what changed — folded away. */
function HowDecided({ d }: { d: Decision }) {
  return (
    <details className="card section how">
      <summary>
        <h3>Πώς βγήκε η απόφαση</h3>
        <ChevronDown size={16} />
      </summary>
      <ol className="plain how-steps">
        {d.steps.map((s) => (
          <li key={s.key + s.label}>
            <span className={`state ${s.mode === 'ai' ? 'accent' : 'neutral'}`}>{s.mode === 'ai' ? 'AI' : s.mode === 'code' ? 'κώδικας' : 'demo'}</span>
            <div>
              <b>{s.label}</b>
              <div className="small muted">{s.detail}</div>
            </div>
          </li>
        ))}
      </ol>
      <ul className="tip-bullets small">
        {d.outcome.rationale.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {d.diff && d.diff.changes.length > 0 && (
        <>
          <p className="infotip-title">Τι άλλαξε από την προηγούμενη εκτέλεση</p>
          <ul className="tip-bullets small">
            {d.diff.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </>
      )}
      {!!d.rejectedOptions?.length && (
        <>
          <p className="infotip-title">Απορρίφθηκαν πριν την ψηφοφορία ({d.rejectedOptions.length}) — έλεγχος σε κώδικα</p>
          <ul className="tip-bullets small">
            {d.rejectedOptions.map((r, i) => (
              <li key={r.title + i}>
                «{r.title}»: <span className="muted">{r.reason}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="tiny muted">
        Όρια στάσης: ≥{STANCE_THRESHOLDS.agree} συμφωνεί · {STANCE_THRESHOLDS.concede}–{STANCE_THRESHOLDS.agree - 1} με παραχώρηση · &lt;{STANCE_THRESHOLDS.concede} διαφωνεί. {d.aiModel ? `AI: ${d.aiModel}` : 'demo mode'} · {d.inputs.length} αναμνήσεις.
      </p>
    </details>
  );
}

/** Options side by side: what matters readable at once, the full description on demand. */
function OptionCard({ o, d, people, onOpen }: { o: CandidateOption; d: Decision; people: Persona[]; onOpen: OpenSource }) {
  const r = d.outcome.results.find((x) => x.optionId === o.id)!;
  const chosen = d.outcome.chosenOptionId === o.id;
  const name = (id: string) => {
    const p = people.find((x) => x.id === id);
    return p ? shortName(p, people) : id;
  };
  return (
    <article className={`opt-card ${chosen ? 'chosen' : ''} ${r.feasible ? '' : 'out'}`}>
      <header className="opt-head">
        <h4>{o.venue?.name ?? o.title}</h4>
        {chosen ? <span className="state good">Πρόταση</span> : !r.feasible ? <span className="state bad">Εκτός ορίων</span> : null}
      </header>
      <p className="opt-meta">
        {o.costPerPerson !== null && <span className="nowrap">≈{o.costPerPerson}€/άτομο</span>}
        {o.startsAt && <span className="nowrap">{formatWhen(o.startsAt)}</span>}
        {o.itinerary && <span className="nowrap">{o.itinerary.days.length} μέρες</span>}
        {o.venue?.area && <span>{o.venue.area}</span>}
      </p>
      <div className="opt-scores" aria-label="Εκτίμηση κάθε Twin">
        {people.map((p) => (
          <span key={p.id} className="opt-score" title={`${p.name}: ${r.scores[p.id]}/100`}>
            <Avatar persona={p} size={20} />
            <b>{r.scores[p.id]}</b>
          </span>
        ))}
      </div>
      {!!r.violations.length && (
        <p className="opt-flag bad">
          <AlertTriangle size={14} /> Δεν καλύπτει: {[...new Set(r.violations.map((v) => name(v.personaId)))].join(', ')}
        </p>
      )}
      {!r.violations.length && !!r.warnings.length && (
        <p className="opt-flag warn">
          <AlertTriangle size={14} /> {r.warnings.length === 1 ? '1 επισήμανση' : `${r.warnings.length} επισημάνσεις`}
        </p>
      )}
      <details className="opt-more">
        <summary>
          Λεπτομέρειες <ChevronDown size={14} />
        </summary>
        <p className="small">{o.summary}</p>
        {!!o.features.length && (
          <ul className="tip-bullets small">
            {o.features.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
        {r.violations.map((v) => (
          <p key={v.memoryId} className="small bad-text">
            <b>{name(v.personaId)}:</b> {v.text} <Cite refs={refsOf(d.inputs, v.memoryId)} onOpen={onOpen} />
          </p>
        ))}
        {r.warnings.map((w) => (
          <p key={w} className="small warn-text">
            {w}
          </p>
        ))}
        <Checks checks={o.checks?.filter((c) => c.field === 'existence' || c.field === 'program')} compact />
        {o.costNote && <p className="tiny muted">{o.costNote}</p>}
      </details>
    </article>
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
  const startJob = async (label: string, start: () => Promise<{ jobId: string }>) => {
    setBusy(label);
    setErr(null);
    try {
      setJob((await start()).jobId);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  };

  return (
    <div className="thread">
      <ReqHeader req={req} people={people} runs={decisions.length} />

      {busy && job ? (
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
      ) : chosen ? (
        <Proposal req={req} d={d} o={chosen} people={people} onState={onState} onOpen={onOpen} onRelax={relax} busy={!!busy} />
      ) : (
        <section className="proposal card">
          <div className="proposal-top">
            <span className="state warn">Χωρίς επιλογές</span>
          </div>
          <h2 className="proposal-title">Δεν βρέθηκαν υποψήφιες επιλογές</h2>
          <p className="small">Δοκιμάστε «Νέες επιλογές». Τι θα βοηθούσε:</p>
          <ul className="tip-bullets small">
            {d.outcome.relaxations.map((r) => (
              <li key={r.memoryId + r.optionId}>{r.text}</li>
            ))}
            {!d.outcome.relaxations.length && <li>Καμία μεμονωμένη αλλαγή δεν αρκεί — αφαιρέστε μια επιθυμία ή ζητήστε νέες επιλογές.</li>}
          </ul>
        </section>
      )}
      {err && <p className="error">{err}</p>}

      {!(busy && job) && <TwinChatView chat={d.chat} people={people} onRegenerate={(edits) => startJob('chat', () => api.chatEdits(req.id, edits))} preview={4} />}

      <Constraints req={req} d={d} people={people} state={state} onState={onState} onOpen={onOpen} />

      <HowDecided d={d} />

      <section className="section">
        <header className="section-head">
          <h3>Υποψήφιες επιλογές ({d.options.length})</h3>
          <span className="section-actions">
            <button className="btn btn-sm" disabled={!!busy} onClick={() => startJob('rerun', () => api.rerunAsync(req.id, false))}>
              <RefreshCw size={14} /> Ξανατρέξε
            </button>
            <button className="btn btn-sm btn-brand" disabled={!!busy} onClick={() => startJob('regen', () => api.rerunAsync(req.id, true))}>
              <Sparkles size={14} /> Νέες επιλογές{live ? '' : ' (demo)'}
            </button>
          </span>
        </header>
        <div className="opt-grid">
          {d.options.map((o) => (
            <OptionCard key={o.id} o={o} d={d} people={people} onOpen={onOpen} />
          ))}
        </div>
      </section>
    </div>
  );
}
