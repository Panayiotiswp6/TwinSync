// The TwinSync pipeline: request -> retrieve memory -> options -> twin evaluations -> group decision.
// Live AI does the reasoning (understanding, options, per-twin judgement, style);
// code does the guarantees (quotes, ids, numeric limits, fairness, approvals).

import { contextFit, requestContext, spanDays, type RequestContext } from '../shared/context';
import { decide } from '../shared/decide';
import { contextOf, evaluateWithRules, extractWithRules, parseRequestWithRules, type MemoryDraft } from '../shared/heuristics';
import { chatFacts, messageFacts, placeLine, styleSamples, templateChat, templateMessage, ungroundedReason } from '../shared/messages';
import { areasOf, datesBetween, inArea, KIND_CATEGORY, KIND_LABEL, kindFromText, linkByKeywords, LOCAL_KINDS, planWishes, prepareOptions } from '../shared/plan';
import { normalizeGreek } from '../shared/text';
import { athensIso, formatWhen, localParts, parseIso, WEEKDAYS_EL } from '../shared/time';
import type { CandidateOption, Category, Decision, Evaluation, GroupRequest, Itinerary, MemoryItem, Persona, PersonaId, PipelineStep, RequestKind, StyleCard, TwinChat, TwinMessage, Venue } from '../shared/types';
import { aiErrorReason, aiModel, analyzeSource, buildStyle, draftMessages, evaluateOptions, generateOptions, liveAi, negotiationChat, parseRequest, type TwinContext } from './ai';
import { noEmit, type Emit } from './jobs';
import { retrieve } from './retrieval';
import { loadTripFixtures, loadVenues, type TripFixture, type VenueEntry } from './seed';
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

type Parsed = {
  title: string;
  category: Category;
  kind: RequestKind;
  city: string | null;
  area: string;
  periodStart: string | null;
  periodEnd: string | null;
  where: 'local' | 'domestic' | 'abroad' | null;
  place: string;
  groupDrafts: MemoryDraft[];
  wishDrafts: Record<string, MemoryDraft[]>;
};

/** Where the group is: the request text > the city in the form > the demo's assumption (shown, editable). */
export const DEFAULT_CITY = 'Αθήνα';

