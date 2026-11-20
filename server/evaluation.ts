// Evaluation on SYNTHETIC data only.
//  1. Held-out decisions: a twin, using only its confirmed profile, predicts a past choice
//     it was never given as a source. Offline = demo heuristic; live = the AI evaluator.
//  2. Scenario checks of the group logic (agreement, budget change, compromise, vegetarian, no data).
//  3. Seed integrity: every memory quote is an exact span of its source.

import holdout from './data/holdout.json';
import { decide } from '../shared/decide';
import { evaluateWithRules } from '../shared/heuristics';
import { athensIso } from '../shared/time';
import { containsQuote } from '../shared/text';
import type { CandidateOption, Category, Evaluation, MemoryItem, Persona } from '../shared/types';
import { aiErrorReason, aiModel, evaluateOptions, liveAi } from './ai';
import { loadSeed, loadTripFixtures, type CatalogEntry } from './seed';
import { fixtureOption, venueCatalogue } from './pipeline';
import { prepareOptions, validateItinerary } from '../shared/plan';
import { spanDays } from '../shared/context';
import { store } from './store';

interface HoldoutCase {
  id: string;
  personaId: string;
  question: string;
  category: Category;
  actualOptionId: string;
  note: string;
  options: CandidateOption[];
}
const CASES = (holdout as { cases: HoldoutCase[] }).cases.map((c) => ({ ...c, origin: 'synthetic' as const }));

/** Synthetic demo cases + the owners' own imported cases (only for twins that exist). */
function allCases(personaIds: string[]): (HoldoutCase & { origin: 'synthetic' | 'imported' })[] {
  return [...CASES, ...store.holdouts].filter((c) => personaIds.includes(c.personaId));
}
const UNCERTAIN_MARGIN = 3;

export interface HoldoutRow {
  id: string;
  personaId: string;
  question: string;
  predicted: string | null;
  actual: string;
  outcome: 'correct' | 'wrong' | 'uncertain';
  margin: number;
  note: string;
  why: string;
  origin: 'synthetic' | 'imported';
}
export interface HoldoutReport {
  method: 'heuristic' | 'live';
  model: string | null;
  ranAt: string;
  rows: HoldoutRow[];
  correct: number;
  wrong: number;
  uncertain: number;
  total: number;
  error?: string;
}

function predict(c: HoldoutCase & { origin: 'synthetic' | 'imported' }, persona: Persona, items: MemoryItem[], evals: Evaluation[]): HoldoutRow {
  const out = decide([persona], items, c.options, evals, c.category);
  const ok = out.results.filter((r) => r.feasible).sort((a, b) => b.scores[persona.id] - a.scores[persona.id]);
  const margin = ok.length >= 2 ? ok[0].scores[persona.id] - ok[1].scores[persona.id] : ok.length ? 100 : 0;
  const predicted = ok[0]?.optionId ?? null;
  const outcome: HoldoutRow['outcome'] = !predicted || margin < UNCERTAIN_MARGIN ? 'uncertain' : predicted === c.actualOptionId ? 'correct' : 'wrong';
  const ev = evals.find((e) => e.optionId === predicted);
  const blocked = out.results.find((r) => !r.feasible)?.violations[0]?.text;
  return { id: c.id, personaId: c.personaId, question: c.question, predicted, actual: c.actualOptionId, outcome, margin, note: c.note, why: blocked ? `αποκλείστηκε το άλλο: ${blocked}` : ev?.reasons[0]?.text ?? '', origin: c.origin };
}

function summarize(method: HoldoutReport['method'], rows: HoldoutRow[], error?: string): HoldoutReport {
  return {
    method,
    model: method === 'live' ? aiModel() : null,
    ranAt: new Date().toISOString(),
    rows,
    correct: rows.filter((r) => r.outcome === 'correct').length,
    wrong: rows.filter((r) => r.outcome === 'wrong').length,
    uncertain: rows.filter((r) => r.outcome === 'uncertain').length,
    total: rows.length,
    error,
  };
}

