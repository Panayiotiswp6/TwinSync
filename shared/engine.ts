// TwinSync decision engine — deterministic, no LLM involved.
//
// Flow: individual twin positions -> mandatory constraints -> shared proposal.
// The group rules (lowest budget wins, accept >= 65 / concede 40–64 / object < 40,
// every participant must keep something) are adapted from agent_mesh's group
// negotiation prompt (MIT per its README, backend/features/trip.py @ 51bfb33);
// agent_mesh lets an LLM score proposals, here the same rules are enforced in code.

import { ACTIVITY_LABEL, DIMENSION_LABEL, PREF_META, describePref, formatValue, isActivityTag, toMinutes, type Dimension } from './prefs';
import type {
  Concession,
  Confidence,
  DecisionResult,
  OptionEval,
  Owner,
  OwnerId,
  Preference,
  Reason,
  Relaxation,
  Stance,
  TripOption,
  TwinPosition,
  Violation,
} from './types';

export const STANCE_THRESHOLDS = { agree: 65, concede: 40 } as const;
const NEUTRAL_SCORE = 50;
const TIE_MARGIN = 3;

// ---------- Hard constraints ----------

export function checkConstraint(p: Preference, o: TripOption): string | null {
  switch (p.key) {
    case 'budget_max':
      return o.pricePerPerson > Number(p.value) ? `κοστίζει ${o.pricePerPerson}€/άτομο, πάνω από το όριο ${p.value}€` : null;
    case 'return_by':
      return toMinutes(o.returnSunday) > toMinutes(String(p.value))
        ? `επιστροφή Κυριακή ${o.returnSunday}, μετά τις ${p.value}`
        : null;
    case 'no_camping':
      return p.value && o.stay.kind === 'tent' ? 'η διαμονή είναι σε σκηνή' : null;
    case 'requires_private_bath':
      return p.value && !o.stay.privateBath ? 'δεν έχει ιδιωτικό μπάνιο' : null;
    default:
      return null;
  }
}

// ---------- Soft preferences: satisfaction in [0, 1] ----------

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function stayComfort(o: TripOption): number {
  if (o.stay.kind === 'tent') return 0;
  if (o.stay.kind === 'refuge') return 0.2;
  return o.stay.privateBath ? 1 : 0.25;
}

export function satisfaction(p: Preference, o: TripOption): number | null {
  switch (p.key) {
    case 'likes_hiking': {
      const s = clamp01(o.hikeHours / 6);
      return p.value ? s : 1 - s;
    }
    case 'max_hike_hours': {
      const max = Number(p.value);
      return o.hikeHours <= max ? 1 : clamp01(1 - (o.hikeHours - max) / 3);
    }
    case 'prefers_low_cost':
      return clamp01(1 - (o.pricePerPerson - 60) / 120);
    case 'prefers_comfort':
      return stayComfort(o);
    case 'likes_sea':
      return p.value ? o.seaAccess : 1 - o.seaAccess;
    case 'likes_activity':
      return isActivityTag(p.value) ? o.tags?.[p.value] ?? 0 : null;
    case 'avoids_activity':
      return isActivityTag(p.value) ? 1 - (o.tags?.[p.value] ?? 0) : null;
    default:
      return null;
  }
}

function activityLevel(o: TripOption, tag: unknown): string {
  if (!isActivityTag(tag)) return '';
  const v = o.tags?.[tag] ?? 0;
  const amount = v >= 0.7 ? 'πολλή' : v >= 0.3 ? 'λίγη' : 'καθόλου';
  return `${ACTIVITY_LABEL[tag]}: ${amount}`;
}

function softPrefs(prefs: Preference[]) {
  return prefs.filter((p) => PREF_META[p.key].kind === 'preference');
}
function hardPrefs(prefs: Preference[]) {
  return prefs.filter((p) => PREF_META[p.key].kind === 'constraint');
}

export function scoreOption(prefs: Preference[], o: TripOption): number {
  let num = 0;
  let den = 0;
  for (const p of softPrefs(prefs)) {
    const s = satisfaction(p, o);
    if (s === null) continue;
    num += p.weight * s;
    den += p.weight;
  }
  // No data -> neutral score, reported as uncertainty (never a guess).
  return den === 0 ? NEUTRAL_SCORE : Math.round((100 * num) / den);
}