export async function createRequest(text: string, participants: PersonaId[], wishes: Record<PersonaId, string>, emit: Emit = noEmit, form: { city?: string; cityAssumed?: boolean } = {}) {
  const formCity = form.city?.trim() || DEFAULT_CITY;
  const now = new Date();
  const wishList = participants.filter((id) => wishes[id]?.trim()).map((id) => ({ personaId: id, name: store.persona(id)!.name, text: wishes[id].trim() }));
  emit({ who: 'system', kind: 'info', text: `Νέο αίτημα: «${text.trim().slice(0, 120)}»` });
  for (const id of participants) emit({ who: id, kind: 'join', text: `Το Twin ${store.persona(id)?.name ?? id} μπήκε στη συζήτηση` });
  let parsed: Parsed;
  let mode: 'ai' | 'demo' = 'demo';
  let note: string | undefined;
  const t = timer();
  if (liveAi()) {
    try {
      parsed = await parseRequest(text, now, wishList, formCity, participants.length);
      mode = 'ai';
    } catch (e) {
      note = `Live AI απέτυχε (${aiErrorReason(e)}) — χρησιμοποιήθηκαν κανόνες.`;
      parsed = rulesParse(text, now, wishList);
    }
  } else {
    parsed = rulesParse(text, now, wishList);
  }
  const days = spanDays(parsed.periodStart, parsed.periodEnd);
  // Safety net: if the model could not classify the request, the rules may (e.g. "πού να βγούμε… με μουσική" = live).
  const kind = parsed.kind === 'other' ? (kindFromText(text) ?? 'other') : parsed.kind;
  const category = KIND_CATEGORY[kind] ?? parsed.category;
  // A local plan is local wherever the group is (Thessaloniki is not "a trip in Greece").
  const where = kind === 'trip' ? (parsed.where === 'local' || !parsed.where ? 'domestic' : parsed.where) : LOCAL_KINDS.includes(kind) ? 'local' : (parsed.where ?? 'local');
  const city = parsed.city || formCity;
  const cityAssumed = !parsed.city && (form.cityAssumed ?? !form.city);
  const req = store.addRequest({ text, title: parsed.title, category, kind, city, cityAssumed, area: parsed.area, periodStart: parsed.periodStart, periodEnd: parsed.periodEnd, participants, days, where, place: parsed.place });
  emit({
    who: 'system',
    kind: 'info',
    text: `${KIND_LABEL[kind]} · ${kind === 'trip' ? `${days} ${days === 1 ? 'μέρα' : 'μέρες'} · από ${city} · ${where === 'abroad' ? 'εξωτερικό' : 'Ελλάδα'}${parsed.place ? ` · ${parsed.place}` : ''}` : `${city}${cityAssumed ? ' (παραδοχή)' : ''}${parsed.area ? ` · ${parsed.area}` : ''} · ${formatWhen(parsed.periodStart)}`}`,
  });
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
  for (const d of new Map(parsed.groupDrafts.map((x) => [x.statement, x])).values()) emit({ who: 'system', kind: 'info', text: `Το αίτημα λέει: ${d.statement}` });
  const parseStep: PipelineStep = { key: 'parse', label: 'Κατανόηση αιτήματος & επιθυμιών', detail: `${KIND_LABEL[kind]} · ${labelCategory(category)}${kind !== 'trip' ? ` · ${city}${parsed.area ? ` / ${parsed.area}` : ''}` : ''} · ${wishList.length} προσωρινές επιθυμίες${note ? ` · ${note}` : ''}`, mode, ms: t() };
  const decision = await runDecision(req.id, { parseStep, emit });
  return { request: req, decision };
}

function rulesParse(text: string, now: Date, wishes: { personaId: string; text: string }[]): Parsed {
  const r = parseRequestWithRules(text, now);
  const c = contextOf(normalizeGreek(text));
  const where = c.where === 'abroad' ? 'abroad' : r.kind === 'trip' ? 'domestic' : 'local';
  const wishDrafts: Record<string, MemoryDraft[]> = {};
  for (const w of wishes) wishDrafts[w.personaId] = extractWithRules(w.text).map((d) => ({ ...d, categories: [] }));
  const groupDrafts = extractWithRules(text).filter((d) => d.hard).map((d) => ({ ...d, categories: [] }));
  return { ...r, where, place: '', groupDrafts, wishDrafts };
}

/** Add a one-off wish (or save it to the profile) for one person, then re-decide. */
export async function addWish(requestId: string, personaId: PersonaId, text: string, scope: 'request' | 'profile', regenerate = false) {
  const req = store.request(requestId);
  if (!req) throw new Error('not found');
  const t = timer();
  let drafts: MemoryDraft[];
  let mode: 'ai' | 'demo' = 'demo';
  let note: string | undefined;
  if (liveAi()) {
    try {
      const p = await parseRequest(req.text, new Date(req.createdAt), [{ personaId, name: store.persona(personaId)!.name, text }], req.city || DEFAULT_CITY, req.participants.length);
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
  // A new qualitative wish can change WHAT should be proposed: optionally ask for new options.
  const decision = await runDecision(requestId, { parseStep, regenerateOptions: regenerate });
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
  const long = category === 'trip' && spanDays(start, end) >= 3;
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
      synthetic: true,
    }));
}

// ---------------------------------------------------------------------------
// Curated venues (real places, public listing) and synthetic trip fixtures
// ---------------------------------------------------------------------------

let venues: VenueEntry[] | null = null;
const allVenues = () => (venues ??= loadVenues());

/** Catalogue in the shape used for matching (existence + public reference). */
export function venueCatalogue(): Venue[] {
  return allVenues().map((v) => ({ name: v.name, kind: v.subtype, area: v.area, city: v.city, address: v.address, catalogId: v.id, source: v.source, url: v.url, checkedAt: v.checkedAt }));
}

