// Deterministic group decision on top of the twins' evaluations.
// The model (or demo heuristic) scores options; THIS code:
//   - checks every numeric hard rule (cost per person, latest end) itself,
//   - accepts a qualitative hard-constraint breach only if it cites a real hard memory item,
//   - picks the shared option by max-min fairness (then average, then price),
//   - applies profile limits only in the context they were said in (shared/context.ts) and lets
//     request-only wishes override the profile,
//   - ALWAYS returns a proposal: if nothing passes every limit, the closest option is proposed
//     as a compromise, with what each person would have to accept.
// Stance thresholds and "budget ceiling = strictest limit" are adapted from agent_mesh's
// group negotiation rules (re-implemented, no code copied — see THIRD_PARTY_NOTICES.md).

import { bindingHard, costLimit, softReferences, type Fit, type RequestContext } from './context';
import { deadlineFor, describeDeadline, formatWhen, parseIso } from './time';
import type {
  CandidateOption,
  Category,
  Concession,
  Evaluation,
  MemoryItem,
  OptionResult,
  Outcome,
  Persona,
  PersonaId,
  Relaxation,
  Stance,
  TwinVote,
  Violation,
} from './types';

export const STANCE_THRESHOLDS = { agree: 65, concede: 40 } as const;
export const NEUTRAL = 50;

export function appliesTo(item: MemoryItem, category: Category): boolean {
  return item.categories.length === 0 || item.categories.includes(category);
}

export function activeHard(items: MemoryItem[], category: Category): MemoryItem[] {
  return items.filter((m) => m.hard && m.status === 'confirmed' && appliesTo(m, category));
}

/** Code check of a numeric rule. Returns a violation text, or null if satisfied / not checkable. */
export function checkRule(item: MemoryItem, o: CandidateOption, fit?: Fit): string | null {
  if (!item.rule) return null;
  if (item.rule.metric === 'max_cost') {
    const max = fit ? costLimit(item, fit) : Number(item.rule.value);
    if (o.costPerPerson === null || max === null || !Number.isFinite(max)) return null;
    return o.costPerPerson > max ? `κοστίζει ${o.costPerPerson}€/άτομο, πάνω από το όριο ${max}€${fit?.note ? ` (${fit.note})` : ''}` : null;
  }
  const end = parseIso(o.endsAt);
  if (!end) return null;
  const deadline = deadlineFor(item.rule.value, parseIso(o.startsAt));
  if (!deadline) return null;
  return end.getTime() > deadline.getTime() ? `τελειώνει ${formatWhen(o.endsAt)}, μετά το όριο (${describeDeadline(item.rule.value)})` : null;
}

function ruleUnknown(item: MemoryItem, o: CandidateOption): string | null {
  if (!item.rule) return null;
  if (item.rule.metric === 'max_cost' && o.costPerPerson === null) return 'άγνωστο κόστος';
  if (item.rule.metric === 'latest_end' && !parseIso(o.endsAt)) return 'άγνωστη ώρα λήξης';
  return null;
}

export function stanceFor(score: number): Stance {
  if (score >= STANCE_THRESHOLDS.agree) return 'agree';
  if (score >= STANCE_THRESHOLDS.concede) return 'agree_with_concession';
  return 'object';
}

