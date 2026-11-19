// The TwinSync pipeline: request -> retrieve memory -> options -> twin evaluations -> group decision.
// Live AI does the reasoning (understanding, options, per-twin judgement, style);
// code does the guarantees (quotes, ids, numeric limits, fairness, approvals).

import { decide } from '../shared/decide';
import { evaluateWithRules, extractWithRules, parseRequestWithRules, type MemoryDraft } from '../shared/heuristics';
import { messageFacts, styleSamples, templateMessage, ungroundedReason } from '../shared/messages';
import { athensIso, localParts, parseIso } from '../shared/time';
import type { CandidateOption, Category, Decision, Evaluation, MemoryItem, PersonaId, PipelineStep, StyleCard, TwinMessage } from '../shared/types';
import { aiErrorReason, aiModel, analyzeSource, buildStyle, draftMessages, evaluateOptions, generateOptions, liveAi, parseRequest, type TwinContext } from './ai';
import { retrieve } from './retrieval';
import { store } from './store';

const timer = () => {
  const t = Date.now();
  return () => Date.now() - t;
};

// ---------------------------------------------------------------------------
// Sources -> memory
// ---------------------------------------------------------------------------

export async function analyzeAndStore(sourceId: string) {
  const source = store.source(sourceId);
  if (!source || source.personaId === 'group') throw new Error('not found');
  const persona = store.persona(source.personaId)!;
  let drafts: MemoryDraft[] = [];
  let mode: 'live' | 'demo' | 'demo-fallback' = 'demo';
  let note: string | undefined;
  let truncated = false;
  if (liveAi()) {
    try {
      const r = await analyzeSource(persona, source.title, source.text);
      drafts = r.drafts;
      truncated = r.truncated;
      mode = 'live';
    } catch (e) {
      drafts = extractWithRules(source.text);
      mode = 'demo-fallback';
      note = `Live AI απέτυχε (${aiErrorReason(e)}) — χρησιμοποιήθηκαν κανόνες.`;
    }
  } else {
    drafts = extractWithRules(source.text);
  }
  if (truncated) note = `Μεγάλο αρχείο: αναλύθηκαν τα πρώτα τμήματα (όριο κόστους). ${note ?? ''}`.trim();
  const { created, dropped } = store.addMemory(persona.id, source, drafts, { origin: mode === 'live' ? 'ai' : 'rules', status: 'candidate', scope: 'profile' });
  source.analyzed = true;
  store.save();
  return { source, created, dropped, mode, note, model: mode === 'live' ? aiModel() : null };
}

/** Writing-style card from the persona's own texts (live AI), or simple measurements (demo). */
export async function refreshStyle(personaId: PersonaId): Promise<{ style: StyleCard; mode: 'live' | 'demo' }> {
  const persona = store.persona(personaId);
  if (!persona) throw new Error('not found');
  const samples = styleSamples(store.sources, personaId).map((s) => ({ id: s.id, text: s.text }));
  if (!samples.length) throw new Error('Δεν υπάρχουν κείμενα του κατόχου για ανάλυση ύφους.');
  if (liveAi()) {
    const style = await buildStyle(persona, samples);
    store.setStyle(personaId, style);
    return { style, mode: 'live' };
  }
  const all = samples.map((s) => s.text).join(' ');
  const avg = Math.round(samples.reduce((a, s) => a + s.text.split(/\s+/).length, 0) / samples.length);
  const emoji = /\p{Extended_Pictographic}/u.test(all);
  const accents = /[άέήίόύώ]/.test(all);
  const style: StyleCard = {
    summary: `Μετρήσεις demo: κατά μέσο όρο ${avg} λέξεις ανά κείμενο${emoji ? ', με emoji' : ''}${accents ? '' : ', χωρίς τόνους'}.`,
    traits: [avg < 15 ? 'σύντομα μηνύματα' : 'μεγαλύτερα κείμενα', emoji ? 'χρησιμοποιεί emoji' : 'χωρίς emoji', accents ? 'γράφει με τόνους' : 'χωρίς τόνους'],
    phrases: [],
    usesEmoji: emoji,
  };
  store.setStyle(personaId, style);
  return { style, mode: 'demo' };
}