const KIND_VENUES: Partial<Record<RequestKind, VenueEntry['kind'][]>> = { coffee: ['coffee'], drinks: ['drinks'], club: ['club', 'drinks'], live: ['live'], dinner: ['dinner'] };

/** Venues of the requested kind in the group's city, those inside the requested area first. */
export function catalogueFor(req: Pick<GroupRequest, 'kind' | 'city' | 'area'>): VenueEntry[] {
  const kinds = req.kind ? KIND_VENUES[req.kind] : undefined;
  if (!kinds) return [];
  const city = normalizeGreek(req.city || DEFAULT_CITY).slice(0, 5);
  const list = allVenues().filter((v) => kinds.includes(v.kind) && normalizeGreek(v.city).startsWith(city));
  const areas = areasOf(req.area);
  return [...list].sort((a, b) => Number(inArea(b, areas)) - Number(inArea(a, areas)));
}

const KIND_EMOJI: Record<string, string> = { coffee: '☕', drinks: '🍸', live: '🎶', club: '🪩', dinner: '🍽️' };

function venueOption(v: VenueEntry, req: GroupRequest, items: MemoryItem[]): CandidateOption {
  const text = `${v.subtype} ${v.features.join(' ')} ${v.quiet ? 'ήσυχο' : ''}`;
  return {
    id: v.id,
    title: v.name,
    emoji: KIND_EMOJI[v.kind] ?? '📍',
    summary: `${v.subtype} · ${v.area}${v.address ? `, ${v.address}` : ''}`,
    location: `${v.area}, ${v.city}`,
    costPerPerson: v.priceHint ?? null,
    costNote: 'εκτίμηση της ομάδας, όχι τιμή καταστήματος',
    startsAt: req.periodStart,
    endsAt: req.periodEnd,
    features: [...v.features, ...(v.quiet ? ['ήσυχο'] : [])],
    origin: 'catalog',
    venue: { name: v.name, kind: v.subtype, area: v.area, city: v.city, address: v.address, catalogId: v.id, source: v.source, url: v.url, checkedAt: v.checkedAt },
    why: linkByKeywords(text, items).map((l) => ({ personaId: l.personaId, memoryId: l.memoryId, text: `ταιριάζει με «${l.statement}»` })),
  };
}

/** A synthetic demo trip, laid out on the requested dates (first day, middle days, last day). */
export function fixtureOption(f: TripFixture, req: Pick<GroupRequest, 'periodStart' | 'periodEnd' | 'city'>, items: MemoryItem[]): CandidateOption | null {
  const dates = datesBetween(req.periodStart, req.periodEnd);
  if (dates.length < 2) return null;
  const at = (date: string, time: string) => {
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    return athensIso(y, m, d, hh, mm);
  };
  const days = dates.map((date, i) => {
    const t = i === 0 ? f.first : i === dates.length - 1 ? f.last : f.middle[(i - 1) % f.middle.length];
    const wd = WEEKDAYS_EL[new Date(`${date}T12:00:00Z`).getUTCDay()];
    return {
      date,
      title: `${wd} — ${t.title}`,
      slots: t.slots.map((x) => ({
        start: x.start,
        end: x.end,
        part: x.part,
        title: x.title,
        place: x.place,
        serves: linkByKeywords(`${x.title} ${x.tags.join(' ')}`, items).map((l) => ({ personaId: l.personaId, memoryId: l.memoryId })),
        ...(x.alternative ? { alternative: x.alternative } : {}),
        ...(x.conditional ? { conditional: x.conditional } : {}),
      })),
    };
  });
  const n = dates.length;
  const cost = { transport: f.cost.transport, stay: f.cost.stayPerNight * (n - 1), food: f.cost.foodPerDay * n, activities: f.cost.activitiesPerDay * n, total: 0 };
  cost.total = cost.transport + cost.stay + cost.food + cost.activities;
  const itinerary: Itinerary = {
    origin: req.city || DEFAULT_CITY,
    destination: f.destination,
    country: f.country,
    depart: { at: at(dates[0], f.depart.time), mode: f.depart.mode },
    return: { at: at(dates[n - 1], f.return.time), mode: f.return.mode },
    stay: f.stay,
    days,
    cost,
  };
  return {
    id: f.id,
    title: f.title,
    emoji: f.emoji,
    summary: f.summary,
    location: `${f.destination}, ${f.country}`,
    costPerPerson: cost.total,
    costNote: `μετακίνηση ${cost.transport}€ + διαμονή ${cost.stay}€ + φαγητό ${cost.food}€ + δραστηριότητες ${cost.activities}€ (συνθετικές τιμές)`,
    startsAt: itinerary.depart.at,
    endsAt: itinerary.return.at,
    features: f.features,
    origin: 'catalog',
    synthetic: true,
    itinerary,
  };
}