export function decide(
  personas: Persona[],
  inputs: MemoryItem[],
  options: CandidateOption[],
  evaluations: Evaluation[],
  category: Category,
  ctx?: RequestContext | null,
): Outcome {
  const name = (id: PersonaId) => personas.find((p) => p.id === id)?.name ?? id;
  const optName = (id: string) => options.find((o) => o.id === id)?.title ?? id;
  const binding = bindingHard(inputs, category, ctx).filter((r) => personas.some((p) => p.id === r.item.personaId));
  const soft = softReferences(inputs, category, ctx).filter((r) => personas.some((p) => p.id === r.item.personaId));
  const evalOf = (pid: PersonaId, oid: string) => evaluations.find((e) => e.personaId === pid && e.optionId === oid);

  const results: OptionResult[] = options.map((o) => {
    const violations: Violation[] = [];
    const warnings: string[] = [];
    const unverified: string[] = [];
    for (const { item: m, fit } of binding) {
      if (m.rule) {
        const v = checkRule(m, o, fit);
        if (v) violations.push({ personaId: m.personaId, memoryId: m.id, text: v, checkedBy: 'code', scope: m.scope });
        const u = ruleUnknown(m, o);
        if (u) unverified.push(`${name(m.personaId)}: ${u} — η εφικτότητα για «${m.statement}» δεν επαληθεύτηκε`);
      } else {
        const judged = evalOf(m.personaId, o.id)?.violations.find((v) => v.memoryId === m.id);
        if (judged) violations.push({ personaId: m.personaId, memoryId: m.id, text: judged.text, checkedBy: 'judged', scope: m.scope });
      }
    }
    for (const { item: m, fit } of soft) {
      const v = checkRule(m, o, fit);
      if (v) warnings.push(`${name(m.personaId)}: ${v.replace('πάνω από το όριο', 'πάνω από το συνηθισμένο')} — ενδεικτικό, δεν αποκλείει`);
    }
    const scores: Record<PersonaId, number> = {};
    for (const p of personas) scores[p.id] = evalOf(p.id, o.id)?.score ?? NEUTRAL;
    const vals = Object.values(scores);
    return {
      optionId: o.id,
      feasible: violations.length === 0,
      violations,
      warnings: [...new Set(warnings)],
      unverified: [...new Set(unverified)],
      scores,
      min: vals.length ? Math.min(...vals) : 0,
      avg: Math.round(vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 1)),
    };
  });

  // A judged breach the evaluator reports for EVERY option is about the request (dates, the plan itself),
  // not about any option: it cannot help choose, so it is shown as a warning instead of excluding everything.
  if (options.length >= 3) {
    const judgedIds = new Set(results.flatMap((r) => r.violations.filter((v) => v.checkedBy === 'judged').map((v) => v.memoryId)));
    for (const id of judgedIds) {
      if (!results.every((r) => r.violations.some((v) => v.memoryId === id))) continue;
      for (const r of results) {
        const v = r.violations.find((x) => x.memoryId === id)!;
        r.violations = r.violations.filter((x) => x.memoryId !== id);
        r.warnings.push(`${name(v.personaId)}: ${v.text} (ισχύει για όλες τις επιλογές — θέμα του αιτήματος, όχι της επιλογής)`);
        r.feasible = r.violations.length === 0;
      }
    }
  }

  const price = (id: string) => options.find((o) => o.id === id)?.costPerPerson ?? Number.MAX_SAFE_INTEGER;

  // Each twin votes alone: best option that passes ITS OWN hard constraints.
  const votes: TwinVote[] = personas.map((p) => {
    const okForMe = results.filter((r) => !r.violations.some((v) => v.personaId === p.id));
    const ranked = [...okForMe].sort((a, b) => b.scores[p.id] - a.scores[p.id] || b.avg - a.avg || price(a.optionId) - price(b.optionId));
    const best = ranked[0];
    const ev = best ? evalOf(p.id, best.optionId) : undefined;
    const margin = ranked.length > 1 ? best.scores[p.id] - ranked[1].scores[p.id] : 100;
    const cited = new Set(evaluations.filter((e) => e.personaId === p.id).flatMap((e) => e.reasons.map((r) => r.memoryId)));
    const confidence: TwinVote['confidence'] = !ev || cited.size === 0 ? 'low' : margin < 5 || cited.size < 2 ? 'medium' : 'high';
    return {
      personaId: p.id,
      optionId: best?.optionId ?? null,
      score: best ? best.scores[p.id] : 0,
      verdict: ev?.verdict ?? '',
      reasons: ev?.reasons ?? [],
      unknowns: [...new Set(evaluations.filter((e) => e.personaId === p.id).flatMap((e) => e.unknowns))].slice(0, 4),
      confidence,
    };
  });

  const rationale: string[] = [];
  for (const r of results.filter((x) => !x.feasible)) {
    rationale.push(`«${optName(r.optionId)}» αποκλείεται — ${r.violations.map((v) => `${name(v.personaId)}: ${v.text}`).join(' · ')}.`);
  }

  const feasible = results.filter((r) => r.feasible);
  if (!options.length) {
    rationale.push('Δεν βρέθηκαν υποψήφιες επιλογές.');
    return { status: 'deadlock', chosenOptionId: null, results, votes, concessions: [], relaxations: [], rationale };
  }

  let status: Outcome['status'] = 'agreement';
  let noCommonTime = false;
  let chosen: OptionResult;
  if (feasible.length) {
    // Verified-feasible first: an unknown cost/end time against a strict limit is not "feasible for sure".
    const unv = (r: OptionResult) => (r.unverified?.length ? 1 : 0);
    const ranked = [...feasible].sort((a, b) => unv(a) - unv(b) || b.min - a.min || b.avg - a.avg || price(a.optionId) - price(b.optionId));
    chosen = ranked[0];
    if (chosen.unverified?.length) rationale.push(`Προσοχή: η εφικτότητα δεν επαληθεύτηκε — ${chosen.unverified.join(' · ')}.`);
    if (ranked.length > 1) {
      const second = ranked[1];
      const lowest = Object.entries(second.scores).sort((a, b) => a[1] - b[1])[0];
      rationale.push(
        `Επιλέγεται «${optName(chosen.optionId)}»: ο λιγότερο ικανοποιημένος φτάνει ${chosen.min}/100. Με «${optName(second.optionId)}» θα έπεφτε στο ${lowest[1]}/100 (${name(lowest[0])}).`,
      );
    } else {
      rationale.push(`Επιλέγεται «${optName(chosen.optionId)}», η μόνη επιλογή που περνά όλους τους περιορισμούς.`);
    }
  } else {
    // Never leave the group empty-handed: propose the option closest to everyone's limits.
    status = 'compromise';
    const sev = (r: OptionResult) => r.violations.reduce((a, v) => a + severity(v, options.find((o) => o.id === r.optionId)!, binding), 0);
    const people = (r: OptionResult) => new Set(r.violations.map((v) => v.personaId)).size;
    const ranked = [...results].sort((a, b) => people(a) - people(b) || a.violations.length - b.violations.length || sev(a) - sev(b) || b.min - a.min || b.avg - a.avg || price(a.optionId) - price(b.optionId));
    chosen = ranked[0];
    noCommonTime = timeWindowsDisjoint(results, options, binding);
    rationale.push(
      noCommonTime
        ? `Δεν υπάρχει κοινή ώρα: το όριο ώρας ${[...new Set(chosen.violations.map((v) => name(v.personaId)))].join(', ')} λήγει πριν ξεκινήσει οποιαδήποτε επιλογή. Η πιο κοντινή είναι υποθετική: «${optName(chosen.optionId)}».`
        : `Καμία επιλογή δεν περνά όλα τα αυστηρά όρια. Η πιο κοντινή σε όλους είναι υποθετική: «${optName(chosen.optionId)}» — θα χρειαζόταν αλλαγή από τον κάτοχο: ${chosen.violations.map((v) => `${name(v.personaId)} — ${v.text}`).join(' · ')}.`,
    );
  }
  const chosenOpt = options.find((o) => o.id === chosen.optionId)!;
  const concessions: Concession[] = votes.map((v) => {
    const finalScore = chosen.scores[v.personaId];
    const items: string[] = [];
    if (v.optionId && v.optionId !== chosen.optionId) {
      const voteOpt = options.find((o) => o.id === v.optionId)!;
      const blocked = results.find((r) => r.optionId === v.optionId)!;
      if (!blocked.feasible) {
        items.push(`Η ψήφος του («${voteOpt.title}») αποκλείστηκε — ${blocked.violations.map((x) => `${name(x.personaId)}: ${x.text}`).join(' · ')}`);
      } else {
        items.push(`Ψήφισε «${voteOpt.title}» (${v.score}/100), δέχεται «${chosenOpt.title}» (${finalScore}/100)`);
      }
      if (voteOpt.costPerPerson !== null && chosenOpt.costPerPerson !== null && chosenOpt.costPerPerson !== voteOpt.costPerPerson) {
        const d = chosenOpt.costPerPerson - voteOpt.costPerPerson;
        items.push(`${d > 0 ? '+' : ''}${d}€/άτομο σε σχέση με τη δική του ψήφο`);
      }
      const against = evalOf(v.personaId, chosen.optionId)?.reasons.filter((r) => r.effect === 'against') ?? [];
      for (const r of against.slice(0, 2)) items.push(r.text);
    }
    // A strict limit is never "accepted" by a twin: only its owner can change it.
    const breaches = chosen.violations.filter((x) => x.personaId === v.personaId);
    for (const x of breaches) items.unshift(`Παραβιάζεται αυστηρό όριο: ${x.text} — μόνο ο κάτοχος μπορεί να το αλλάξει`);
    const stance: Stance = breaches.length ? 'object' : stanceFor(finalScore);
    return { personaId: v.personaId, stance, finalScore, voteScore: v.score, items };
  });
  const objecting = concessions.filter((c) => c.stance === 'object');
  if (objecting.length) rationale.push(`Προσοχή: ${objecting.map((c) => name(c.personaId)).join(', ')} κάτω από ${STANCE_THRESHOLDS.concede}/100 — χρειάζεται ανθρώπινη συζήτηση.`);

  const relaxations = status === 'compromise' ? relaxationsFor(results, options, inputs, name) : [];
  return { status, chosenOptionId: chosen.optionId, results, votes, concessions, relaxations, rationale, ...(noCommonTime ? { noCommonTime } : {}) };
}