// ---------------------------------------------------------------------------
// Request + one-off wishes
// ---------------------------------------------------------------------------

export async function createRequest(text: string, participants: PersonaId[], wishes: Record<PersonaId, string>) {
  const now = new Date();
  const wishList = participants.filter((id) => wishes[id]?.trim()).map((id) => ({ personaId: id, name: store.persona(id)!.name, text: wishes[id].trim() }));
  let parsed: { title: string; category: Category; periodStart: string | null; periodEnd: string | null; groupDrafts: MemoryDraft[]; wishDrafts: Record<string, MemoryDraft[]> };
  let mode: 'ai' | 'demo' = 'demo';
  let note: string | undefined;
  const t = timer();
  if (liveAi()) {
    try {
      parsed = await parseRequest(text, now, wishList);
      mode = 'ai';
    } catch (e) {
      note = `Live AI απέτυχε (${aiErrorReason(e)}) — χρησιμοποιήθηκαν κανόνες.`;
      parsed = rulesParse(text, now, wishList);
    }
  } else {
    parsed = rulesParse(text, now, wishList);
  }
  const req = store.addRequest({ text, title: parsed.title, category: parsed.category, periodStart: parsed.periodStart, periodEnd: parsed.periodEnd, participants });
  const reqSource = store.addSource('group', 'request', `Αίτημα: ${parsed.title}`, text);
  reqSource.analyzed = true;
  for (const pid of participants) {
    if (parsed.groupDrafts.length) store.addMemory(pid, reqSource, parsed.groupDrafts, { origin: mode === 'ai' ? 'ai' : 'rules', status: 'confirmed', scope: 'request', requestId: req.id });
  }
  for (const w of wishList) {
    const src = store.addSource(w.personaId, 'wish', `Επιθυμία για «${parsed.title}»`, w.text);
    src.analyzed = true;
    store.addMemory(w.personaId, src, parsed.wishDrafts[w.personaId] ?? [], { origin: mode === 'ai' ? 'ai' : 'rules', status: 'confirmed', scope: 'request', requestId: req.id });
  }
  const parseStep: PipelineStep = { key: 'parse', label: 'Κατανόηση αιτήματος & επιθυμιών', detail: `${labelCategory(parsed.category)} · ${wishList.length} προσωρινές επιθυμίες${note ? ` · ${note}` : ''}`, mode, ms: t() };
  const decision = await runDecision(req.id, { parseStep });
  return { request: req, decision };
}

function rulesParse(text: string, now: Date, wishes: { personaId: string; text: string }[]) {
  const r = parseRequestWithRules(text, now);
  const wishDrafts: Record<string, MemoryDraft[]> = {};
  for (const w of wishes) wishDrafts[w.personaId] = extractWithRules(w.text).map((d) => ({ ...d, categories: [] }));
  const groupDrafts = extractWithRules(text).filter((d) => d.hard).map((d) => ({ ...d, categories: [] }));
  return { ...r, groupDrafts, wishDrafts };
}

/** Add a one-off wish (or save it to the profile) for one person, then re-decide. */
export async function addWish(requestId: string, personaId: PersonaId, text: string, scope: 'request' | 'profile') {
  const req = store.request(requestId);
  if (!req) throw new Error('not found');
  const t = timer();
  let drafts: MemoryDraft[];
  let mode: 'ai' | 'demo' = 'demo';
  let note: string | undefined;
  if (liveAi()) {
    try {
      const p = await parseRequest(req.text, new Date(req.createdAt), [{ personaId, name: store.persona(personaId)!.name, text }]);
      drafts = p.wishDrafts[personaId] ?? [];
      mode = 'ai';
    } catch (e) {
      note = `Live AI απέτυχε (${aiErrorReason(e)}) — κανόνες.`;
      drafts = extractWithRules(text);
    }
  } else {
    drafts = extractWithRules(text).map((d) => ({ ...d, categories: scope === 'request' ? [] : d.categories }));
  }
  const src = store.addSource(personaId, scope === 'request' ? 'wish' : 'correction', scope === 'request' ? `Επιθυμία για «${req.title}»` : 'Διόρθωση προφίλ από τον κάτοχο', text);
  src.analyzed = true;
  const { created } = store.addMemory(personaId, src, drafts, { origin: 'owner', status: 'confirmed', scope, requestId: scope === 'request' ? requestId : undefined });
  const parseStep: PipelineStep = { key: 'parse', label: 'Νέα επιθυμία', detail: `${created.length} στοιχεία ${scope === 'request' ? 'μόνο για αυτό το αίτημα' : 'αποθηκεύτηκαν στο προφίλ'}${note ? ` · ${note}` : ''}`, mode, ms: t() };
  const decision = await runDecision(requestId, { parseStep });
  return { created, decision };
}