export function holdoutHeuristic(profileOf: (id: string) => MemoryItem[], personas: Persona[]): HoldoutReport {
  return summarize(
    'heuristic',
    allCases(personas.map((p) => p.id)).map((c) => {
      const p = personas.find((x) => x.id === c.personaId)!;
      const items = profileOf(p.id);
      return predict(c, p, items, evaluateWithRules(p.id, items, c.options));
    }),
  );
}

export async function holdoutLive(): Promise<HoldoutReport> {
  if (!liveAi()) return summarize('live', [], 'Χρειάζεται κλειδί AI (OPENAI_API_KEY).');
  const rows: HoldoutRow[] = [];
  try {
    for (const c of allCases(store.personas.map((p) => p.id))) {
      const p = store.persona(c.personaId)!;
      const items = store.profile(p.id);
      const evals = await evaluateOptions(c.options, [{ persona: p, items }]);
      rows.push(predict(c, p, items, evals));
    }
  } catch (e) {
    return summarize('live', rows, aiErrorReason(e));
  }
  const report = summarize('live', rows);
  store.liveEval = report;
  return report;
}

// ---------------------------------------------------------------------------
// Scenario checks (deterministic: seed profiles + demo catalog + heuristic evaluator)
// ---------------------------------------------------------------------------

function instantiate(entries: CatalogEntry[], category: Category): CandidateOption[] {
  return entries
    .filter((c) => c.category === category)
    .slice(0, 5)
    .map((c) => {
      const at = (day: number, time: string) => {
        const [hh, mm] = time.split(':').map(Number);
        return athensIso(2026, 11, 21 + day, hh, mm);
      };
      return { ...c, startsAt: at(c.start.day, c.start.time), endsAt: at(c.end.day, c.end.time), origin: 'catalog' as const };
    });
}

function limit(personaId: string, value: number): MemoryItem {
  return {
    id: `test-limit-${personaId}-${value}`, personaId, kind: 'constraint', statement: `Όριο ${value}€`, domain: 'money', polarity: 'neutral', strength: 1, hard: true,
    rule: { metric: 'max_cost', value: String(value) }, categories: [], keywords: [], refs: [], confidence: 1, status: 'confirmed', origin: 'owner', scope: 'request', createdAt: '',
  };
}