/** Every option breaks a time limit that ends before the option even starts: the windows do not intersect. */
function timeWindowsDisjoint(results: OptionResult[], options: CandidateOption[], binding: { item: MemoryItem; fit: Fit }[]): boolean {
  const timeRules = binding.filter((b) => b.item.rule?.metric === 'latest_end');
  if (!timeRules.length) return false;
  return results.every((r) => {
    const o = options.find((x) => x.id === r.optionId)!;
    const start = parseIso(o.startsAt);
    return r.violations.some((v) => {
      const b = timeRules.find((t) => t.item.id === v.memoryId);
      const deadline = b ? deadlineFor(b.item.rule!.value, start) : null;
      return !!(deadline && start && deadline.getTime() <= start.getTime());
    });
  });
}

/** How far an option is from a limit: cost overshoot ratio, hours late / 24, judged = 1. */
function severity(v: Violation, o: CandidateOption, binding: { item: MemoryItem; fit: Fit }[]): number {
  const b = binding.find((r) => r.item.id === v.memoryId);
  if (!b?.item.rule) return 1;
  if (b.item.rule.metric === 'max_cost') {
    const max = costLimit(b.item, b.fit);
    return max && o.costPerPerson !== null ? Math.max(0, (o.costPerPerson - max) / max) : 1;
  }
  const end = parseIso(o.endsAt);
  const deadline = deadlineFor(b.item.rule.value, parseIso(o.startsAt));
  return end && deadline ? Math.max(0, (end.getTime() - deadline.getTime()) / 86400000) : 1;
}