export async function removeItemAndRerun(requestId: string, memoryId: string) {
  const m = store.item(memoryId);
  if (m && m.scope === 'request' && m.requestId === requestId) m.status = 'rejected';
  store.save();
  return runDecision(requestId, {});
}

/** Change a numeric limit (e.g. budget) only for this request: pure code, no AI call needed. */
export async function setLimit(requestId: string, personaId: PersonaId, metric: 'max_cost', value: number) {
  const req = store.request(requestId);
  if (!req) throw new Error('not found');
  const text = `Όριο κόστους ${value}€ ανά άτομο για «${req.title}»`;
  const src = store.addSource(personaId, 'wish', `Όριο για «${req.title}»`, text);
  src.analyzed = true;
  for (const m of store.requestItems(requestId, personaId)) if (m.rule?.metric === metric) m.status = 'superseded';
  store.addMemory(personaId, src, [{ kind: 'constraint', statement: `Όριο κόστους ${value}€ ανά άτομο (μόνο για αυτό)`, domain: 'money', polarity: 'neutral', strength: 1, hard: true, rule: { metric, value: String(value) }, categories: [], keywords: [], quote: text, confidence: 1 }], {
    origin: 'owner',
    status: 'confirmed',
    scope: 'request',
    requestId,
  });
  return runDecision(requestId, {});
}

// ---------------------------------------------------------------------------
// Decision run
// ---------------------------------------------------------------------------

function labelCategory(c: Category) {
  return { trip: 'Ταξίδι', food: 'Φαγητό', entertainment: 'Έξοδος', activity: 'Δραστηριότητα', gift: 'Δώρο', other: 'Άλλο' }[c];
}

/** Items that, if unchanged, let us reuse the model's evaluations (numeric rules are code-only). */
function judgementKey(items: MemoryItem[]): string {
  return items
    .filter((m) => !m.rule)
    .map((m) => `${m.id}|${m.statement}|${m.polarity}|${m.strength}|${m.hard}`)
    .sort()
    .join('\n');
}

function catalogOptions(category: Category, start: string | null, end: string | null): CandidateOption[] {
  const cats: Category[] = category === 'trip' ? ['trip'] : category === 'food' ? ['food'] : category === 'entertainment' ? ['entertainment'] : ['entertainment', 'food'];
  const s = parseIso(start) ?? new Date();
  const days = start && end ? Math.round((parseIso(end)!.getTime() - s.getTime()) / 86400000) : 1;
  const long = category === 'trip' && days >= 2;
  const p = localParts(s);
  const at = (day: number, time: string) => {
    const d = new Date(Date.UTC(p.y, p.m - 1, p.d + day));
    const [hh, mm] = time.split(':').map(Number);
    return athensIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hh, mm);
  };
  return store.catalog
    .filter((c) => cats.includes(c.category))
    .slice(0, 5)
    .map((c) => ({
      id: c.id,
      title: c.title,
      emoji: c.emoji,
      summary: c.summary,
      location: c.location,
      costPerPerson: c.costPerPerson === null ? null : long ? Math.round(c.costPerPerson * 1.4) : c.costPerPerson,
      costNote: long ? `${c.costNote} (×1,4 για τριήμερο)` : c.costNote,
      startsAt: at(c.start.day, c.start.time),
      endsAt: at(c.end.day + (long ? 1 : 0), c.end.time),
      features: c.features,
      origin: 'catalog' as const,
    }));
}

