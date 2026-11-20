// Facts, templates and a grounding guard for each twin's group-chat draft.
// A model draft may only restate facts derived from the decision; anything else is rejected.

import { ownerText } from './heuristics';
import { normalizeGreek } from './text';
import { formatWhen } from './time';
import type { CandidateOption, ChatLine, Decision, GroupRequest, Persona, PersonaId, Source } from './types';

const STYLE_PRIORITY = ['chat', 'email', 'note', 'document', 'past_decision'];

/** Sources containing the persona's own words — the style reference. Chats first; interviewer questions removed. */
export function styleSamples(sources: Source[], personaId: PersonaId): Source[] {
  return sources
    .filter((s) => s.personaId === personaId && STYLE_PRIORITY.includes(s.kind) && !(s.kind === 'past_decision' && s.title.startsWith('Απόφαση: ')))
    .map((s, i) => ({ s, i }))
    .sort((a, b) => STYLE_PRIORITY.indexOf(a.s.kind) - STYLE_PRIORITY.indexOf(b.s.kind) || b.i - a.i)
    .slice(0, 8)
    .map(({ s }) => ({ ...s, text: ownerText(s.text).trim() }))
    .filter((s) => s.text.length > 0);
}

export function messageFacts(d: Decision, req: GroupRequest, personaId: PersonaId, personas: Persona[]): string[] {
  const opt = (id: string | null) => d.options.find((o) => o.id === id);
  const name = (id: string) => personas.find((p) => p.id === id)?.name ?? id;
  const vote = d.outcome.votes.find((v) => v.personaId === personaId);
  const facts: string[] = [`Το αίτημα της παρέας: ${req.title}.`];
  const mine = opt(vote?.optionId ?? null);
  if (mine) facts.push(`Η δική μου πρώτη επιλογή ήταν: ${mine.title}.`);
  const chosen = opt(d.outcome.chosenOptionId);
  if (chosen && d.outcome.status === 'compromise') {
    facts.push(`${d.outcome.noCommonTime ? 'Δεν υπάρχει κοινή ώρα για όλους' : 'Δεν υπάρχει πρόταση που να χωράει σε όλα τα αυστηρά όρια'}. Η πιο κοντινή (υποθετική) επιλογή: ${chosen.title}.`);
    const mineBreach = d.outcome.results.find((r) => r.optionId === chosen.id)?.violations.filter((v) => v.personaId === personaId) ?? [];
    for (const v of mineBreach) facts.push(`Αυτή η επιλογή παραβιάζει το όριό μου: ${v.text}. Το αποφασίζω εγώ αν θα το αλλάξω.`);
    for (const r of d.outcome.relaxations.slice(0, 2)) facts.push(`Θα άνοιγε επιλογές: ${r.text}`);
  } else if (chosen) {
    facts.push(`Κοινή πρόταση: ${placeLine(chosen)}.`);
    if (chosen.costPerPerson !== null) facts.push(`Κόστος περίπου ${chosen.costPerPerson}€ το άτομο.`);
    if (chosen.endsAt) facts.push(`Τελειώνει ${formatWhen(chosen.endsAt)}.`);
    if (chosen.features.length) facts.push(`Περιλαμβάνει: ${chosen.features.slice(0, 4).join(', ')}.`);
    const c = d.outcome.concessions.find((x) => x.personaId === personaId);
    if (c) {
      facts.push(c.stance === 'agree' ? 'Συμφωνώ με την πρόταση.' : c.stance === 'agree_with_concession' ? 'Συμφωνώ, με κάποια παραχώρηση.' : 'Δεν με βολεύει η πρόταση.');
      for (const item of c.items.slice(0, 3)) facts.push(`Παραχώρηση: ${item}.`);
    }
    const why = vote?.reasons.find((r) => r.effect === 'for');
    if (why && vote?.optionId === chosen.id) facts.push(`Γιατί μου ταιριάζει: ${why.text}.`);
  } else {
    facts.push('Δεν βρέθηκε επιλογή που να περνά όλους τους υποχρεωτικούς περιορισμούς.');
    for (const r of d.outcome.relaxations.slice(0, 3)) facts.push(r.personaId === personaId ? `Θα ξεμπλόκαρε αν εγώ: ${r.text.replace(`${name(r.personaId)}: `, '')}` : `Θα ξεμπλόκαρε: ${r.text}`);
  }
  return facts;
}

/** "O Kokkos (Παγκράτι, Σπύρου Μερκούρη 25), Σάββατο 21/11 16:30" — the practical line. */
export function placeLine(o: CandidateOption): string {
  const v = o.venue;
  const where = v ? `${v.name} (${[v.area, v.address].filter(Boolean).join(', ')})` : `${o.title}${o.location ? `, ${o.location}` : ''}`;
  return `${where}${o.startsAt ? `, ${formatWhen(o.startsAt)}` : ''}`;
}