function relaxationsFor(results: OptionResult[], options: CandidateOption[], inputs: MemoryItem[], name: (id: string) => string): Relaxation[] {
  const out: Relaxation[] = [];
  for (const r of results) {
    const ids = new Set(r.violations.map((v) => v.memoryId));
    if (ids.size !== 1) continue; // only single-constraint unlocks
    const v = r.violations[0];
    const o = options.find((x) => x.id === r.optionId)!;
    const m = inputs.find((x) => x.id === v.memoryId);
    let change: string;
    if (m?.rule?.metric === 'max_cost' && o.costPerPerson !== null) change = `ανέβαζε το όριο κόστους στα ${o.costPerPerson}€`;
    else if (m?.rule?.metric === 'latest_end') change = `δεχόταν λήξη ${formatWhen(o.endsAt)}`;
    else change = `χαλάρωνε το «${m?.statement ?? v.text}»`;
    out.push({ personaId: v.personaId, memoryId: v.memoryId, optionId: o.id, text: `${name(v.personaId)}: αν ${change} → «${o.title}» γίνεται εφικτό.` });
  }
  const cost = (t: Relaxation) => options.find((o) => o.id === t.optionId)?.costPerPerson ?? 0;
  return out.sort((a, b) => cost(a) - cost(b)).slice(0, 4);
}