export async function runDecision(requestId: string, opts: { regenerateOptions?: boolean; parseStep?: PipelineStep }): Promise<Decision> {
  const req = store.request(requestId);
  if (!req) throw new Error('not found');
  const personas = req.participants.map((id) => store.persona(id)!).filter(Boolean);
  const previous = store.decisionsFor(requestId).at(-1);
  const steps: PipelineStep[] = opts.parseStep ? [opts.parseStep] : [];
  const live = liveAi();

  // 1. Retrieve each twin's relevant memory.
  let t = timer();
  const twins: TwinContext[] = [];
  const methods = new Set<string>();
  for (const p of personas) {
    const r = await retrieve(`${req.title}. ${req.text}`, store.profile(p.id), store.requestItems(requestId, p.id));
    methods.add(r.method);
    twins.push({ persona: p, items: r.items });
  }
  const inputs = twins.flatMap((x) => x.items);
  steps.push({ key: 'retrieve', label: 'Ανάκτηση μνήμης', detail: `${inputs.length} αναμνήσεις από ${personas.length} Twins (${[...methods].map((m) => (m === 'embeddings' ? 'embeddings' : m === 'keywords' ? 'λέξεις-κλειδιά' : 'όλες')).join(', ')})`, mode: methods.has('embeddings') ? 'ai' : 'code', ms: t() });

  // 2. Options: reuse unless asked to regenerate.
  t = timer();
  let options: CandidateOption[];
  let optMode: PipelineStep['mode'] = 'demo';
  let optDetail = '';
  if (previous && !opts.regenerateOptions) {
    options = previous.options;
    optMode = 'code';
    optDetail = 'ίδιες επιλογές με την προηγούμενη εκτέλεση';
  } else if (live) {
    try {
      options = await generateOptions(req, twins);
      optMode = 'ai';
      optDetail = `${options.length} επιλογές από το ${aiModel()}`;
    } catch (e) {
      options = catalogOptions(req.category, req.periodStart, req.periodEnd);
      optDetail = `Live AI απέτυχε (${aiErrorReason(e)}) — κατάλογος demo`;
    }
  } else {
    options = catalogOptions(req.category, req.periodStart, req.periodEnd);
    optDetail = `${options.length} επιλογές από τον συνθετικό κατάλογο (demo)`;
  }
  steps.push({ key: 'options', label: 'Υποψήφιες επιλογές', detail: optDetail, mode: optMode, ms: t() });

  // 3. Each twin evaluates each option (reuse when only numeric rules changed).
  t = timer();
  let evaluations: Evaluation[];
  let evMode: PipelineStep['mode'] = 'demo';
  let evDetail = '';
  const sameJudgement = previous && previous.options === options && judgementKey(previous.inputs) === judgementKey(inputs);
  if (sameJudgement) {
    evaluations = previous!.evaluations;
    evMode = 'code';
    evDetail = 'άλλαξαν μόνο αριθμητικά όρια — επαναχρησιμοποίηση αξιολογήσεων, χωρίς νέα κλήση AI';
  } else if (live && options.length) {
    try {
      evaluations = await evaluateOptions(options, twins);
      evMode = 'ai';
      evDetail = `${evaluations.length} αξιολογήσεις (${personas.length} Twins × ${options.length} επιλογές)`;
    } catch (e) {
      evaluations = twins.flatMap((x) => evaluateWithRules(x.persona.id, x.items, options));
      evDetail = `Live AI απέτυχε (${aiErrorReason(e)}) — ευρετικοί κανόνες`;
    }
  } else {
    evaluations = twins.flatMap((x) => evaluateWithRules(x.persona.id, x.items, options));
    evDetail = 'ευρετική αντιστοίχιση λέξεων-κλειδιών (demo, όχι AI)';
  }
  steps.push({ key: 'evaluate', label: 'Τα Twins αξιολογούν', detail: evDetail, mode: evMode, ms: t() });

  // 4. Group decision in code.
  t = timer();
  const outcome = decide(personas, inputs, options, evaluations, req.category);
  steps.push({ key: 'decide', label: 'Κοινή απόφαση', detail: outcome.status === 'agreement' ? 'περιορισμοί σε κώδικα · max-min δικαιοσύνη' : 'αδιέξοδο — προτάσεις χαλάρωσης', mode: 'code', ms: t() });

  const decision = store.addDecision({
    requestId,
    options,
    evaluations,
    inputs: inputs.map((m) => ({ ...m })),
    outcome,
    steps,
    approvals: Object.fromEntries(personas.map((p) => [p.id, 'pending'])),
    status: outcome.status === 'deadlock' ? 'deadlock' : 'awaiting_approval',
    aiModel: live ? aiModel() : null,
  });
  if (previous) decision.diff = { previousId: previous.id, changes: diffChanges(previous, decision) };
  store.save();
  return decision;
}