/** Demo mode / last fallback: named venues from the curated catalogue, synthetic trips, then the synthetic catalogue. */
function demoOptions(req: GroupRequest, twins: TwinContext[]): CandidateOption[] {
  const items = twins.flatMap((t) => t.items);
  const kind = req.kind ?? 'other';
  const out: CandidateOption[] = [];
  if (LOCAL_KINDS.includes(kind)) {
    const list = catalogueFor(req);
    const areas = areasOf(req.area);
    const inside = list.filter((v) => inArea(v, areas));
    for (const v of (inside.length ? inside : list).slice(0, 5)) out.push(venueOption(v, req, items));
    // Live: a favourite artist of someone in the group is a reason to check a venue's programme (never "confirmed").
    const fav = items.find((m) => m.statement.startsWith('Αγαπημένοι καλλιτέχνες'))?.keywords[0];
    if (kind === 'live' && fav && out[0]) out[0] = { ...out[0], artistHint: fav };
  }
  if (kind === 'trip' && req.where === 'abroad') {
    for (const f of loadTripFixtures()) {
      const o = fixtureOption(f, req, items);
      if (o) out.push(o);
    }
  }
  if (out.length >= 2) return out;
  // The synthetic catalogue is set in Athens: only use it there (or for trips/other kinds).
  const athens = normalizeGreek(req.city || DEFAULT_CITY).startsWith('αθην');
  if (LOCAL_KINDS.includes(kind) && !athens) return out;
  return [...out, ...catalogOptions(req.category, req.periodStart, req.periodEnd).filter((o) => !LOCAL_KINDS.includes(kind) || kind === 'dinner' || o.features.some((f) => /(μπαρ|club|κλαμπ|live|ποτ|cocktail)/i.test(f)))];
}

/** Absolute last resort, so a request never ends with nothing: an honest placeholder to fill in. */
function placeholderOption(req: GroupRequest): CandidateOption {
  const kind = req.kind ?? 'other';
  const where = [req.area, req.city || DEFAULT_CITY].filter(Boolean).join(', ');
  return {
    id: 'placeholder-1',
    title: `${KIND_LABEL[kind]} — ${where}`,
    emoji: '📍',
    summary: 'Δεν βρέθηκε επώνυμη πρόταση σε αυτή την πόλη/περιοχή. Η ώρα και το πλαίσιο ισχύουν· το μαγαζί το διαλέγετε εσείς.',
    location: where,
    costPerPerson: null,
    costNote: 'άγνωστο',
    startsAt: req.periodStart,
    endsAt: req.periodEnd,
    features: [],
    origin: 'catalog',
    synthetic: true,
  };
}