// ---------- Text for reasons ----------

function optionFact(key: Preference['key'], o: TripOption, value?: Preference['value']): string {
  switch (key) {
    case 'likes_hiking':
    case 'max_hike_hours':
      return o.hikeHours > 0 ? `${o.hikeHours} ώρες πεζοπορία` : 'χωρίς πεζοπορία';
    case 'prefers_low_cost':
      return `${o.pricePerPerson}€/άτομο`;
    case 'prefers_comfort':
      return o.stay.label;
    case 'likes_sea':
      return o.seaAccess >= 0.9 ? 'θάλασσα στο πρόγραμμα' : o.seaAccess > 0 ? 'σύντομη βουτιά' : 'χωρίς θάλασσα';
    case 'likes_activity':
    case 'avoids_activity':
      return activityLevel(o, value);
    default:
      return '';
  }
}

function reasonFor(p: Preference, o: TripOption): Reason | null {
  const s = satisfaction(p, o);
  if (s === null) return null;
  const effect = s >= 0.5 ? 'for' : 'against';
  return {
    prefId: p.id,
    key: p.key,
    effect,
    text: `${optionFact(p.key, o, p.value)} — ${effect === 'for' ? 'ταιριάζει με' : 'αντίθετο με'} «${describePref(p)}»`,
    sourceRefs: p.sourceRefs,
  };
}

// ---------- Positions ----------

function prefsByOwner(prefs: Preference[], ownerId: OwnerId) {
  return prefs.filter((p) => p.ownerId === ownerId);
}

function confidenceFor(prefs: Preference[]): Confidence {
  const soft = softPrefs(prefs);
  if (soft.length === 0) return 'low';
  const avg = soft.reduce((a, p) => a + p.confidence, 0) / soft.length;
  if (soft.length >= 2 && avg >= 0.8) return 'high';
  return soft.length >= 2 || avg >= 0.8 ? 'medium' : 'low';
}

function uncertaintiesFor(prefs: Preference[], options: TripOption[], ranking: TwinPosition['ranking']): string[] {
  const covered = new Set<Dimension>(prefs.map((p) => PREF_META[p.key].dimension));
  const varying: Record<Dimension, boolean> = {
    cost: new Set(options.map((o) => o.pricePerPerson)).size > 1,
    return: new Set(options.map((o) => o.returnSunday)).size > 1,
    stay: new Set(options.map((o) => stayComfort(o))).size > 1,
    hiking: new Set(options.map((o) => o.hikeHours)).size > 1,
    sea: new Set(options.map((o) => o.seaAccess)).size > 1,
    activities: new Set(options.map((o) => JSON.stringify(o.tags ?? {}))).size > 1,
  };
  const out: string[] = [];
  for (const dim of Object.keys(varying) as Dimension[]) {
    if (varying[dim] && !covered.has(dim)) {
      out.push(`Δεν υπάρχουν δεδομένα για ${DIMENSION_LABEL[dim]} — το Twin δεν υποθέτει προτίμηση.`);
    }
  }
  const ok = ranking.filter((r) => r.okForMe);
  if (ok.length >= 2 && ok[0].score - ok[1].score < TIE_MARGIN) {
    out.push('Οριακή διαφορά ανάμεσα στις δύο πρώτες επιλογές — χαμηλή βεβαιότητα για την ψήφο.');
  }
  if (softPrefs(prefs).length === 0) out.push('Καμία επιβεβαιωμένη προτίμηση — ουδέτερη βαθμολογία σε όλες τις επιλογές.');
  return out;
}

