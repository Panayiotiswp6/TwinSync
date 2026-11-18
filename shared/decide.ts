// Deterministic group decision on top of the twins' evaluations.
// The model (or demo heuristic) scores options; THIS code:
//   - checks every numeric hard rule (cost per person, latest end) itself,
//   - accepts a qualitative hard-constraint breach only if it cites a real hard memory item,
//   - picks the shared option by max-min fairness (then average, then price),
//   - derives concessions, stances and minimal relaxations for a deadlock.
// Stance thresholds and "budget ceiling = strictest limit" are adapted from agent_mesh's
// group negotiation rules (re-implemented, no code copied — see THIRD_PARTY_NOTICES.md).

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
export function checkRule(item: MemoryItem, o: CandidateOption): string | null {
  if (!item.rule) return null;
  if (item.rule.metric === 'max_cost') {
    const max = Number(item.rule.value);
    if (o.costPerPerson === null || !Number.isFinite(max)) return null;
    return o.costPerPerson > max ? `κοστίζει ${o.costPerPerson}€/άτομο, πάνω από το όριο ${max}€` : null;
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
): Outcome {
  const name = (id: PersonaId) => personas.find((p) => p.id === id)?.name ?? id;
  const optName = (id: string) => options.find((o) => o.id === id)?.title ?? id;
  const hard = activeHard(inputs, category).filter((m) => personas.some((p) => p.id === m.personaId));
  const evalOf = (pid: PersonaId, oid: string) => evaluations.find((e) => e.personaId === pid && e.optionId === oid);

  const results: OptionResult[] = options.map((o) => {
    const violations: Violation[] = [];
    const warnings: string[] = [];
    for (const m of hard) {
      if (m.rule) {
        const v = checkRule(m, o);
        if (v) violations.push({ personaId: m.personaId, memoryId: m.id, text: v, checkedBy: 'code', scope: m.scope });
        const u = ruleUnknown(m, o);
        if (u) warnings.push(`${name(m.personaId)}: ${u} — δεν μπορεί να ελεγχθεί το «${m.statement}»`);
      } else {
        const judged = evalOf(m.personaId, o.id)?.violations.find((v) => v.memoryId === m.id);
        if (judged) violations.push({ personaId: m.personaId, memoryId: m.id, text: judged.text, checkedBy: 'judged', scope: m.scope });
      }
    }
    const scores: Record<PersonaId, number> = {};
    for (const p of personas) scores[p.id] = evalOf(p.id, o.id)?.score ?? NEUTRAL;
    const vals = Object.values(scores);
    return {
      optionId: o.id,
      feasible: violations.length === 0,
      violations,
      warnings: [...new Set(warnings)],
      scores,
      min: vals.length ? Math.min(...vals) : 0,
      avg: Math.round(vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 1)),
    };
  });

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
  if (!feasible.length) {
    rationale.push('Καμία επιλογή δεν περνά όλους τους υποχρεωτικούς περιορισμούς.');
    return { status: 'deadlock', chosenOptionId: null, results, votes, concessions: [], relaxations: relaxationsFor(results, options, inputs, name), rationale };
  }

  const ranked = [...feasible].sort((a, b) => b.min - a.min || b.avg - a.avg || price(a.optionId) - price(b.optionId));
  const chosen = ranked[0];
  if (ranked.length > 1) {
    const second = ranked[1];
    const lowest = Object.entries(second.scores).sort((a, b) => a[1] - b[1])[0];
    rationale.push(
      `Επιλέγεται «${optName(chosen.optionId)}»: ο λιγότερο ικανοποιημένος φτάνει ${chosen.min}/100. Με «${optName(second.optionId)}» θα έπεφτε στο ${lowest[1]}/100 (${name(lowest[0])}).`,
    );
  } else {
    rationale.push(`Επιλέγεται «${optName(chosen.optionId)}», η μόνη επιλογή που περνά όλους τους περιορισμούς.`);
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
    return { personaId: v.personaId, stance: stanceFor(finalScore), finalScore, voteScore: v.score, items };
  });
  const objecting = concessions.filter((c) => c.stance === 'object');
  if (objecting.length) rationale.push(`Προσοχή: ${objecting.map((c) => name(c.personaId)).join(', ')} κάτω από ${STANCE_THRESHOLDS.concede}/100 — χρειάζεται ανθρώπινη συζήτηση.`);

  return { status: 'agreement', chosenOptionId: chosen.optionId, results, votes, concessions, relaxations: [], rationale };
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
