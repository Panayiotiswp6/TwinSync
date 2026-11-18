// Facts, templates and a grounding guard for each twin's group-chat draft.
// A model draft may only restate facts derived from the decision; anything else is rejected.

import { normalizeGreek } from './text';
import { formatWhen } from './time';
import type { CandidateOption, Decision, GroupRequest, Persona, PersonaId, Source } from './types';

/** Sources containing the persona's own words — the style reference. */
export function styleSamples(sources: Source[], personaId: PersonaId): Source[] {
  return sources.filter((s) => s.personaId === personaId && ['note', 'chat', 'email', 'past_decision', 'document'].includes(s.kind)).slice(-8);
}

export function messageFacts(d: Decision, req: GroupRequest, personaId: PersonaId, personas: Persona[]): string[] {
  const opt = (id: string | null) => d.options.find((o) => o.id === id);
  const name = (id: string) => personas.find((p) => p.id === id)?.name ?? id;
  const vote = d.outcome.votes.find((v) => v.personaId === personaId);
  const facts: string[] = [`Το αίτημα της παρέας: ${req.title}.`];
  const mine = opt(vote?.optionId ?? null);
  if (mine) facts.push(`Η δική μου πρώτη επιλογή ήταν: ${mine.title}.`);
  const chosen = opt(d.outcome.chosenOptionId);
  if (d.outcome.status === 'agreement' && chosen) {
    facts.push(`Κοινή πρόταση: ${chosen.title}${chosen.location ? `, ${chosen.location}` : ''}.`);
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

export function templateMessage(d: Decision, personaId: PersonaId): string {
  const chosen = d.options.find((o) => o.id === d.outcome.chosenOptionId);
  if (d.outcome.status !== 'agreement' || !chosen) {
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