export async function runDecision(requestId: string, opts: { regenerateOptions?: boolean; parseStep?: PipelineStep; emit?: Emit }): Promise<Decision> {
  const req = store.request(requestId);
  if (!req) throw new Error('not found');
  const emit = opts.emit ?? noEmit;
  const ctx = requestContext(req);
  const personas = req.participants.map((id) => store.persona(id)!).filter(Boolean);
  const previous = store.decisionsFor(requestId).at(-1);
  const steps: PipelineStep[] = opts.parseStep ? [opts.parseStep] : [];
  const live = liveAi();

  // 1. Retrieve each twin's relevant memory.
  let t = timer();
  const twins: TwinContext[] = [];
  const methods = new Set<string>();
  for (const p of personas) {
    const r = await retrieve(`${req.title}. ${req.text}`, store.profile(p.id), store.requestItems(requestId, p.id), { kind: req.kind, category: req.category, ctx });
    methods.add(r.method);
    twins.push({ persona: p, items: r.items, learned: learnedIds(r.items) });
    for (const line of recall(r.items, ctx)) emit({ who: p.id, kind: 'think', text: line });
  }
  const inputs = twins.flatMap((x) => x.items);
  steps.push({ key: 'retrieve', label: 'Ανάκτηση μνήμης', detail: `${inputs.length} αναμνήσεις από ${personas.length} Twins (${[...methods].map((m) => (m === 'embeddings' ? 'embeddings' : 'λέξεις-κλειδιά')).join(', ')} · μόνο ό,τι αφορά ${req.kind ? KIND_LABEL[req.kind].toLowerCase() : 'το αίτημα'})`, mode: methods.has('embeddings') ? 'ai' : 'code', ms: t() });

  // 2. Options: reuse unless asked to regenerate. New options are VALIDATED before anyone votes:
  //    a named place in the right area for local plans, a complete day-by-day plan for trips.
  t = timer();
  let options: CandidateOption[];
  let rejected: { title: string; reason: string }[] = previous?.rejectedOptions ?? [];
  let optMode: PipelineStep['mode'] = 'demo';
  let optDetail = '';
  const groupItem = (m: MemoryItem) => m.refs.some((r) => store.source(r.sourceId)?.personaId === 'group');
  const prepInput = () => ({
    req,
    items: inputs,
    wishes: planWishes(inputs, groupItem, req.kind === 'trip'),
    wishText: inputs.filter((m) => m.scope === 'request').map((m) => m.statement).join(' '),
    catalogue: venueCatalogue(),
  });
  const prep = (list: CandidateOption[]) => prepareOptions(list, prepInput());
  if (previous && !opts.regenerateOptions) {
    options = previous.options;
    optMode = 'code';
    optDetail = 'ίδιες επιλογές με την προηγούμενη εκτέλεση';
  } else {
    let note = '';
    let got: ReturnType<typeof prep> = { valid: [], rejected: [] };
    if (live) {
      emit({ who: 'system', kind: 'info', text: req.kind === 'trip' ? 'Φτιάχνουμε πλήρη προγράμματα ανά ημέρα…' : 'Ψάχνουμε συγκεκριμένα μέρη που ταιριάζουν σε όλους…' });
      const cat = catalogueFor(req).map((v) => ({ name: v.name, subtype: v.subtype, area: v.area, address: v.address, quiet: v.quiet, priceHint: v.priceHint }));
      try {
        got = prep(await generateOptions(req, twins, ctx, cat));
        // At most one retry, telling the model exactly what the validator rejected.
        if (got.valid.length < 2 && got.rejected.length) {
          emit({ who: 'system', kind: 'info', text: `${got.rejected.length} προτάσεις απορρίφθηκαν από τον έλεγχο (π.χ. ${got.rejected[0].reason}) — νέα προσπάθεια…` });
          const second = prep(await generateOptions(req, twins, ctx, cat, got.rejected.map((r) => `«${r.title}»: ${r.reason}`)));
          got = { valid: [...got.valid, ...second.valid].slice(0, 6), rejected: [...got.rejected, ...second.rejected] };
        }
        optMode = 'ai';
      } catch (e) {
        note = `Live AI απέτυχε (${aiErrorReason(e)})`;
      }
    }
    if (!got.valid.length) {
      const list = demoOptions(req, twins);
      let demo = prep(list);
      // Never show nothing: keep a named place outside the area (flagged), then a clearly marked placeholder.
      if (!demo.valid.length) demo = { valid: prepareOptions(list, { ...prepInput(), lenient: true }).valid, rejected: demo.rejected };
      if (!demo.valid.length) demo = { valid: prep([placeholderOption(req)]).valid, rejected: demo.rejected };
      got = { valid: demo.valid, rejected: [...got.rejected, ...demo.rejected] };
      optMode = 'demo';
      note = note ? `${note} — κατάλογος/fixtures demo` : 'κατάλογος επώνυμων μαγαζιών & συνθετικά fixtures (demo)';
    }
    options = got.valid.map((o, i) => ({ ...o, id: o.id.startsWith('opt-') ? `opt-${i + 1}` : o.id }));
    rejected = got.rejected;
    optDetail = `${options.length} επιλογές${optMode === 'ai' ? ` από το ${aiModel()}` : ''} πέρασαν τον έλεγχο${rejected.length ? ` · ${rejected.length} απορρίφθηκαν πριν την ψηφοφορία` : ''}${note ? ` · ${note}` : ''}`;
  }
  steps.push({ key: 'options', label: 'Υποψήφιες επιλογές', detail: optDetail, mode: optMode, ms: t() });
  emit({ who: 'system', kind: 'options', text: options.map((o) => `${o.emoji} ${o.venue ? placeLine(o) : o.title}${o.costPerPerson !== null ? ` · ~${o.costPerPerson}€` : ''}`).join('\n') });

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
      evaluations = await evaluateOptions(options, twins, ctx, `${req.title}. ${req.text}`);
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
  const outcome = decide(personas, inputs, options, evaluations, req.category, ctx);
  steps.push({
    key: 'decide',
    label: 'Κοινή απόφαση',
    detail: outcome.status === 'agreement' ? 'περιορισμοί σε κώδικα · max-min δικαιοσύνη' : outcome.status === 'compromise' ? 'καμία επιλογή δεν περνά όλα τα όρια — η πιο κοντινή σε όλους' : 'καμία επιλογή',
    mode: 'code',
    ms: t(),
  });
  for (const v of outcome.votes) {
    const o = options.find((x) => x.id === v.optionId);
    emit({ who: v.personaId, kind: 'vote', text: o ? `${o.emoji} ${o.title} — ${v.verdict || 'η πρώτη μου επιλογή'}` : 'Καμία επιλογή δεν μου ταιριάζει πλήρως' });
  }

  const decision = store.addDecision({
    requestId,
    options,
    evaluations,
    inputs: inputs.map((m) => ({ ...m })),
    outcome,
    steps,
    approvals: Object.fromEntries(personas.map((p) => [p.id, 'pending'])),
    // There is always a proposal to approve. If it does not cover someone's limit, that person decides with their own approval.
    status: outcome.chosenOptionId ? 'awaiting_approval' : 'deadlock',
    rejectedOptions: rejected,
    aiModel: live ? aiModel() : null,
  });
  if (previous) decision.diff = { previousId: previous.id, changes: diffChanges(previous, decision) };
  emit({ who: 'system', kind: 'info', text: 'Τα Twins συζητούν…' });
  const sameOutcome = previous?.chat && sameJudgement && previous.outcome.chosenOptionId === outcome.chosenOptionId && previous.outcome.status === outcome.status;
  decision.chat = sameOutcome ? { ...previous!.chat!, note: 'Ίδια πρόταση με πριν — η συζήτηση δεν ξαναγράφτηκε (χωρίς νέα κλήση AI).' } : await twinChat(decision, personas);
  for (const l of decision.chat.lines) emit({ who: l.personaId, kind: 'say', text: l.text });
  store.save();
  return decision;
}