export function templateMessage(d: Decision, personaId: PersonaId): string {
  const chosen = d.options.find((o) => o.id === d.outcome.chosenOptionId);
  if (chosen && d.outcome.status === 'compromise') {
    const breach = d.outcome.results.find((r) => r.optionId === chosen.id)?.violations.find((v) => v.personaId === personaId);
    return breach ? `Με αυτά που ισχύουν δεν βγαίνει για μένα (${breach.text}). Να το ξαναδούμε;` : 'Δεν βγαίνει κάτι που να χωράει σε όλους. Να αλλάξουμε κάτι;';
  }
  if (!chosen) {
    const mine = d.outcome.relaxations.find((r) => r.personaId === personaId);
    return mine ? `Δεν βγαίνει κάτι με τα τωρινά όρια. Από μένα θα βοηθούσε: ${mine.text.split(': ').slice(1).join(': ')}` : 'Δεν βγαίνει κάτι με τα τωρινά όρια όλων. Να το ξαναδούμε;';
  }
  const c = d.outcome.concessions.find((x) => x.personaId === personaId);
  const cost = chosen.costPerPerson !== null ? ` ${chosen.costPerPerson}€ το άτομο.` : '';
  if (!c || c.stance === 'agree') return `Μέσα για ${chosen.title}!${cost}`;
  if (c.stance === 'agree_with_concession') return `Οκ για ${chosen.title}, ας είναι.${cost}`;
  return `Για ${chosen.title} δεν είμαι σίγουρος, να το συζητήσουμε πριν κλείσουμε.`;
}

/** Every number in the draft must appear in the facts; no option title outside the facts. */
export function ungroundedReason(text: string, facts: string[], options: CandidateOption[]): string | null {
  const factText = normalizeGreek(facts.join(' '));
  // Whole numbers only: "7" must not pass because a fact contains "27/11".
  const NUM = /\d+(?:[.:,]\d+)?/g;
  const known = new Set<string>();
  for (const n of factText.match(NUM) ?? []) {
    known.add(n);
    for (const part of n.split(/[.:,]/)) known.add(part);
  }
  for (const n of text.match(NUM) ?? []) {
    if (![n, n.replace('.', ':'), n.replace(':', '.')].some((v) => known.has(v))) return `ανέφερε «${n}», που δεν υπάρχει στα δεδομένα της απόφασης`;
  }
  const norm = normalizeGreek(text);
  for (const o of options) {
    const head = normalizeGreek(o.title.split(/[–&,:-]/)[0].trim());
    if (head.length >= 6 && norm.includes(head) && !factText.includes(head)) return `ανέφερε «${o.title}», που δεν είναι στα δεδομένα του`;
  }
  return text.length > 300 ? 'πολύ μεγάλο μήνυμα' : null;
}