export function twinPosition(ownerId: OwnerId, allPrefs: Preference[], options: TripOption[]): TwinPosition {
  const prefs = prefsByOwner(allPrefs, ownerId);
  const ranking = options
    .map((o) => ({
      optionId: o.id,
      score: scoreOption(prefs, o),
      okForMe: hardPrefs(prefs).every((p) => checkConstraint(p, o) === null),
      price: o.pricePerPerson,
    }))
    .sort((a, b) => Number(b.okForMe) - Number(a.okForMe) || b.score - a.score || a.price - b.price)
    .map(({ optionId, score, okForMe }) => ({ optionId, score, okForMe }));

  const vote = ranking.find((r) => r.okForMe) ?? null;
  const voteOption = vote ? options.find((o) => o.id === vote.optionId)! : null;
  const reasons = voteOption
    ? softPrefs(prefs)
        .map((p) => ({ r: reasonFor(p, voteOption), w: p.weight }))
        .filter((x): x is { r: Reason; w: number } => x.r !== null)
        .sort((a, b) => b.w - a.w)
        .map((x) => x.r)
    : [];
  const constraints: Reason[] = hardPrefs(prefs).map((p) => {
    const excluded = options.filter((o) => checkConstraint(p, o) !== null).map((o) => o.name);
    return {
      prefId: p.id,
      key: p.key,
      effect: 'against',
      text: `${describePref(p)}${excluded.length ? ` — αποκλείει: ${excluded.join(', ')}` : ' — δεν αποκλείει καμία επιλογή'}`,
      sourceRefs: p.sourceRefs,
    };
  });

  return {
    ownerId,
    voteOptionId: vote?.optionId ?? null,
    ranking,
    reasons,
    constraints,
    uncertainties: uncertaintiesFor(prefs, options, ranking),
    confidence: confidenceFor(prefs),
  };
}

// ---------- Group decision ----------

export function stanceFor(score: number): Stance {
  if (score >= STANCE_THRESHOLDS.agree) return 'agree';
  if (score >= STANCE_THRESHOLDS.concede) return 'agree_with_concession';
  return 'object';
}

function concessionItems(prefs: Preference[], vote: TripOption, final: TripOption): string[] {
  if (vote.id === final.id) return [];
  const items: string[] = [];
  for (const p of softPrefs(prefs)) {
    const a = satisfaction(p, vote);
    const b = satisfaction(p, final);
    if (a === null || b === null || b >= a - 0.05) continue;
    switch (p.key) {
      case 'likes_hiking':
      case 'max_hike_hours':
        items.push(`Πεζοπορία ${final.hikeHours} ώρες αντί για ${vote.hikeHours}`);
        break;
      case 'prefers_low_cost':
        items.push(`+${final.pricePerPerson - vote.pricePerPerson}€/άτομο σε σχέση με τη δική του ψήφο`);
        break;
      case 'prefers_comfort':
        items.push(`${final.stay.label} αντί για «${vote.stay.label}»`);
        break;
      case 'likes_sea':
        items.push(`${optionFact('likes_sea', final)} αντί για ${optionFact('likes_sea', vote).toLowerCase()}`);
        break;
      case 'likes_activity':
      case 'avoids_activity':
        items.push(`${optionFact(p.key, final, p.value)} (αντί για ${optionFact(p.key, vote, p.value).split(': ')[1] ?? ''})`);
        break;
    }
  }
  return [...new Set(items)];
}

export function evaluateOptions(owners: Owner[], prefs: Preference[], options: TripOption[]): OptionEval[] {
  return options.map((o) => {
    const violations: Violation[] = [];
    for (const p of hardPrefs(prefs)) {
      const msg = checkConstraint(p, o);
      if (msg) violations.push({ ownerId: p.ownerId, prefId: p.id, key: p.key, scope: p.scope, message: msg, sourceRefs: p.sourceRefs });
    }
    const scores: Record<OwnerId, number> = {};
    for (const ow of owners) scores[ow.id] = scoreOption(prefsByOwner(prefs, ow.id), o);
    const vals = Object.values(scores);
    return {
      optionId: o.id,
      feasible: violations.length === 0,
      violations,
      scores,
      avg: Math.round(vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 1)),
      min: vals.length ? Math.min(...vals) : 0,
    };
  });
}

function relaxationsFor(owners: Owner[], evals: OptionEval[], options: TripOption[]): Relaxation[] {
  const name = (id: OwnerId) => owners.find((o) => o.id === id)?.name ?? id;
  const out: Relaxation[] = [];
  for (const ev of evals) {
    const prefIds = new Set(ev.violations.map((v) => v.prefId));
    if (prefIds.size !== 1) continue; // only single-constraint unlocks are suggested
    const v = ev.violations[0];
    const o = options.find((x) => x.id === ev.optionId)!;
    let change: string;
    if (v.key === 'budget_max') change = `ανέβαζε το όριο κόστους στα ${o.pricePerPerson}€`;
    else if (v.key === 'return_by') change = `δεχόταν επιστροφή στις ${o.returnSunday}`;
    else if (v.key === 'no_camping') change = 'δεχόταν σκηνή';
    else change = 'δεχόταν κοινόχρηστο μπάνιο';
    out.push({ ownerId: v.ownerId, prefId: v.prefId, key: v.key, optionId: o.id, message: `${name(v.ownerId)}: αν ${change} → «${o.name}» γίνεται εφικτό.` });
  }
  return out;
}