/** Memory learned from the person's own past decisions (approved requests, past_decision sources). */
function learnedIds(items: MemoryItem[]): Set<string> {
  return new Set(items.filter((m) => m.refs.some((r) => store.source(r.sourceId)?.kind === 'past_decision')).map((m) => m.id));
}

/** What a twin "remembers" first for this request — its OWN wishes first, then what actually applies. */
function recall(items: MemoryItem[], ctx: RequestContext): string[] {
  const out: string[] = [];
  const own = items.filter((x) => x.scope === 'request' && !x.refs.some((r) => store.source(r.sourceId)?.personaId === 'group'));
  for (const m of own.slice(0, 2)) out.push(`Για αυτό ζήτησα: ${m.statement}`);
  for (const m of items.filter((x) => x.scope === 'profile' && x.rule)) {
    const fit = contextFit(m, ctx);
    if (fit.note) out.push(`«${m.statement}» — ${fit.note}${fit.applies ? '' : ', το κρατάω μόνο ως ένδειξη'}`);
  }
  const rest = items.filter((x) => x.scope === 'profile' && !x.rule).sort((a, b) => Number(b.hard) - Number(a.hard) || b.strength - a.strength);
  for (const m of rest) {
    if (out.length >= 3) break;
    out.push(`Θυμάμαι: ${m.statement}`);
  }
  return out.slice(0, 3);
}