export function runScenarios() {
  const seed = loadSeed();
  const personas = seed.personas;
  const base = seed.memory;
  const run = (items: MemoryItem[], category: Category, who = personas) => {
    const options = instantiate(seed.catalog, category);
    const evals = who.flatMap((p) => evaluateWithRules(p.id, items.filter((m) => m.personaId === p.id), options));
    return { options, out: decide(who, items, options, evals, category) };
  };
  const title = (r: ReturnType<typeof run>) => r.options.find((o) => o.id === r.out.chosenOptionId)?.title ?? 'αδιέξοδο';
  const results: { name: string; pass: boolean; detail: string }[] = [];

  const trip = run(base, 'trip');
  results.push({ name: 'Διήμερο: συμφωνία με τα αρχικά προφίλ', pass: trip.out.status === 'agreement', detail: title(trip) });
  const helmos = trip.out.results.find((r) => r.optionId === 'cat-helmos')!;
  results.push({
    name: 'Ο κώδικας αποκλείει επιστροφή μετά την Κυριακή 21:00 και τη σκηνή',
    pass: helmos.violations.some((v) => v.checkedBy === 'code' && v.personaId === 'geo') && helmos.violations.some((v) => v.personaId === 'pant'),
    detail: helmos.violations.map((v) => `${v.personaId}: ${v.text}`).join(' | '),
  });
  const bath: MemoryItem = { ...limit('pant', 0), id: 'test-bath', statement: 'Οπωσδήποτε ιδιωτικό μπάνιο (μόνο για αυτό)', domain: 'comfort', polarity: 'likes', rule: undefined, keywords: ['ιδιωτικό μπάνιο'] };
  const changed = run([...base, bath], 'trip');
  results.push({
    name: 'Προσωρινή επιθυμία Παντελή «οπωσδήποτε ιδιωτικό μπάνιο» αλλάζει μετρήσιμα την πρόταση',
    pass: changed.out.status === 'agreement' && changed.out.chosenOptionId !== trip.out.chosenOptionId,
    detail: `${title(trip)} → ${title(changed)}`,
  });
  const stuck = run([...base, limit('geo', 80)], 'trip');
  results.push({
    name: 'Όριο 80€: τίποτα δεν χωράει — η πιο κοντινή επιλογή μένει υποθετική, με την αλλαγή ορίου που θα την άνοιγε',
    pass: stuck.out.status === 'compromise' && !!stuck.out.chosenOptionId && stuck.out.relaxations.length > 0,
    detail: `${title(stuck)} · ${stuck.out.relaxations.map((r) => r.text).join(' | ')}`,
  });
  const food = run(base, 'food');
  const steak = food.out.results.find((r) => r.optionId === 'cat-steak')!;
  results.push({ name: 'Φαγητό: χορτοφάγος + όριο 25€ αποκλείουν το steakhouse', pass: !steak.feasible && food.out.status === 'agreement', detail: `${title(food)} · steakhouse: ${steak.violations.map((v) => v.text).join(' | ')}` });
  const empty = run(base.filter((m) => m.personaId !== 'pant'), 'food');
  const pantVote = empty.out.votes.find((v) => v.personaId === 'pant')!;
  results.push({ name: 'Χωρίς δεδομένα: ουδέτερη βαθμολογία και χαμηλή βεβαιότητα, όχι εικασία', pass: pantVote.confidence === 'low' && Object.values(empty.out.results[0].scores).includes(50), detail: `βεβαιότητα: ${pantVote.confidence}` });
  return results;
}

/** Proposal quality, offline: are local plans named places in the right area, trips full and consistent plans? */
export function planChecks() {
  const out: { name: string; pass: boolean; detail: string }[] = [];
  const cat = venueCatalogue();
  const coffee = { kind: 'coffee' as const, city: 'Αθήνα', area: 'Ζωγράφου ή Ιλίσια', periodStart: '2026-11-21T16:30:00+02:00', periodEnd: '2026-11-21T18:30:00+02:00', text: 'καφές' };
  const mk = (name: string, area: string): CandidateOption => ({ id: name, title: name, emoji: '', summary: '', location: '', costPerPerson: 6, costNote: '', startsAt: coffee.periodStart, endsAt: coffee.periodEnd, features: [], origin: 'ai', venue: { name, kind: 'καφέ', area, city: 'Αθήνα' } });
  const r = prepareOptions([mk('Κάπου στα Ιλίσια', 'Ιλίσια'), mk('Καφές κοντά στο Σύνταγμα', 'Σύνταγμα'), mk('LOT 51 (MicroLot)', 'Ιλίσια'), mk('O Kokkos', 'Παγκράτι')], { req: coffee, items: [], wishes: [], wishText: '', catalogue: cat });
  out.push({
    name: 'Καφές σε Ζωγράφου/Ιλίσια: περνά μόνο επώνυμο καφέ μέσα στην περιοχή',
    pass: r.valid.length === 1 && r.valid[0].venue?.name === 'LOT 51 (MicroLot)' && r.rejected.length === 3,
    detail: `δεκτό: ${r.valid.map((o) => o.title).join(', ')} · απορρίφθηκαν: ${r.rejected.map((x) => `${x.title} (${x.reason})`).join(' | ')}`,
  });
  const live = prepareOptions([{ ...mk('Half Note Jazz Club', 'Μετς'), title: 'Συναυλία του Χ στο Half Note' }], { req: { ...coffee, kind: 'live', area: '' }, items: [], wishes: [], wishText: '', catalogue: cat }).valid[0];
  out.push({ name: 'Live: χώρος χωρίς επιβεβαιωμένο πρόγραμμα δεν παρουσιάζεται ως εκδήλωση', pass: !!live && live.event?.status === 'unconfirmed' && !/συναυλ/i.test(live.title), detail: live?.title ?? '—' });
  const period = { periodStart: '2026-12-04T09:00:00+02:00', periodEnd: '2026-12-07T21:00:00+02:00', city: 'Αθήνα' };
  const trip = fixtureOption(loadTripFixtures()[0], period, loadSeed().memory);
  const errors = validateItinerary(trip?.itinerary, period.periodStart, period.periodEnd);
  out.push({ name: 'Τετραήμερο: 4 μέρες, χρονική σειρά, σύνολα κόστους, επιστροφή στην αφετηρία', pass: !!trip && trip.itinerary!.days.length === 4 && errors.length === 0, detail: errors.join(' · ') || `${trip?.title} · ${trip?.costPerPerson}€` });
  out.push({ name: 'Μία βραδινή έξοδος μετά τα μεσάνυχτα μετρά ως 1 μέρα (όχι διπλάσιο budget)', pass: spanDays('2026-12-12T21:00:00+02:00', '2026-12-13T02:30:00+02:00') === 1, detail: '21:00 → 02:30' });
  return out;
}

