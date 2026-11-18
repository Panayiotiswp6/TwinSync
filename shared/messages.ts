// Facts, templates and a grounding guard for the twins' group-chat drafts.
// The model may only restate facts derived from the decision; anything else is rejected.

import { normalizeGreek } from './extractRules';
import type { Decision, Owner, OwnerId, Source, TripOption } from './types';

/** Sources that contain the owner's own words — the style reference for their twin. */
export function styleSamples(sources: Source[], ownerId: OwnerId): Source[] {
  return sources.filter((s) => s.ownerId === ownerId && ['note', 'chat', 'past_decision', 'owner_input'].includes(s.kind));
}

export function messageFacts(d: Decision, ownerId: OwnerId, trips: TripOption[], owners: Owner[]): string[] {
  const trip = (id: string | null) => trips.find((t) => t.id === id);
  const name = (id: string) => owners.find((o) => o.id === id)?.name ?? id;
  const pos = d.result.positions.find((p) => p.ownerId === ownerId);
  const facts: string[] = [`Το Σαββατοκύριακο: ${d.request.weekendLabel}.`];
  const vote = trip(pos?.voteOptionId ?? null);
  if (vote) facts.push(`Η δική μου πρώτη επιλογή ήταν: ${vote.name}.`);
  const chosen = trip(d.result.chosenOptionId);
  if (d.result.status === 'agreement' && chosen) {
    facts.push(`Κοινή πρόταση των Twins: ${chosen.name}, ${chosen.pricePerPerson}€ το άτομο, επιστροφή Κυριακή ${chosen.returnSunday}.`);
    facts.push(`Δραστηριότητες: ${chosen.activities.join('· ')}. Διαμονή: ${chosen.stay.label}.`);
    const c = d.result.concessions.find((x) => x.ownerId === ownerId);
    if (c) {
      facts.push(
        c.stance === 'agree' ? 'Συμφωνώ με την πρόταση.' : c.stance === 'agree_with_concession' ? 'Συμφωνώ, με κάποια παραχώρηση.' : 'Δεν με βολεύει η πρόταση.',
      );
      for (const item of c.items) facts.push(`Παραχώρηση: ${item}.`);
    }
    const why = pos?.reasons.find((r) => r.effect === 'for');
    if (why && vote?.id === chosen.id) facts.push(`Γιατί μου ταιριάζει: ${why.text}.`);
    facts.push('Η πρόταση περιμένει έγκριση από όλους πριν κλείσει οτιδήποτε.');
  } else {
    facts.push('Δεν βρέθηκε επιλογή που να περνά όλους τους υποχρεωτικούς περιορισμούς.');
    for (const r of d.result.relaxations) {
      facts.push(r.ownerId === ownerId ? `Θα ξεμπλόκαρε αν εγώ: ${r.message.replace(`${name(r.ownerId)}: `, '')}` : `Θα ξεμπλόκαρε αν ${r.message}`);
    }
    const mine = d.result.options.flatMap((o) => o.violations.filter((v) => v.ownerId === ownerId).map((v) => `${trip(o.optionId)?.name}: ${v.message}`));
    for (const m of mine.slice(0, 3)) facts.push(`Δικός μου περιορισμός που αποκλείει: ${m}.`);
  }
  return facts;
}

/** Demo-mode draft (no style imitation — labelled as template in the UI). */
export function templateMessage(d: Decision, ownerId: OwnerId, trips: TripOption[]): string {
  const chosen = trips.find((t) => t.id === d.result.chosenOptionId);
  if (d.result.status !== 'agreement' || !chosen) {
    const mine = d.result.relaxations.find((r) => r.ownerId === ownerId);
    return mine
      ? `Δεν βγαίνει κάτι αυτό το ΣΚ με τα τωρινά όρια. Από τη μεριά μου θα βοηθούσε: ${mine.message.split(': ').slice(1).join(': ')}`
      : 'Δεν βγαίνει κάτι αυτό το ΣΚ με τα τωρινά όρια όλων. Να το ξαναδούμε;';
  }
  const c = d.result.concessions.find((x) => x.ownerId === ownerId);
  if (!c || c.stance === 'agree') return `Μέσα για ${chosen.name}! ${chosen.pricePerPerson}€ το άτομο, επιστροφή Κυριακή ${chosen.returnSunday}.`;
  if (c.stance === 'agree_with_concession') return `Οκ για ${chosen.name}. ${c.items[c.items.length - 1] ?? ''}, αλλά ας είναι.`.replace(/\s+/g, ' ');
  return `Για ${chosen.name} δεν είμαι σίγουρος, να το συζητήσουμε πριν κλείσουμε.`;
}

/**
 * Grounding guard: every number in the draft must appear in the facts, and the
 * draft must not name a trip option that is not in the facts.
 * Returns a reason string if the draft should be rejected.
 */
export function ungroundedReason(text: string, facts: string[], trips: TripOption[]): string | null {
  const factText = normalizeGreek(facts.join(' '));
  const numbers = text.match(/\d+(?:[.:,]\d+)?/g) ?? [];
  for (const n of numbers) {
    const variants = [n, n.replace('.', ':'), n.replace(':', '.')];
    if (!variants.some((v) => factText.includes(v))) return `ανέφερε «${n}», που δεν υπάρχει στα δεδομένα της απόφασης`;
  }
  const normText = normalizeGreek(text);
  for (const t of trips) {
    const head = normalizeGreek(t.name.split(/[–&-]/)[0].trim());
    if (head.length >= 5 && normText.includes(head) && !factText.includes(head)) return `ανέφερε «${t.name}», που δεν είναι στα δεδομένα του`;
  }
  if (text.length > 300) return 'πολύ μεγάλο μήνυμα';
  return null;
}