function diffChanges(prev: Decision, next: Decision): string[] {
  const name = (id: string) => store.persona(id)?.name ?? id;
  const key = (m: MemoryItem) => m.id;
  const before = new Map(prev.inputs.map((m) => [key(m), m]));
  const after = new Map(next.inputs.map((m) => [key(m), m]));
  const changes: string[] = [];
  for (const [k, m] of after) if (!before.has(k) && m.scope === 'request') changes.push(`Νέο για ${name(m.personaId)}: ${m.statement}`);
  for (const [k, m] of before) if (!after.has(k) && m.scope === 'request') changes.push(`Αφαιρέθηκε (${name(m.personaId)}): ${m.statement}`);
  for (const [k, m] of after) if (!before.has(k) && m.scope === 'profile' && m.origin === 'owner') changes.push(`Προφίλ ${name(m.personaId)}: ${m.statement}`);
  if (prev.options !== next.options && prev.options.map((o) => o.title).join() !== next.options.map((o) => o.title).join()) changes.push('Νέες υποψήφιες επιλογές');
  const title = (d: Decision) => d.options.find((o) => o.id === d.outcome.chosenOptionId)?.title ?? 'καμία εφικτή επιλογή';
  if (title(prev) !== title(next)) changes.push(`Πρόταση: ${title(prev)} → ${title(next)}`);
  const cost = (d: Decision) => d.options.find((o) => o.id === d.outcome.chosenOptionId)?.costPerPerson ?? null;
  const a = cost(prev);
  const b = cost(next);
  if (a !== null && b !== null && a !== b) changes.push(`Κόστος: ${b - a > 0 ? '+' : ''}${b - a}€/άτομο`);
  return changes;
}

// ---------------------------------------------------------------------------
// Group messages in each person's style
// ---------------------------------------------------------------------------

export async function groupMessages(decisionId: string, regenerate = false): Promise<Decision> {
  const d = store.decision(decisionId);
  if (!d) throw new Error('not found');
  if (d.messages && !regenerate) return d;
  const req = store.request(d.requestId)!;
  const personas = req.participants.map((id) => store.persona(id)!);
  const briefs = personas.map((p) => ({
    personaId: p.id,
    name: p.name,
    style: p.style,
    samples: styleSamples(store.sources, p.id).map((s) => s.text.slice(0, 400)),
    sampleIds: styleSamples(store.sources, p.id).map((s) => s.id),
    facts: messageFacts(d, req, p.id, store.personas),
  }));
  let texts: Record<string, string> = {};
  let note: string | undefined;
  if (liveAi()) {
    try {
      texts = await draftMessages(briefs);
    } catch (e) {
      note = `Live AI απέτυχε (${aiErrorReason(e)}) — πρότυπα.`;
    }
  } else {
    note = 'Demo mode: πρότυπα μηνύματα, χωρίς μίμηση ύφους. Με κλειδί AI γράφονται με το ύφος κάθε κατόχου.';
  }
  d.messages = briefs.map((b): TwinMessage => {
    const base = { personaId: b.personaId, facts: b.facts, styleSourceIds: b.sampleIds, status: 'draft' as const };
    const live = texts[b.personaId];
    if (live) {
      const problem = ungroundedReason(live, b.facts, d.options);
      if (!problem) return { ...base, text: live, mode: 'live' };
      return { ...base, text: templateMessage(d, b.personaId), mode: 'template', guardNote: `Το AI ${problem} — απορρίφθηκε, μπήκε πρότυπο.` };
    }
    return { ...base, text: templateMessage(d, b.personaId), mode: 'template' };
  });
  d.messagesNote = note;
  store.save();
  return d;
}

