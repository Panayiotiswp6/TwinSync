import { BedDouble, Check, CheckCircle2, Clock, ExternalLink, Phone, PlaneLanding, PlaneTakeoff, RotateCcw, ShieldCheck, Sparkles, Undo2, Wallet, X } from 'lucide-react';
import { useState } from 'react';
import type { CandidateOption, MemoryItem, OptionCheck, Persona } from '../../../shared/types';
import { formatWhen, localParts, parseIso, WEEKDAYS_EL } from '../../../shared/time';
import { api, type AppState } from '../api';
import { Avatar, AvatarStack, Cite, InfoTip, Spinner, type OpenSource } from './ui';

const refsOf = (memory: MemoryItem[], id: string) => memory.find((m) => m.id === id)?.refs ?? [];
const hhmm = (iso: string | null) => {
  const d = parseIso(iso);
  if (!d) return '';
  const p = localParts(d);
  return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
};

/** "Σάββατο 21/11 16:30–18:30" */
export function whenText(o: CandidateOption): string {
  if (!o.startsAt) return '';
  const end = hhmm(o.endsAt);
  return `${formatWhen(o.startsAt)}${end && !o.itinerary ? `–${end}` : ''}`;
}

/** Only what is backed by a public source is shown (the rest is checked in code, not displayed). */
export function Checks({ checks, compact }: { checks?: OptionCheck[]; compact?: boolean }) {
  const shown = (checks ?? []).filter((c) => c.status === 'confirmed');
  if (!shown.length) return null;
  return (
    <ul className={`checks ${compact ? 'compact' : ''}`}>
      {shown.map((c) => (
        <li key={c.field + c.text} className="check check-confirmed">
          <CheckCircle2 size={14} />
          <span>
            {c.text}
            {c.url && (
              <>
                {' · '}
                <a href={c.url} target="_blank" rel="noreferrer">
                  {c.source ?? 'πηγή'}
                  {c.date ? `, ${c.date}` : ''} <ExternalLink size={11} />
                </a>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A discreet "Κράτηση" chip that reveals the place's public phone (only places that take bookings). */
export function Booking({ phone }: { phone: string }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <a className="booking on" href={`tel:${phone.replace(/\s+/g, '')}`}>
      <Phone size={13} /> {phone.replace(/^\+30\s*/, '')}
    </a>
  ) : (
    <button type="button" className="booking" onClick={() => setOpen(true)}>
      <Phone size={13} /> Κράτηση
    </button>
  );
}

/** The practical line on top: where, when, how much (and, for the final proposal, how to book). */
export function PlanHead({ o, booking }: { o: CandidateOption; booking?: boolean }) {
  const v = o.venue;
  return (
    <div className="plan-head">
      {v ? (
        <p className="plan-where">
          <b>{v.name}</b>
          <span className="muted"> · {[v.address, v.area, v.city].filter(Boolean).join(', ')}</span>
        </p>
      ) : o.itinerary ? (
        <p className="plan-where">
          <b>
            {o.itinerary.destination}, {o.itinerary.country}
          </b>
          <span className="muted"> · από {o.itinerary.origin}</span>
        </p>
      ) : null}
      <div className="plan-chips">
        {whenText(o) && (
          <span>
            <Clock size={13} /> {whenText(o)}
          </span>
        )}
        {o.itinerary && (
          <span>
            <Undo2 size={13} /> πίσω {formatWhen(o.itinerary.return.at)}
          </span>
        )}
        {o.costPerPerson !== null && (
          <span>
            <Wallet size={13} /> ≈{o.costPerPerson}€/άτομο
          </span>
        )}
        {o.synthetic && <span className="warn">συνθετικό demo</span>}
        {booking && v?.phone && <Booking phone={v.phone} />}
      </div>
    </div>
  );
}

function person(people: Persona[], id: string) {
  return people.find((x) => x.id === id);
}

/** Who a set of reasons is about, grouped per person, with the source of each. */
function ByPerson({ rows, people, memory, onOpen }: { rows: { personaId: string; memoryId: string; text: string }[]; people: Persona[]; memory: MemoryItem[]; onOpen: OpenSource }) {
  const ids = [...new Set(rows.map((r) => r.personaId))];
  return (
    <div className="tip-groups">
      {ids.map((id) => {
        const p = person(people, id);
        return (
          <div key={id} className="tip-group">
            <p className="tip-who">
              {p && <Avatar persona={p} size={18} />} <b>{p?.name ?? id}</b>
            </p>
            <ul className="plain tip-list">
              {rows
                .filter((r) => r.personaId === id)
                .map((r) => (
                  <li key={r.memoryId + r.text}>
                    {r.text} <Cite refs={refsOf(memory, r.memoryId)} onOpen={onOpen} />
                  </li>
                ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** One calm row of facts about the plan; every explanation sits behind an ⓘ. */
function PlanFacts({ o, people, memory, onOpen }: { o: CandidateOption; people: Persona[]; memory: MemoryItem[]; onOpen: OpenSource }) {
  const why = o.why ?? [];
  const cov = o.coverage ?? [];
  const sourced = (o.checks ?? []).filter((c) => c.status === 'confirmed');
  const fits = people.filter((p) => why.some((w) => w.personaId === p.id));
  // A slot that depends on the weather is still in the plan: it counts as covered.
  const covered = cov.filter((c) => c.status !== 'uncovered').length;
  if (!why.length && !cov.length && !sourced.length) return null;
  return (
    <div className="plan-facts">
      {!!why.length && (
        <span className="fact">
          <AvatarStack personas={fits} size={20} />
          <span>Γιατί ταιριάζει</span>
          <InfoTip title="Γιατί ταιριάζει σε κάθε Twin" label="Γιατί ταιριάζει" wide>
            <ByPerson rows={why.map((w) => ({ personaId: w.personaId, memoryId: w.memoryId, text: w.text }))} people={people} memory={memory} onOpen={onOpen} />
          </InfoTip>
        </span>
      )}
      {!!cov.length && (
        <span className="fact">
          <Sparkles size={14} className="fact-icon" />
          <span>
            Επιθυμίες <b>{covered}/{cov.length}</b>
          </span>
          <InfoTip title="Τι παίρνει κάθε επιθυμία" label="Επιθυμίες" wide>
            <ul className="plain tip-list">
              {cov.map((c) => {
                const p = person(people, c.personaId);
                const ok = c.status !== 'uncovered';
                return (
                  <li key={c.personaId + c.memoryId} className="tip-cover">
                    {p && <Avatar persona={p} size={18} />}
                    <span>
                      {c.statement} <span className={`cover-tag ${ok ? 'covered' : 'uncovered'}`}>{ok ? 'καλύπτεται' : 'όχι σε αυτό το πλάνο'}</span>
                      {c.where && <span className="muted"> · {c.where}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </InfoTip>
        </span>
      )}
      {!!sourced.length && (
        <span className="fact">
          <ShieldCheck size={14} className="fact-icon" />
          <span>Τεκμηρίωση</span>
          <InfoTip title="Από δημόσιες πηγές" label="Τεκμηρίωση" wide>
            <Checks checks={sourced} />
          </InfoTip>
        </span>
      )}
    </div>
  );
}

function dayLabel(date: string, i: number): string {
  const d = parseIso(`${date}T12:00:00`);
  if (!d) return date || `Μέρα ${i + 1}`;
  const p = localParts(d);
  return `${WEEKDAYS_EL[p.weekday].slice(0, 3)} ${p.d}/${p.m}`;
}

export interface PlanEdit {
  decisionId: string;
  onState: (s: AppState) => void;
}

function Itinerary({ o, people, memory, onOpen, edit }: { o: CandidateOption; people: Persona[]; memory: MemoryItem[]; onOpen: OpenSource; edit?: PlanEdit }) {
  const it = o.itinerary!;
  const [day, setDay] = useState(0);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const d = it.days[Math.min(day, it.days.length - 1)];
  const statement = (id: string) => memory.find((m) => m.id === id)?.statement ?? id;
  const editable = !!edit && !it.confirmed;
  const key = (date: string, i: number) => `${date}|${i}`;
  const toggle = (k: string) =>
    setMarked((m) => {
      const n = new Set(m);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const confirm = async () => {
    if (!edit) return;
    setBusy(true);
    setErr(null);
    try {
      const remove = [...marked].map((k) => {
        const [date, i] = k.split('|');
        return { date, index: Number(i) };
      });
      const r = await api.editItinerary(edit.decisionId, o.id, remove);
      setMarked(new Set());
      edit.onState(r.state);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="itin">
      <div className="itin-edges">
        <div className="edge">
          <PlaneTakeoff size={16} />
          <div>
            <span className="eyebrow">Αναχώρηση</span>
            <b>{formatWhen(it.depart.at)}</b>
            <span className="tiny muted clamp" title={it.depart.mode}>
              {it.depart.mode}
            </span>
          </div>
        </div>
        <div className="edge">
          <BedDouble size={16} />
          <div>
            <span className="eyebrow">Διαμονή</span>
            <b>{it.stay.name}</b>
            <span className="tiny muted">
              {it.stay.area}
              {it.stay.note && (
                <>
                  {' '}
                  <InfoTip size={12} label="Για τη διαμονή">
                    {it.stay.note}
                  </InfoTip>
                </>
              )}
            </span>
          </div>
        </div>
        <div className="edge">
          <PlaneLanding size={16} />
          <div>
            <span className="eyebrow">Επιστροφή</span>
            <b>{formatWhen(it.return.at)}</b>
            <span className="tiny muted clamp" title={it.return.mode}>
              {it.return.mode}
            </span>
          </div>
        </div>
      </div>

      <div className="day-tabs" role="tablist" aria-label="Μέρες">
        {it.days.map((x, i) => {
          const n = x.slots.filter((_, j) => marked.has(key(x.date, j))).length;
          return (
            <button key={x.date} role="tab" aria-selected={i === day} className={`day-tab ${i === day ? 'on' : ''}`} onClick={() => setDay(i)}>
              <span className="day-n">
                Μέρα {i + 1}
                {n > 0 && <span className="day-x">−{n}</span>}
              </span>
              <span className="day-d">{dayLabel(x.date, i)}</span>
            </button>
          );
        })}
        {it.confirmed && (
          <span className="itin-ok">
            <Check size={14} /> Επιβεβαιωμένο πρόγραμμα
          </span>
        )}
      </div>

      {d && (
        <section className="itin-day" role="tabpanel">
          {d.title && <h4>{d.title}</h4>}
          <ol className="plain timeline">
            {d.slots.map((s, i) => {
              const who = people.filter((p) => s.serves.some((x) => x.personaId === p.id));
              const extra = s.serves.length > 0 || s.alternative;
              const k = key(d.date, i);
              const out = marked.has(k);
              return (
                <li key={i} className={`tl-slot ${out ? 'out' : ''}`}>
                  <span className="tl-time">
                    {s.start}
                    <small>{s.end}</small>
                  </span>
                  <span className="tl-dot" aria-hidden />
                  <div className="tl-body">
                    <b>{s.title}</b>
                    {s.place && <span className="tl-place">{s.place}</span>}
                  </div>
                  <span className="tl-meta">
                    {!!who.length && <AvatarStack personas={who} size={18} />}
                    {extra && (
                      <InfoTip label={`Λεπτομέρειες: ${s.title}`} wide>
                        {s.serves.length > 0 && (
                          <>
                            <p className="infotip-title">Για ποιον</p>
                            <ul className="plain tip-list">
                              {s.serves.map((x) => {
                                const p = person(people, x.personaId);
                                return (
                                  <li key={x.personaId + x.memoryId} className="tip-cover">
                                    {p && <Avatar persona={p} size={18} />}
                                    <span>
                                      {statement(x.memoryId)} <Cite refs={refsOf(memory, x.memoryId)} onOpen={onOpen} />
                                    </span>
                                  </li>
                                );
                              })}
                            </ul>
                          </>
                        )}
                        {s.alternative && (
                          <p className="tip-note">
                            <b>Εναλλακτική:</b> {s.alternative}
                          </p>
                        )}
                      </InfoTip>
                    )}
                    {editable && (
                      <button type="button" className={`tl-x ${out ? 'on' : ''}`} onClick={() => toggle(k)} disabled={busy} aria-label={out ? `Κράτα «${s.title}»` : `Αφαίρεση «${s.title}»`} title={out ? 'Να μείνει' : 'Να φύγει από το πρόγραμμα'}>
                        {out ? <RotateCcw size={13} /> : <X size={14} />}
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      <div className="itin-cost">
        {(
          [
            ['Μετακίνηση', it.cost.transport],
            ['Διαμονή', it.cost.stay],
            ['Φαγητό', it.cost.food],
            ['Δραστηριότητες', it.cost.activities],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="cost-cell">
            <span className="tiny muted">{k}</span>
            <b>{v}€</b>
          </div>
        ))}
        <div className="cost-cell total">
          <span className="tiny">
            Σύνολο / άτομο{' '}
            <InfoTip size={12} label="Για το κόστος">
              Ανά άτομο. Ελέγχθηκε σε κώδικα: όλες οι μέρες, χρονική σειρά χωρίς επικαλύψεις, σύνολα κόστους.
            </InfoTip>
          </span>
          <b>{it.cost.total}€</b>
        </div>
      </div>

      {editable && (
        <div className={`itin-confirm ${marked.size ? 'changes' : ''}`}>
          <span className="small muted">
            {marked.size
              ? `${marked.size === 1 ? '1 δραστηριότητα φεύγει' : `${marked.size} δραστηριότητες φεύγουν`} — το υπόλοιπο πρόγραμμα μένει ίδιο.`
              : 'Κάτι δεν σας κάνει; Πατήστε Χ στη δραστηριότητα και μετά «Επιβεβαίωση».'}
          </span>
          <button className="btn btn-brand" disabled={busy} onClick={confirm}>
            {busy ? <Spinner label={marked.size ? 'Νέο πρόγραμμα…' : 'Επιβεβαίωση…'} /> : <><Check size={15} /> Επιβεβαίωση</>}
          </button>
          {err && <span className="error small">{err}</span>}
        </div>
      )}
    </div>
  );
}

/** Full plan: the itinerary up front; why it fits, what each wish gets and what is sourced sit behind ⓘ. */
export function PlanDetails({ o, people, memory, onOpen, edit }: { o: CandidateOption; people: Persona[]; memory: MemoryItem[]; onOpen: OpenSource; edit?: PlanEdit }) {
  return (
    <div className="plan">
      <PlanFacts o={o} people={people} memory={memory} onOpen={onOpen} />
      {o.itinerary && <Itinerary key={`${o.id}-${o.itinerary.cost.total}-${o.itinerary.days.map((d) => d.slots.length).join('.')}`} o={o} people={people} memory={memory} onOpen={onOpen} edit={edit} />}
    </div>
  );
}
