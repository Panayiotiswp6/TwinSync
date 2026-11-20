import { CheckCircle2, CircleDashed, ExternalLink, HelpCircle } from 'lucide-react';
import type { CandidateOption, MemoryItem, OptionCheck, Persona } from '../../../shared/types';
import { formatWhen, localParts, parseIso } from '../../../shared/time';
import { Avatar, Badge, Cite, type OpenSource } from './ui';

const short = (t: string, n = 46) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
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
        {whenText(o) && <span>🕒 {whenText(o)}</span>}
        {o.itinerary && <span>↩ πίσω {formatWhen(o.itinerary.return.at)}</span>}
        {o.costPerPerson !== null && <span>≈{o.costPerPerson}€/άτομο (εκτίμηση)</span>}
        {o.event && <span className="warn">🎫 {o.event.note}</span>}
        {o.synthetic && <span className="warn">συνθετικό fixture (demo)</span>}
      </div>
    </div>
  );
}

function Who({ people, id }: { people: Persona[]; id: string }) {
  const p = people.find((x) => x.id === id);
  return p ? <Avatar persona={p} size={18} /> : null;
}

/** Full plan: why it fits each twin, the itinerary, what each wish gets, and what is verified. */
export function PlanDetails({ o, people, memory, onOpen }: { o: CandidateOption; people: Persona[]; memory: MemoryItem[]; onOpen: OpenSource }) {
  const it = o.itinerary;
  const statement = (id: string) => memory.find((m) => m.id === id)?.statement ?? id;
  return (
    <div className="plan">
      {!!o.why?.length && (
        <ul className="plain plan-why">
          {o.why.map((w) => (
            <li key={w.personaId + w.memoryId}>
              <Who people={people} id={w.personaId} /> {w.text} <Cite refs={refsOf(memory, w.memoryId)} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
      {it && (
        <div className="itin">
          <p className="itin-edge">
            🛫 <b>{formatWhen(it.depart.at)}</b> · {it.depart.mode}
          </p>
          <p className="itin-edge">
            🏨 <b>{it.stay.name}</b>, {it.stay.area}
            {it.stay.note && <span className="muted"> · {it.stay.note}</span>}
          </p>
          {it.days.map((d) => (
            <section key={d.date} className="itin-day">
              <h4>
                {d.title} <span className="muted tiny">{d.date}</span>
              </h4>
              <ol className="plain">
                {d.slots.map((s, i) => (
                  <li key={i} className="itin-slot">
                    <span className="itin-time">
                      {s.start}–{s.end}
                    </span>
                    <div>
                      <b>{s.title}</b>
                      {s.place && <span className="muted small"> · {s.place}</span>}
                      {s.serves.length > 0 && (
                        <div className="itin-serves">
                          {s.serves.map((x) => (
                            <span key={x.personaId + x.memoryId} className="serve" title={statement(x.memoryId)}>
                              <Who people={people} id={x.personaId} /> {short(statement(x.memoryId))}
                              <Cite refs={refsOf(memory, x.memoryId)} onOpen={onOpen} />
                            </span>
                          ))}
                        </div>
                      )}
                      {s.conditional && <div className="tiny warn-text">υπό προϋπόθεση: {s.conditional}</div>}
                      {s.alternative && <div className="tiny muted">εναλλακτική: {s.alternative}</div>}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ))}
          <p className="itin-edge">
            🛬 πίσω στην αφετηρία <b>{formatWhen(it.return.at)}</b> · {it.return.mode}
          </p>
          <table className="itin-cost">
            <tbody>
              <tr>
                <td>Μετακίνηση</td>
                <td>{it.cost.transport}€</td>
                <td>Διαμονή</td>
                <td>{it.cost.stay}€</td>
                <td>Φαγητό</td>
                <td>{it.cost.food}€</td>
                <td>Δραστηριότητες</td>
                <td>{it.cost.activities}€</td>
                <td>
                  <b>Σύνολο</b>
                </td>
                <td>
                  <b>{it.cost.total}€</b>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="tiny muted">Ανά άτομο, εκτίμηση. Ελέγχθηκε σε κώδικα: όλες οι μέρες, χρονική σειρά χωρίς επικαλύψεις, σύνολα κόστους.</p>
        </div>
      )}
      {!!o.coverage?.length && (
        <div className="coverage">
          <p className="eyebrow">Επιθυμίες</p>
          <ul className="plain">
            {o.coverage.map((c) => (
              <li key={c.personaId + c.memoryId}>
                <Who people={people} id={c.personaId} /> {c.statement}{' '}
                <Badge tone={c.status === 'covered' ? 'good' : c.status === 'conditional' ? 'warn' : 'bad'}>
                  {c.status === 'covered' ? 'καλύπτεται' : c.status === 'conditional' ? 'υπό προϋπόθεση' : 'ακάλυπτη'}
                </Badge>
                {c.where && <span className="tiny muted"> · {c.where}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Checks checks={o.checks} />
    </div>
  );
}