export function decide(owners: Owner[], prefs: Preference[], options: TripOption[]): DecisionResult {
  const active = prefs.filter((p) => owners.some((o) => o.id === p.ownerId));
  const evals = evaluateOptions(owners, active, options);
  const positions = owners.map((o) => twinPosition(o.id, active, options));
  const optName = (id: string) => options.find((o) => o.id === id)!.name;
  const ownerName = (id: OwnerId) => owners.find((o) => o.id === id)?.name ?? id;

  const rationale: string[] = [];
  for (const ev of evals.filter((e) => !e.feasible)) {
    const why = ev.violations.map((v) => `${ownerName(v.ownerId)}: ${v.message}`).join('· ');
    rationale.push(`«${optName(ev.optionId)}» αποκλείεται — ${why}.`);
  }

  const feasible = evals.filter((e) => e.feasible);
  if (feasible.length === 0) {
    rationale.push('Καμία επιλογή δεν ικανοποιεί όλους τους υποχρεωτικούς περιορισμούς.');
    return { status: 'deadlock', chosenOptionId: null, options: evals, positions, concessions: [], relaxations: relaxationsFor(owners, evals, options), rationale };
  }

  // Egalitarian choice: maximise the least-satisfied twin, then the average, then lower price.
  const price = (id: string) => options.find((o) => o.id === id)!.pricePerPerson;
  const ranked = [...feasible].sort((a, b) => b.min - a.min || b.avg - a.avg || price(a.optionId) - price(b.optionId));
  const chosen = ranked[0];
  const chosenOpt = options.find((o) => o.id === chosen.optionId)!;
  if (ranked.length > 1) {
    const second = ranked[1];
    const lowest = Object.entries(second.scores).sort((a, b) => a[1] - b[1])[0];
    rationale.push(
      `Επιλέγεται «${chosenOpt.name}»: ο λιγότερο ικανοποιημένος φτάνει ${chosen.min}/100. ` +
        `Με «${optName(second.optionId)}» ο λιγότερο ικανοποιημένος θα έπεφτε στο ${lowest[1]}/100 (${ownerName(lowest[0])}).`,
    );
  } else {
    rationale.push(`Επιλέγεται «${chosenOpt.name}», η μόνη επιλογή που περνά όλους τους περιορισμούς.`);
  }

  const concessions: Concession[] = positions.map((pos) => {
    const finalScore = chosen.scores[pos.ownerId];
    const voteOpt = pos.voteOptionId ? options.find((o) => o.id === pos.voteOptionId)! : null;
    const voteScore = pos.ranking.find((r) => r.optionId === pos.voteOptionId)?.score ?? finalScore;
    const items = voteOpt ? concessionItems(prefsByOwner(active, pos.ownerId), voteOpt, chosenOpt) : [];
    if (voteOpt && voteOpt.id !== chosenOpt.id) {
      const block = evals.find((e) => e.optionId === voteOpt.id)!;
      if (!block.feasible) {
        const others = block.violations.filter((v) => v.ownerId !== pos.ownerId).map((v) => `${ownerName(v.ownerId)}: ${v.message}`);
        if (others.length) items.unshift(`Η ψήφος του («${voteOpt.name}») αποκλείστηκε — ${others.join('· ')}`);
      }
    }
    return { ownerId: pos.ownerId, stance: stanceFor(finalScore), finalScore, voteScore, items };
  });
  const objecting = concessions.filter((c) => c.stance === 'object');
  if (objecting.length) {
    rationale.push(`Προσοχή: ${objecting.map((c) => ownerName(c.ownerId)).join(', ')} κάτω από ${STANCE_THRESHOLDS.concede}/100 — χρειάζεται ανθρώπινη συζήτηση.`);
  }

  return { status: 'agreement', chosenOptionId: chosen.optionId, options: evals, positions, concessions, relaxations: [], rationale };
}

export { formatValue };