/** Facts the negotiation chat may use: shared ones, and each person's own (vote, reasons, wishes, concessions). */
export function chatFacts(d: Decision, req: GroupRequest, personas: Persona[]): { shared: string[]; perPerson: Record<PersonaId, string[]> } {
  const opt = (id: string | null) => d.options.find((o) => o.id === id);
  const chosen = opt(d.outcome.chosenOptionId);
  const shared = [`Αίτημα: ${req.title}.`, ...d.options.map((o) => `Επιλογή: ${o.venue ? placeLine(o) : o.title}${o.venue ? '' : o.location ? ` (${o.location})` : ''}${o.costPerPerson !== null ? `, ~${o.costPerPerson}€/άτομο` : ''}${o.endsAt ? `, ως ${formatWhen(o.endsAt)}` : ''}.`)];
  if (chosen && d.outcome.status === 'compromise') {
    shared.push(`${d.outcome.noCommonTime ? 'Δεν υπάρχει κοινή ώρα.' : 'Καμία επιλογή δεν χωράει σε όλα τα αυστηρά όρια.'} Η πιο κοντινή είναι υποθετική (${chosen.title}) και χρειάζεται απόφαση των κατόχων — κανείς δεν έχει δεχτεί παραβίαση.`);
    for (const r of d.outcome.relaxations.slice(0, 2)) shared.push(`Θα άνοιγε επιλογές: ${r.text}`);
  } else if (chosen) shared.push(`Τελική κοινή πρόταση: ${chosen.venue ? placeLine(chosen) : chosen.title}.`);
  if (chosen?.itinerary) for (const day of chosen.itinerary.days) shared.push(`Πρόγραμμα ${day.title || day.date}: ${day.slots.map((x) => `${x.start} ${x.title}`).join(' · ')}.`);
  const perPerson: Record<PersonaId, string[]> = {};
  for (const p of personas) {
    const f: string[] = [];
    const vote = d.outcome.votes.find((v) => v.personaId === p.id);
    const mine = opt(vote?.optionId ?? null);
    if (mine) f.push(`Η πρώτη μου επιλογή: ${mine.title}${vote?.verdict ? ` — «${vote.verdict}»` : ''}.`);
    for (const r of vote?.reasons.slice(0, 3) ?? []) f.push(`${r.effect === 'for' ? 'Υπέρ' : 'Κατά'}: ${r.text}`);
    for (const m of d.inputs.filter((x) => x.personaId === p.id && x.scope === 'request').slice(0, 3)) f.push(`Ζήτησα για αυτό: ${m.statement}`);
    if (chosen && chosen.id !== mine?.id) {
      const ev = d.evaluations.find((e) => e.personaId === p.id && e.optionId === chosen.id);
      for (const r of ev?.reasons.slice(0, 2) ?? []) f.push(`Για την τελική πρόταση — ${r.effect === 'for' ? 'υπέρ' : 'κατά'}: ${r.text}`);
    }
    const c = d.outcome.concessions.find((x) => x.personaId === p.id);
    for (const item of c?.items.slice(0, 3) ?? []) f.push(item.startsWith('Παραβιάζεται') ? `${item}. Δεν το δέχομαι μόνος μου, ρωτάω τον κάτοχο.` : `Παραχώρηση: ${item}`);
    for (const day of chosen?.itinerary?.days ?? []) for (const x of day.slots) if (x.serves.some((sv) => sv.personaId === p.id)) f.push(`Στο πρόγραμμα για μένα: ${day.title || day.date} ${x.start} — ${x.title}`);
    for (const w of chosen?.why?.filter((x) => x.personaId === p.id).slice(0, 2) ?? []) f.push(`Γιατί μου ταιριάζει: ${w.text}`);
    if (c) f.push(c.stance === 'agree' ? 'Συμφωνώ με την τελική πρόταση.' : c.stance === 'agree_with_concession' ? 'Τη δέχομαι με παραχώρηση.' : 'Δεν με βολεύει η τελική πρόταση, θέλω να το συζητήσουμε.');
    perPerson[p.id] = f;
  }
  return { shared, perPerson };
}

/** Demo / fallback chat built from the decision, no style imitation. */
export function templateChat(d: Decision, personas: Persona[]): ChatLine[] {
  const opt = (id: string | null) => d.options.find((o) => o.id === id);
  const chosen = opt(d.outcome.chosenOptionId);
  const lines: ChatLine[] = [];
  for (const p of personas) {
    const v = d.outcome.votes.find((x) => x.personaId === p.id);
    const mine = opt(v?.optionId ?? null);
    const why = v?.reasons.find((r) => r.effect === 'for');
    lines.push({ personaId: p.id, text: mine ? `Εγώ λέω ${mine.title}${why ? ` — ${why.text.replace(/\s*\(«.*»\)$/, '')}` : ''}` : 'Δεν μου κάθεται καμία επιλογή τελείως...' });
  }
  if (!chosen) return lines;
  if (d.outcome.status === 'compromise') {
    const r = d.outcome.results.find((x) => x.optionId === chosen.id);
    for (const p of personas) {
      const breach = r?.violations.find((v) => v.personaId === p.id);
      if (breach) lines.push({ personaId: p.id, text: `Με ${chosen.title} δεν βγαίνει για μένα: ${breach.text}. Πρέπει να το αποφασίσω εγώ αν αλλάζω κάτι.` });
    }
    const relax = d.outcome.relaxations[0];
    if (relax) lines.push({ personaId: personas[0].id, text: `Ιδέα: ${relax.text}` });
    return lines;
  }
  for (const p of personas) {
    const v = d.outcome.votes.find((x) => x.personaId === p.id);
    const c = d.outcome.concessions.find((x) => x.personaId === p.id);
    if (v?.optionId === chosen.id) continue;
    const must = c?.items.find((i) => i.startsWith('Πρέπει να δεχτεί'));
    lines.push({ personaId: p.id, text: must ? `Οκ, πάμε ${chosen.title}. ${must.replace('Πρέπει να δεχτεί: ', 'Δέχομαι ότι ')}` : c?.stance === 'object' ? `Για ${chosen.title} δεν είμαι σίγουρος, να το δούμε λίγο ακόμα` : `Οκ, πάω με ${chosen.title}` });
  }
  lines.push({ personaId: personas[0]?.id ?? '', text: `Κλείνουμε ${chosen.venue ? placeLine(chosen) : chosen.title}${chosen.costPerPerson !== null ? `, ~${chosen.costPerPerson}€ το άτομο` : ''};` });
  return lines.filter((l) => l.personaId);
}
