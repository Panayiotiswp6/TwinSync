// Evaluation on SYNTHETIC data only.
// 1) Held-out decisions: does a twin, using only its confirmed profile, pick the
//    option its owner actually chose in a past decision it never saw?
// 2) Scenario checks for the group flow: agreement, deadlock, correction changes result.
// 3) Extraction recall: does the demo-mode rule extractor recover the team-labelled
//    profile keys from the seed sources?

import holdout from './data/holdout.json';
import seed from './data/seed.json';
import { decide, twinPosition } from '../shared/engine';
import { extractWithRules } from '../shared/extractRules';
import type { Owner, Preference, PrefKey, TripOption } from '../shared/types';

export interface HoldoutRow {
  id: string;
  ownerId: string;
  question: string;
  predicted: string | null;
  actual: string;
  outcome: 'correct' | 'wrong' | 'uncertain';
  note: string;
  margin: number;
}

export interface EvalReport {
  dataset: 'synthetic';
  holdout: { rows: HoldoutRow[]; correct: number; wrong: number; uncertain: number; total: number };
  scenarios: { name: string; pass: boolean; detail: string }[];
  extraction: { ownerId: string; expected: PrefKey[]; found: PrefKey[]; recall: number }[];
  measures: string[];
}

const UNCERTAIN_MARGIN = 3;

function seedProfile(): Preference[] {
  return seed.preferences.map((p) => ({
    ...(p as unknown as Preference),
    status: 'confirmed',
    scope: 'profile',
    origin: 'seed',
    createdAt: '',
  }));
}

export function runHoldout(profile: Preference[]): EvalReport['holdout'] {
  const rows: HoldoutRow[] = holdout.cases.map((c) => {
    const options = c.options as TripOption[];
    const pos = twinPosition(c.ownerId, profile, options);
    const ok = pos.ranking.filter((r) => r.okForMe);
    const margin = ok.length >= 2 ? ok[0].score - ok[1].score : 100;
    const predicted = pos.voteOptionId;
    const outcome: HoldoutRow['outcome'] =
      predicted === null || margin < UNCERTAIN_MARGIN ? 'uncertain' : predicted === c.actualOptionId ? 'correct' : 'wrong';
    return { id: c.id, ownerId: c.ownerId, question: c.question, predicted, actual: c.actualOptionId, outcome, note: c.note, margin };
  });
  return {
    rows,
    correct: rows.filter((r) => r.outcome === 'correct').length,
    wrong: rows.filter((r) => r.outcome === 'wrong').length,
    uncertain: rows.filter((r) => r.outcome === 'uncertain').length,
    total: rows.length,
  };
}

function override(base: Preference[], ownerId: string, key: PrefKey, value: Preference['value']): Preference[] {
  const extra: Preference = {
    id: `test-${ownerId}-${key}`, ownerId, key, value, weight: 1, status: 'confirmed', scope: 'trip',
    confidence: 1, origin: 'owner', sourceRefs: [], createdAt: '',
  };
  return [...base.filter((p) => !(p.ownerId === ownerId && p.key === key)), extra];
}

export function runScenarios(): EvalReport['scenarios'] {
  const owners = seed.owners as Owner[];
  const trips = seed.trips as TripOption[];
  const base = seedProfile();
  const out: EvalReport['scenarios'] = [];

  const d1 = decide(owners, base, trips);
  out.push({ name: 'Συμφωνία με τα αρχικά προφίλ', pass: d1.status === 'agreement' && d1.chosenOptionId === 'trip-dirfys', detail: `αποτέλεσμα: ${d1.chosenOptionId ?? 'αδιέξοδο'}` });

  const d2 = decide(owners, override(base, 'geo', 'budget_max', 110), trips);
  out.push({
    name: 'Διόρθωση: Γιώργος όριο 110€ (μόνο για αυτό το διήμερο) αλλάζει την πρόταση',
    pass: d2.chosenOptionId === 'trip-geraneia' && d2.chosenOptionId !== d1.chosenOptionId,
    detail: `${d1.chosenOptionId} → ${d2.chosenOptionId} (−30€/άτομο)`,
  });

  const d3 = decide(owners, override(base, 'geo', 'budget_max', 90), trips);
  out.push({
    name: 'Αδιέξοδο: όριο 90€ — καμία εφικτή επιλογή, με εξήγηση',
    pass: d3.status === 'deadlock' && d3.options.every((o) => o.violations.length > 0) && d3.relaxations.length > 0,
    detail: `${d3.relaxations.length} προτάσεις χαλάρωσης`,
  });

  const d4 = decide(owners, override(override(base, 'geo', 'budget_max', 110), 'pant', 'requires_private_bath', true), trips);
  out.push({
    name: 'Αδιέξοδο από σύγκρουση δύο κατόχων (110€ + ιδιωτικό μπάνιο)',
    pass: d4.status === 'deadlock' && new Set(d4.relaxations.map((r) => r.ownerId)).size === 2,
    detail: d4.relaxations.map((r) => r.message).join(' | '),
  });

  const noData = decide(owners, base.filter((p) => p.ownerId !== 'pant'), trips);
  const pantPos = noData.positions.find((p) => p.ownerId === 'pant')!;
  out.push({
    name: 'Απουσία δεδομένων = αβεβαιότητα, όχι εικασία',
    pass: pantPos.confidence === 'low' && pantPos.uncertainties.length > 0 && Object.values(noData.options[0].scores).includes(50),
    detail: pantPos.uncertainties[0] ?? '',
  });
  return out;
}

export function runExtraction(): EvalReport['extraction'] {
  return (seed.owners as Owner[]).map((o) => {
    const expected = [...new Set(seed.preferences.filter((p) => p.ownerId === o.id).map((p) => p.key as PrefKey))];
    const text = seed.sources.filter((s) => s.ownerId === o.id).map((s) => s.text).join('\n');
    const found = [...new Set(extractWithRules(text).map((c) => c.key))];
    const hit = expected.filter((k) => found.includes(k)).length;
    return { ownerId: o.id, expected, found, recall: Math.round((100 * hit) / expected.length) / 100 };
  });
}

export function runEvaluation(profile: Preference[] = seedProfile()): EvalReport {
  return {
    dataset: 'synthetic',
    holdout: runHoldout(profile),
    scenarios: runScenarios(),
    extraction: runExtraction(),
    measures: [
      'Held-out: top-1 συμφωνία της ψήφου του Twin με την πραγματική (συνθετική) επιλογή του κατόχου, σε αποφάσεις που δεν δόθηκαν ποτέ ως πηγή. Διαφορά βαθμολογίας < 3 μετρά ως «αβέβαιο», όχι ως σωστό.',
      'Σενάρια: ελέγχουν ότι η ροή της παρέας δίνει συμφωνία, αδιέξοδο με εξήγηση και μετρήσιμη αλλαγή μετά από διόρθωση.',
      'Εξαγωγή: recall των κλειδιών προφίλ που βρίσκει ο εξαγωγέας κανόνων (demo mode) στις συνθετικές πηγές. Δεν μετρά τον live AI εξαγωγέα.',
      'Όλα τα δεδομένα είναι συνθετικά και λίγα (8 held-out αποφάσεις) — δείχνουν ότι ο μηχανισμός λειτουργεί, όχι στατιστική ακρίβεια.',
    ],
  };
}