export function approveMessage(decisionId: string, personaId: PersonaId, text?: string) {
  const d = store.decision(decisionId);
  const m = d?.messages?.find((x) => x.personaId === personaId);
  if (!d || !m) throw new Error('not found');
  if (text?.trim()) m.text = text.trim().slice(0, 300);
  m.status = 'approved';
  store.save();
  return d;
}

// ---------------------------------------------------------------------------
// Questionnaire ZIP import: persona.json + NN-*.md sources + holdout.json
// ---------------------------------------------------------------------------

export interface ImportPackage {
  persona: { name: string; handle: string; emoji?: string; bio?: string };
  files: { name: string; text: string }[];
  holdout?: {
    cases: {
      question: string;
      category: string;
      options: { id: string; title: string; costPerPerson: number | null; features: string[]; endsAt: string | null }[];
      actualOptionId: string;
      note: string;
    }[];
  };
}

const CATS: Category[] = ['trip', 'food', 'entertainment', 'activity', 'gift', 'other'];

export async function importPackage(pkg: ImportPackage) {
  const existing = store.personaByHandle(pkg.persona.handle);
  const persona = existing
    ? store.updatePersona(existing.id, { name: pkg.persona.name, bio: pkg.persona.bio ?? '', emoji: pkg.persona.emoji ?? '' })!
    : store.addPersona(pkg.persona.name, pkg.persona.bio ?? '', pkg.persona.emoji || '✨', pkg.persona.handle);

  // Re-importing the same file replaces it instead of duplicating it.
  const sourceIds: string[] = [];
  for (const f of pkg.files) {
    const { meta, body } = parseFrontMatterText(f.text);
    if (body.trim().length < 5) continue;
    for (const old of store.sources.filter((s) => s.personaId === persona.id && s.fileName === f.name)) store.deleteSource(old.id);
    const kinds = ['document', 'note', 'chat', 'email', 'past_decision'];
    const kind = (kinds.includes(meta.kind) ? meta.kind : 'document') as 'document';
    sourceIds.push(store.addSource(persona.id, kind, meta.title || f.name.replace(/\.[^.]+$/, ''), body, f.name, meta.date).id);
  }

  // Analyse three files at a time.
  const results: Awaited<ReturnType<typeof analyzeAndStore>>[] = [];
  for (let i = 0; i < sourceIds.length; i += 3) {
    results.push(...(await Promise.all(sourceIds.slice(i, i + 3).map((id) => analyzeAndStore(id)))));
  }

  let styleNote: string | undefined;
  try {
    await refreshStyle(persona.id);
  } catch (e) {
    styleNote = `Το ύφος δεν αναλύθηκε: ${aiErrorReason(e)}`;
  }

  let holdouts = 0;
  if (pkg.holdout?.cases?.length) {
    const cases = pkg.holdout.cases
      .filter((c) => c.options.length >= 2 && c.options.some((o) => o.id === c.actualOptionId))
      .map((c, i) => ({
        id: `imp-${persona.id}-${i + 1}`,
        personaId: persona.id,
        question: c.question.slice(0, 200),
        category: (CATS.includes(c.category as Category) ? c.category : 'other') as Category,
        actualOptionId: c.actualOptionId,
        note: c.note.slice(0, 300),
        origin: 'imported' as const,
        options: c.options.map((o) => ({
          id: o.id,
          title: o.title.slice(0, 100),
          emoji: '',
          summary: '',
          location: '',
          costPerPerson: typeof o.costPerPerson === 'number' && o.costPerPerson >= 0 ? o.costPerPerson : null,
          costNote: '',
          startsAt: null,
          endsAt: o.endsAt && parseIso(o.endsAt) ? o.endsAt : null,
          features: o.features.slice(0, 8),
          origin: 'catalog' as const,
        })),
      }));
    store.setHoldouts(persona.id, cases);
    holdouts = cases.length;
  }

  return {
    persona,
    sources: results.length,
    memories: results.reduce((a, r) => a + r.created.length, 0),
    dropped: results.reduce((a, r) => a + r.dropped, 0),
    mode: results[0]?.mode ?? 'demo',
    notes: [...new Set(results.map((r) => r.note).filter(Boolean)), ...(styleNote ? [styleNote] : [])] as string[],
    holdouts,
  };
}

function parseFrontMatterText(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2].trim() };
}
