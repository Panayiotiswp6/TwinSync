import { BedDouble, CheckCircle2, CircleDashed, Clock, ExternalLink, HelpCircle, PlaneLanding, PlaneTakeoff, ShieldCheck, Sparkles, Ticket, Undo2, Wallet } from 'lucide-react';
import { useState } from 'react';
import type { CandidateOption, MemoryItem, OptionCheck, Persona } from '../../../shared/types';
import { formatWhen, localParts, parseIso, WEEKDAYS_EL } from '../../../shared/time';
import { Avatar, AvatarStack, Cite, InfoTip, type OpenSource } from './ui';

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

const CHECK_ICON = {
  confirmed: <CheckCircle2 size={14} />,
  estimated: <CircleDashed size={14} />,
  to_check: <HelpCircle size={14} />,
};
const CHECK_LABEL = { confirmed: 'επιβεβαιωμένο', estimated: 'εκτίμηση', to_check: 'προς έλεγχο' };

export function Checks({ checks, compact }: { checks?: OptionCheck[]; compact?: boolean }) {
  if (!checks?.length) return null;
  return (
    <ul className={`checks ${compact ? 'compact' : ''}`}>
      {checks.map((c) => (
        <li key={c.field + c.text} className={`check check-${c.status}`} title={CHECK_LABEL[c.status]}>
          {CHECK_ICON[c.status]}
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

/** The practical line on top: where, when, how much. */
export function PlanHead({ o }: { o: CandidateOption }) {
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
        {o.event && (
          <span className="warn">
            <Ticket size={13} /> πρόγραμμα: προς έλεγχο <InfoTip size={13} label="Για το πρόγραμμα">{o.event.note}</InfoTip>
          </span>
        )}
        {o.synthetic && <span className="warn">συνθετικό demo</span>}
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

const COVER_LABEL = { covered: 'καλύπτεται', conditional: 'υπό προϋπόθεση', uncovered: 'ακάλυπτη' } as const;

/** One calm row of facts about the plan; every explanation sits behind an ⓘ. */
function PlanFacts({ o, people, memory, onOpen }: { o: CandidateOption; people: Persona[]; memory: MemoryItem[]; onOpen: OpenSource }) {
  const why = o.why ?? [];
  const cov = o.coverage ?? [];
  const checks = o.checks ?? [];
  const fits = people.filter((p) => why.some((w) => w.personaId === p.id));
  const n = (s: keyof typeof COVER_LABEL) => cov.filter((c) => c.status === s).length;
  const open = checks.filter((c) => c.status === 'to_check').length;
  if (!why.length && !cov.length && !checks.length) return null;
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
            Επιθυμίες <b>{n('covered')}/{cov.length}</b>
          </span>
          {n('conditional') + n('uncovered') > 0 && <span className={`dot ${n('uncovered') ? 'bad' : 'warn'}`} />}
          <InfoTip title="Τι παίρνει κάθε επιθυμία" label="Επιθυμίες" tone={n('uncovered') ? 'bad' : n('conditional') ? 'warn' : undefined} wide>
            <ul className="plain tip-list">
              {cov.map((c) => {
                const p = person(people, c.personaId);
                return (
                  <li key={c.personaId + c.memoryId} className="tip-cover">
                    {p && <Avatar persona={p} size={18} />}
                    <span>
                      {c.statement} <span className={`cover-tag ${c.status}`}>{COVER_LABEL[c.status]}</span>
                      {c.where && <span className="muted"> · {c.where}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </InfoTip>
        </span>
      )}
      {!!checks.length && (
        <span className="fact">
          <ShieldCheck size={14} className="fact-icon" />
          <span>Τεκμηρίωση</span>
          {open > 0 && <span className="dot warn" title={`${open} προς έλεγχο`} />}
          <InfoTip title="Τι επιβεβαιώθηκε και τι μένει να ελεγχθεί" label="Τεκμηρίωση" wide>
            <Checks checks={checks} />
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

function Itinerary({ o, people, memory, onOpen }: { o: CandidateOption; people: Persona[]; memory: MemoryItem[]; onOpen: OpenSource }) {
  const it = o.itinerary!;
  const [day, setDay] = useState(0);
  const d = it.days[Math.min(day, it.days.length - 1)];
  const statement = (id: string) => memory.find((m) => m.id === id)?.statement ?? id;
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
        {it.days.map((x, i) => (
          <button key={x.date} role="tab" aria-selected={i === day} className={`day-tab ${i === day ? 'on' : ''}`} onClick={() => setDay(i)}>
            <span className="day-n">Μέρα {i + 1}</span>
            <span className="day-d">{dayLabel(x.date, i)}</span>
          </button>
        ))}
      </div>

      {d && (
        <section className="itin-day" role="tabpanel">
          {d.title && <h4>{d.title}</h4>}
          <ol className="plain timeline">
            {d.slots.map((s, i) => {
              const who = people.filter((p) => s.serves.some((x) => x.personaId === p.id));
              const extra = s.serves.length > 0 || s.conditional || s.alternative;
              return (
                <li key={i} className={`tl-slot ${s.conditional ? 'cond' : ''}`}>
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
                      <InfoTip label={`Λεπτομέρειες: ${s.title}`} tone={s.conditional ? 'warn' : undefined} wide>
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
                        {s.conditional && (
                          <p className="tip-note warn-text">
                            <b>Υπό προϋπόθεση:</b> {s.conditional}
                          </p>
                        )}
                        {s.alternative && (
                          <p className="tip-note">
                            <b>Εναλλακτική:</b> {s.alternative}
                          </p>
                        )}
                      </InfoTip>
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
              Εκτίμηση ανά άτομο. Ελέγχθηκε σε κώδικα: όλες οι μέρες, χρονική σειρά χωρίς επικαλύψεις, σύνολα κόστους.
            </InfoTip>
          </span>
          <b>{it.cost.total}€</b>
        </div>
      </div>
    </div>
  );
}

/** Full plan: the itinerary up front; why it fits, what each wish gets and what is verified sit behind ⓘ. */
export function PlanDetails({ o, people, memory, onOpen }: { o: CandidateOption; people: Persona[]; memory: MemoryItem[]; onOpen: OpenSource }) {
  return (
    <div className="plan">
      <PlanFacts o={o} people={people} memory={memory} onOpen={onOpen} />
      {o.itinerary && <Itinerary o={o} people={people} memory={memory} onOpen={onOpen} />}
    </div>
  );
}