export function seedIntegrity() {
  const seed = loadSeed();
  let quotes = 0;
  for (const m of seed.memory) for (const r of m.refs) if (containsQuote(seed.sources.find((s) => s.id === r.sourceId)?.text ?? '', r.quote)) quotes++;
  return { personas: seed.personas.length, sources: seed.sources.length, memoryItems: seed.memory.length, verifiedQuotes: quotes };
}

export function evaluationReport() {
  return {
    dataset: 'synthetic' as const,
    heuristic: holdoutHeuristic((id) => store.profile(id), store.personas),
    live: (store.liveEval as HoldoutReport | undefined) ?? null,
    scenarios: runScenarios(),
    planChecks: planChecks(),
    integrity: seedIntegrity(),
    measures: [
      'Held-out: η ψήφος του Twin συγκρίνεται με την πραγματική (συνθετική) επιλογή του κατόχου, σε 8 αποφάσεις που δεν δόθηκαν ποτέ ως πηγή. Διαφορά βαθμολογίας < 3 μετρά ως «αβέβαιο», όχι ως σωστό.',
      'Live: το ίδιο με τον AI αξιολογητή (κοστίζει 8 μικρές κλήσεις, τρέχει μόνο όταν το ζητήσετε). Heuristic: ο κανόνας του demo mode, για σύγκριση.',
      'Σενάρια: ελέγχουν τη λογική της ομάδας — περιορισμοί σε κώδικα, αλλαγή μετά από διόρθωση, πρόταση που χρειάζεται αλλαγή ορίου όταν τίποτα δεν χωράει, απουσία δεδομένων.',
      'Ποιότητα προτάσεων: επώνυμο μαγαζί στη σωστή περιοχή, πλήρες πρόγραμμα ταξιδιού, τίμια αβεβαιότητα για live. Δεν αποδεικνύει ότι ένα μαγαζί είναι ανοιχτό ή έχει πρόγραμμα — αυτά εμφανίζονται πάντα «προς έλεγχο».',
      'Fidelity (held-out) ≠ λογική ≠ ποιότητα προτάσεων: τα 8 held-out είναι συνθετικά και λίγα· δείχνουν τον μηχανισμό, όχι ότι το Twin γνωρίζει πραγματικούς ανθρώπους.',
      'Όλα τα δεδομένα είναι συνθετικά και λίγα — δείχνουν ότι ο μηχανισμός λειτουργεί, όχι στατιστική ακρίβεια σε πραγματικούς ανθρώπους.',
    ],
  };
}