/** The twins' negotiation as a group DM, in each owner's voice (live) or from templates (demo). */
async function twinChat(d: Decision, personas: Persona[]): Promise<TwinChat> {
  const req = store.request(d.requestId)!;
  if (!d.outcome.chosenOptionId) return { lines: templateChat(d, personas), mode: 'template' };
  if (!liveAi()) return { lines: templateChat(d, personas), mode: 'template', note: 'Demo mode: πρότυπη συζήτηση, χωρίς μίμηση ύφους.' };
  const { shared, perPerson } = chatFacts(d, req, personas);
  try {
    const raw = await negotiationChat(
      personas.map((p) => ({ personaId: p.id, name: p.name, style: p.style, samples: styleSamples(store.sources, p.id).map((s) => s.text.slice(0, 300)).slice(0, 6), facts: perPerson[p.id] ?? [] })),
      shared,
    );
    let dropped = 0;
    // A twin never "accepts" breaking its own strict limit — drop such lines.
    const breached = new Set(d.outcome.status === 'compromise' ? (d.outcome.results.find((r) => r.optionId === d.outcome.chosenOptionId)?.violations.map((v) => v.personaId) ?? []) : []);
    const ACCEPT = /(κανω πισω|δεχομαι|ας ειναι|συμφωνω|ενταξει|^οκ\b|^ok\b|πααμε|παμε)/;
    const lines = raw.filter((l) => {
      if (breached.has(l.personaId) && ACCEPT.test(normalizeGreek(l.text))) {
        dropped++;
        return false;
      }
      const bad = ungroundedReason(l.text, [...shared, ...(perPerson[l.personaId] ?? [])], d.options);
      if (bad) dropped++;
      return !bad;
    });
    if (lines.length >= 3 && new Set(lines.map((l) => l.personaId)).size >= Math.min(2, personas.length)) {
      return { lines, mode: 'live', note: dropped ? `${dropped} μήνυμα(τα) απορρίφθηκαν από τον έλεγχο γεγονότων.` : undefined };
    }
    return { lines: templateChat(d, personas), mode: 'template', note: 'Το AI έγραψε μηνύματα με στοιχεία εκτός απόφασης — μπήκε πρότυπο.' };
  } catch (e) {
    return { lines: templateChat(d, personas), mode: 'template', note: `Live AI απέτυχε (${aiErrorReason(e)}) — πρότυπη συζήτηση.` };
  }
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

// ---------------------------------------------------------------------------
// Learning loop: an approved plan becomes a past decision of each owner who approved it
// ---------------------------------------------------------------------------

/** After an owner approves, record what they asked for and what they accepted, and learn from it. */
export async function learnFromDecision(decisionId: string, personaId: PersonaId) {
  const d = store.decision(decisionId);
  const req = d && store.request(d.requestId);
  const chosen = d?.options.find((o) => o.id === d.outcome.chosenOptionId);
  if (!d || !req || !chosen) return null;
  const title = `Απόφαση: ${req.title}`;
  if (store.sources.some((s) => s.personaId === personaId && s.kind === 'past_decision' && s.title === title)) return null;
  const wishes = store.sources.filter((s) => s.personaId === personaId && s.kind === 'wish' && s.title.includes(req.title)).map((s) => s.text);
  const vote = d.outcome.votes.find((v) => v.personaId === personaId);
  const voted = d.options.find((o) => o.id === vote?.optionId);
  const c = d.outcome.concessions.find((x) => x.personaId === personaId);
  const ctx = requestContext(req);
  const lines = [
    `Αίτημα της παρέας: ${req.text}`,
    `Πλαίσιο: ${ctx.days} ${ctx.days === 1 ? 'μέρα' : 'μέρες'}, ${ctx.where === 'abroad' ? 'εξωτερικό' : ctx.where === 'domestic' ? 'Ελλάδα' : 'στην πόλη'}${req.place ? `, ${req.place}` : ''}.`,
    ...wishes.map((w) => `Τι ζήτησα εγώ για αυτό: ${w}`),
    voted ? `Πρώτη μου επιλογή: ${voted.title}${voted.costPerPerson !== null ? ` (~${voted.costPerPerson}€/άτομο)` : ''}.` : '',
    `Ενέκρινα: ${chosen.title}${chosen.costPerPerson !== null ? ` (~${chosen.costPerPerson}€/άτομο)` : ''} — ${chosen.features.slice(0, 4).join(', ')}.`,
    ...(c?.items ?? []).map((i) => `Δέχτηκα: ${i}`),
  ].filter(Boolean);
  const src = store.addSource(personaId, 'past_decision', title, lines.join('\n'));
  const r = await analyzeAndStore(src.id);
  // The owner approved this plan themselves, so what it teaches is confirmed (and stays editable in the profile).
  for (const m of r.created) store.updateMemory(m.id, { status: 'confirmed' });
  return r;
}


// ---------------------------------------------------------------------------
// The owner (not the twin) relaxes one strict limit, only for this request.
// ---------------------------------------------------------------------------

export async function relaxLimit(requestId: string, memoryId: string, optionId: string) {
  const req = store.request(requestId);
  const d = store.decisionsFor(requestId).at(-1);
  const m = d?.inputs.find((x) => x.id === memoryId) ?? store.item(memoryId);
  const o = d?.options.find((x) => x.id === optionId);
  if (!req || !d || !m || !o || !m.rule || m.rule.metric === 'avoid_place') throw new Error('Μόνο αριθμητικά όρια (κόστος, ώρα) αλλάζουν από εδώ.');
  const value = m.rule.metric === 'max_cost' ? (o.costPerPerson === null ? null : String(o.costPerPerson)) : o.endsAt;
  if (!value) throw new Error('Η επιλογή δεν έχει γνωστό κόστος ή ώρα λήξης.');
  const label = m.rule.metric === 'max_cost' ? `${value}€ ανά άτομο` : formatWhen(value);
  const text = `Ο κάτοχος αλλάζει το όριο μόνο για «${req.title}»: ${label} (αντί για «${m.statement}»)`;
  const src = store.addSource(m.personaId, 'wish', `Αλλαγή ορίου για «${req.title}»`, text);
  src.analyzed = true;
  for (const x of store.requestItems(requestId, m.personaId)) if (x.rule?.metric === m.rule.metric) x.status = 'superseded';
  store.addMemory(
    m.personaId,
    src,
    [{ kind: 'constraint', statement: `${m.rule.metric === 'max_cost' ? 'Όριο κόστους' : 'Λήξη το αργότερο'} ${label} (αλλαγή του κατόχου, μόνο για αυτό)`, domain: m.domain, polarity: 'neutral', strength: 1, hard: true, rule: { metric: m.rule.metric, value }, categories: [], keywords: [], quote: text, confidence: 1 }],
    { origin: 'owner', status: 'confirmed', scope: 'request', requestId },
  );
  return runDecision(requestId, {});
}
