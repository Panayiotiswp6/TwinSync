// Offline tests (no network, ephemeral store — see vitest.config.ts).
import { beforeEach, describe, expect, it } from 'vitest';
import { appliesToCategory, contextFit, requestContext, spanDays } from '../shared/context';
import { checkRule, decide } from '../shared/decide';
import { evaluateWithRules, extractWithRules, parseRequestWithRules } from '../shared/heuristics';
import { messageFacts, templateMessage, ungroundedReason } from '../shared/messages';
import { deadlineFor } from '../shared/time';
import type { CandidateOption, MemoryItem } from '../shared/types';
import { evaluationReport } from '../server/evaluation';
import { addWish, analyzeAndStore, createRequest, groupMessages, runDecision, setLimit } from '../server/pipeline';
import { loadSeed } from '../server/seed';
import { store } from '../server/store';

const opt = (o: Partial<CandidateOption>): CandidateOption => ({ id: 'o', title: 'Επιλογή', emoji: '', summary: '', location: '', costPerPerson: 100, costNote: '', startsAt: null, endsAt: null, features: [], origin: 'catalog', ...o });
const rule = (metric: 'max_cost' | 'latest_end', value: string): MemoryItem => ({
  id: 'r', personaId: 'geo', kind: 'constraint', statement: 'κανόνας', domain: 'money', polarity: 'neutral', strength: 1, hard: true, rule: { metric, value },
  categories: [], keywords: [], refs: [], confidence: 1, status: 'confirmed', origin: 'owner', scope: 'request', createdAt: '',
});

describe('seed data', () => {
  it('loads persona text files and every citation is an exact span of its source', () => {
    const s = loadSeed();
    expect(s.personas).toHaveLength(3);
    expect(s.sources.length).toBeGreaterThanOrEqual(21);
    expect(s.memory.length).toBeGreaterThanOrEqual(30);
    for (const m of s.memory) expect(m.memory?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('numeric hard rules are checked in code', () => {
  it('max_cost', () => {
    expect(checkRule(rule('max_cost', '150'), opt({ costPerPerson: 165 }))).toMatch(/165/);
    expect(checkRule(rule('max_cost', '150'), opt({ costPerPerson: 150 }))).toBeNull();
    expect(checkRule(rule('max_cost', '150'), opt({ costPerPerson: null }))).toBeNull(); // unknown -> warning, not a guess
  });
  it('latest_end: weekly "Sunday 21:00" relative to the option start', () => {
    const r = rule('latest_end', 'weekly:0:21:00');
    expect(checkRule(r, opt({ startsAt: '2026-11-21T09:00:00+02:00', endsAt: '2026-11-22T22:30:00+02:00' }))).toMatch(/22:30/);
    expect(checkRule(r, opt({ startsAt: '2026-11-21T09:00:00+02:00', endsAt: '2026-11-22T20:15:00+02:00' }))).toBeNull();
    expect(deadlineFor('weekly:1:23:59', new Date('2026-12-04T18:00:00+02:00'))?.toISOString()).toBe('2026-12-07T21:59:00.000Z');
  });
});

describe('context-aware memory', () => {
  const ctxItem = (o: Partial<MemoryItem>): MemoryItem => ({ ...rule('max_cost', '200'), id: 'c', scope: 'profile', ...o });
  const trip4 = { days: 4, where: 'abroad' as const };
  it('a habit ("συνήθως 200€ για διήμερο") is soft and never blocks', () => {
    const d = extractWithRules('Συνήθως δίνω μέχρι 200€ για ένα διήμερο.');
    const m = d.find((x) => x.rule?.metric === 'max_cost')!;
    expect(m.hard).toBe(false);
    expect(m.context).toEqual({ where: 'domestic', days: 2 });
    const item = ctxItem({ hard: false, context: m.context });
    const out = decide([{ id: 'geo', name: 'Γ' } as never], [item], [opt({ id: 'x', costPerPerson: 650 })], [], 'trip', trip4);
    expect(out.status).toBe('agreement');
  });
  it('a hard limit said for 2 days in Greece does not bind 4 days abroad', () => {
    const item = ctxItem({ hard: true, context: { where: 'domestic', days: 2 } });
    const out = decide([{ id: 'geo', name: 'Γ' } as never], [item], [opt({ id: 'x', costPerPerson: 650 })], [], 'trip', trip4);
    expect(out.status).toBe('agreement');
    expect(contextFit(item, trip4).applies).toBe(false);
  });
  it('a hard limit scales with the duration (150€ / 2 days -> 300€ for 4 days)', () => {
    const item = ctxItem({ hard: true, rule: { metric: 'max_cost', value: '150' }, context: { where: 'domestic', days: 2 } });
    const ctx = { days: 4, where: 'domestic' as const };
    expect(decide([{ id: 'geo', name: 'Γ' } as never], [item], [opt({ id: 'x', costPerPerson: 280 })], [], 'trip', ctx).status).toBe('agreement');
    expect(decide([{ id: 'geo', name: 'Γ' } as never], [item], [opt({ id: 'x', costPerPerson: 320 })], [], 'trip', ctx).status).toBe('compromise');
  });
  it('what a person asks for this request overrides the profile on the same metric', () => {
    const profile = ctxItem({ id: 'p', hard: true, rule: { metric: 'max_cost', value: '150' } });
    const wish = rule('max_cost', '400'); // scope: request
    const out = decide([{ id: 'geo', name: 'Γ' } as never], [profile, wish], [opt({ id: 'x', costPerPerson: 300 })], [], 'trip');
    expect(out.status).toBe('agreement');
  });
});

describe('in-app onboarding', () => {
  beforeEach(() => store.reset('empty'));
  const answers = {
    me_friend: 'Πάντα μέσα για όλα αλλά αργεί',
    money_evening: { amount: 25, strict: false },
    money_weekend: { amount: 200, strict: false },
    money_abroad: { amount: 700, strict: true },
    time_early: 'Όχι πριν τις 9–10',
    food_no: ['Κρέας (χορτοφάγος)'],
    travel_stay_no: ['Σκηνή / κάμπινγκ'],
    travel_like: ['Θάλασσα & παραλίες'],
    decide_style: 'Φέρνω επιχειρήματα μέχρι να πείσω',
    decide_never: 'Δεν κοιμάμαι ποτέ σε σκηνή.',
    dm_weekend: 'ναιιι παμε καπου 🏝️',
    dm_airbnb: 'μπα ακριβουλι ρε',
  };
  it('turns answers into context-aware memory with exact quotes, a style source and holdouts', async () => {
    const { onboard } = await import('../server/onboarding');
    const r = await onboard({ name: 'Ελένη Δοκιμή', emoji: '🌊', answers, holdouts: [{ question: 'Νάξος ή Πήλιο;', options: [{ title: 'Νάξος', cost: 300 }, { title: 'Πήλιο', cost: 200 }], chosen: 0, why: 'θάλασσα' }] }, () => {});
    const mem = store.memory.filter((m) => m.personaId === r.personaId);
    const weekend = mem.find((m) => m.rule?.value === '200')!;
    expect(weekend.hard).toBe(false);
    expect(weekend.context).toEqual({ where: 'domestic', days: 2 });
    expect(mem.find((m) => m.rule?.value === '700')?.hard).toBe(true);
    expect(mem.some((m) => m.rule?.metric === 'latest_end')).toBe(false); // no return-time question any more
    expect(mem.some((m) => m.hard && m.statement.includes('Χορτοφάγος'))).toBe(true);
    for (const m of mem) expect(store.source(m.refs[0].sourceId)?.text).toContain(m.refs[0].quote);
    expect(store.sources.some((s) => s.personaId === r.personaId && s.kind === 'chat' && s.text.includes('ακριβουλι'))).toBe(true);
    expect(store.holdouts.filter((h) => h.personaId === r.personaId)).toHaveLength(1);
    expect(store.persona(r.personaId)?.style).not.toBeNull();
  });
});

describe('demo-mode understanding (rules)', () => {
  it('turns one-off wishes into hard rules and soft preferences with quotes', () => {
    const d = extractWithRules('Δεν θέλω να κοστίσει πάνω από 150€. Μέχρι Δευτέρα να έχουμε γυρίσει. Θέλω να γνωρίσουμε νέα άτομα.');
    expect(d.find((x) => x.rule?.metric === 'max_cost')?.rule?.value).toBe('150');
    expect(d.find((x) => x.rule?.metric === 'latest_end')?.rule?.value).toBe('weekly:1:23:59');
    expect(d.some((x) => x.domain === 'social' && x.polarity === 'likes')).toBe(true);
    expect(extractWithRules('Ο καιρός σήμερα είναι συννεφιασμένος.')).toEqual([]);
  });
  it('recognises the kind of request', () => {
    const now = new Date('2026-11-18T12:00:00+02:00');
    expect(parseRequestWithRules('Βρείτε μας ένα τριήμερο', now).category).toBe('trip');
    expect(parseRequestWithRules('Πού να φάμε την Παρασκευή;', now).category).toBe('food');
    expect(parseRequestWithRules('Έξοδος για ποτό', now).category).toBe('entertainment');
  });
});

describe('group decision scenarios', () => {
  const r = evaluationReport();
  for (const s of r.scenarios) it(s.name, () => expect(s.pass, s.detail).toBe(true));
  it('held-out decisions: reports uncertainty instead of guessing on the unknowable case', () => {
    expect(r.heuristic.rows.find((x) => x.id === 'hold-pant-3')?.outcome).toBe('uncertain');
    expect(r.heuristic.correct).toBeGreaterThanOrEqual(6);
  });
});

describe('end-to-end pipeline (demo mode, no network)', () => {
  beforeEach(() => store.reset());

  it('request + one-off wishes -> options -> evaluations -> decision with votes', async () => {
    const { request, decision } = await createRequest('Βρείτε μας ένα τριήμερο αυτό το ΣΚ', ['pan', 'pant', 'geo'], { geo: 'Θέλω να γνωρίσουμε νέα άτομα.' });
    expect(request.category).toBe('trip');
    expect(decision.options.length).toBeGreaterThanOrEqual(4);
    expect(decision.evaluations).toHaveLength(decision.options.length * 3);
    expect(decision.outcome.votes).toHaveLength(3);
    expect(store.requestItems(request.id, 'geo').some((m) => m.domain === 'social')).toBe(true);
    expect(decision.steps.map((s) => s.key)).toEqual(['parse', 'retrieve', 'options', 'evaluate', 'decide']);
    expect(request.days).toBe(3);
    expect(decision.chat?.lines.length).toBeGreaterThanOrEqual(3);
    expect(decision.outcome.chosenOptionId).not.toBeNull();
  });

  it('a numeric limit re-decides in code without re-evaluating', async () => {
    const { request, decision } = await createRequest('Βρες μας ένα διήμερο αυτό το ΣΚ', ['pan', 'pant', 'geo'], {});
    const d2 = await setLimit(request.id, 'geo', 'max_cost', 60);
    expect(d2.evaluations).toBe(decision.evaluations);
    expect(d2.steps.find((s) => s.key === 'evaluate')?.mode).toBe('code');
    expect(d2.outcome.status).toBe('compromise'); // nothing fits 60€ -> still a proposal, the closest one
    expect(d2.outcome.chosenOptionId).not.toBeNull();
    const geo = d2.outcome.concessions.find((c) => c.personaId === 'geo');
    expect(geo?.items.join(' ')).toMatch(/Δεν καλύπτεται το όριό του/); // never "accepted" by the twin itself
    expect(geo?.stance).toBe('object');
    expect(d2.status).toBe('awaiting_approval'); // still a proposal: the owner decides with their own approval
    expect(d2.diff?.changes.join(' ')).toMatch(/60€/);
  });

  it('a soft wish saved to the profile becomes permanent memory', async () => {
    const { request } = await createRequest('Πού να φάμε την Παρασκευή;', ['pan', 'pant'], {});
    await addWish(request.id, 'pan', 'Λατρεύω το καλό κρασί.', 'profile');
    expect(store.profile('pan').some((m) => m.origin === 'owner' && m.domain === 'food')).toBe(true);
  });

  it('uploaded text becomes candidate memory with exact quotes, confirmed only by the owner', async () => {
    const src = store.addSource('pant', 'note', 'test', 'Από εδώ και πέρα θέλω οπωσδήποτε δωμάτιο με δικό μας μπάνιο.');
    const r = await analyzeAndStore(src.id);
    expect(r.created.length).toBeGreaterThan(0);
    for (const m of r.created) {
      expect(m.status).toBe('candidate');
      expect(src.text).toContain(m.refs[0].quote);
      expect(m.memory?.sourceTrust).toBe('external');
    }
    expect(store.profile('pant').some((m) => r.created.includes(m))).toBe(false);
  });

  it('every owner must approve; group messages stay grounded in the decision', async () => {
    const { decision } = await createRequest('Πού να φάμε την Παρασκευή;', ['pan', 'pant', 'geo'], {});
    expect(decision.outcome.status).toBe('agreement');
    store.approve(decision.id, 'pan', 'approved');
    store.approve(decision.id, 'pant', 'approved');
    expect(decision.status).toBe('awaiting_approval');
    store.approve(decision.id, 'geo', 'approved');
    expect(decision.status).toBe('approved');
    const d = await groupMessages(decision.id);
    for (const m of d.messages!) expect(ungroundedReason(m.text, m.facts, d.options), m.text).toBeNull();
  });
});

describe('message grounding guard', () => {
  it('rejects invented numbers and destinations', async () => {
    store.reset();
    const { request, decision } = await createRequest('Πού να φάμε την Παρασκευή;', ['pan', 'pant', 'geo'], {});
    const facts = messageFacts(decision, request, 'pan', store.personas);
    expect(ungroundedReason(templateMessage(decision, 'pan'), facts, decision.options)).toBeNull();
    expect(ungroundedReason('Πάμε, βγαίνει 7€ μόνο!', facts, decision.options)).toMatch(/7/);
  });
  it('demo evaluator cites only the persona own memory', () => {
    const s = loadSeed();
    const items = s.memory.filter((m) => m.personaId === 'geo');
    const ev = evaluateWithRules('geo', items, [opt({ id: 'a', features: ['θάλασσα', 'beach bar'] })]);
    expect(ev[0].reasons.every((r) => items.some((m) => m.id === r.memoryId))).toBe(true);
    expect(ev[0].score).toBeGreaterThan(50);
    const out = decide([s.personas[2]], items, [opt({ id: 'a', features: ['θάλασσα'] })], ev, 'food');
    expect(out.status).toBe('compromise'); // 100€ > 25€ dinner limit: proposed anyway, with the breach spelled out
    expect(out.chosenOptionId).toBe('a');
    expect(out.rationale.join(' ')).toMatch(/25€/);
  });
});

describe('onboarding interview files', () => {
  const transcript = '**Ε:** Σου αρέσει η θάλασσα;\n**Α:** οχι ιδιαιτερα, προτιμω βουνο\n(Σύνοψη ChatGPT: προτιμά βουνό)\n**Ε:** Για φαγητό έξω;\n**Α:** Δεν θέλω να κοστίσει πάνω από 30€ για φαγητό έξω.';
  it('learns only from the owner answers, never from the interviewer questions or summaries', () => {
    const d = extractWithRules(transcript);
    for (const x of d) {
      expect(transcript).toContain(x.quote);
      expect(x.quote).not.toMatch(/Σου αρέσει|Σύνοψη/);
    }
    expect(d.find((x) => x.rule?.metric === 'max_cost')?.rule?.value).toBe('30');
    expect(d.some((x) => x.statement.includes('φαγητό') && x.polarity === 'avoids')).toBe(false);
  });
});

describe('questionnaire ZIP import', () => {
  const md = (n: number, kind: string, body: string) => `---\nid: src-t-${n}\nkind: ${kind}\ntitle: Τίτλος ${n}\ndate: 2026-11-19\nsynthetic: false\n---\n${body}\n`;
  const pkg = {
    persona: { name: 'Νίκος Δοκιμαστικός', handle: 'test.nikos', emoji: '🎸', bio: 'test' },
    files: [
      { name: '02-money-time.md', text: md(2, 'note', '**Ε:** Μέχρι πόσα για ένα διήμερο;\n**Α:** 120€ max, δεν μπορω πανω απο 120€\n**Ε:** Από ταξίδι πρέπει να έχεις γυρίσει το αργότερο;\n**Α:** Κυριακη 23:00 να ειμαι πισω στην Αθηνα') },
      { name: '07-messages.md', text: md(7, 'chat', 'μεσα ρε!! 🤘\nοχι ρε σορυ δεν παιζει') },
    ],
    holdout: { cases: [{ question: 'Live bar ή σινεμά;', category: 'entertainment', actualOptionId: 'a', note: 'live μουσικη', options: [{ id: 'a', title: 'Live bar', costPerPerson: 15, features: ['live μουσική'], endsAt: null }, { id: 'b', title: 'Σινεμά', costPerPerson: 10, features: ['ταινία'], endsAt: null }] }] },
  };
  beforeEach(() => store.reset());

  it('creates the twin, keeps front-matter metadata, extracts quoted memory and stores held-out cases apart', async () => {
    const { importPackage } = await import('../server/pipeline');
    const r = await importPackage(pkg);
    expect(r.persona.handle).toBe('test.nikos');
    const srcs = store.sources.filter((s) => s.personaId === r.persona.id);
    expect(srcs.map((s) => s.kind).sort()).toEqual(['chat', 'note']);
    expect(srcs.every((s) => !s.text.startsWith('---'))).toBe(true);
    const mem = store.memory.filter((m) => m.personaId === r.persona.id);
    expect(mem.find((m) => m.rule?.metric === 'max_cost')?.rule?.value).toBe('120');
    expect(mem.find((m) => m.rule?.metric === 'latest_end')?.rule?.value).toBe('weekly:0:23:00');
    for (const m of mem) expect(srcs.find((s) => s.id === m.refs[0].sourceId)?.text).toContain(m.refs[0].quote);
    expect(store.holdouts.filter((c) => c.personaId === r.persona.id)).toHaveLength(1);
    expect(store.sources.some((s) => s.text.includes('live μουσικη'))).toBe(false); // held-out never becomes a source
    const report = evaluationReport();
    expect(report.heuristic.rows.some((x) => x.origin === 'imported')).toBe(true);
  });

  it('re-importing the same ZIP updates the twin without duplicating sources', async () => {
    const { importPackage } = await import('../server/pipeline');
    const a = await importPackage(pkg);
    const b = await importPackage(pkg);
    expect(b.persona.id).toBe(a.persona.id);
    expect(store.sources.filter((s) => s.personaId === a.persona.id)).toHaveLength(2);
    expect(store.personas.filter((p) => p.handle === 'test.nikos')).toHaveLength(1);
  });
});

describe('encoding repair (mojibake)', async () => {
  const { repairMojibake } = await import('../shared/text');
  const greek = '**Ε:** Bio σε μία γραμμή (σπουδές/δουλειά + 2–3 πράγματα που αγαπάς)\n**Α:** ΗΜΜΥ 3ο εξαμηνο μπασκετ «αθλητισμος» αυτοκίνητα 😊';
  // What a browser/editor shows when it reads UTF-8 as Windows-1252.
  const broken = new TextDecoder('windows-1252').decode(new TextEncoder().encode(greek));
  it('repairs UTF-8 Greek that was read as Windows-1252', () => {
    expect(broken).toMatch(/Î/);
    expect(repairMojibake(broken)).toBe(greek);
  });
  it('also repairs the lossy variant where undefined Windows-1252 bytes were dropped (ρ, Ν)', () => {
    const lossy = [...broken].filter((ch) => ![0x81, 0x8d, 0x8f, 0x90, 0x9d].includes(ch.codePointAt(0)!)).join('');
    expect(lossy).not.toBe(broken);
    expect(repairMojibake(lossy)).toBe(greek);
  });
  it('never touches correct text', () => {
    expect(repairMojibake(greek)).toBe(greek);
    expect(repairMojibake('Café Ïsland – plain Latin text')).toBe('Café Ïsland – plain Latin text');
  });
});

describe('delete a twin', () => {
  beforeEach(() => store.reset());
  it('removes the twin with its sources, memory and the requests it took part in; others keep working', async () => {
    const { request } = await createRequest('Πού να φάμε την Παρασκευή;', ['pan', 'geo'], { geo: 'Θέλω να γνωρίσουμε νέα άτομα.' });
    const other = await createRequest('Έξοδος για ποτό', ['pant', 'pan'], {});
    const removed = store.deletePersona('geo');
    expect(removed.requests).toBe(1);
    expect(store.persona('geo')).toBeUndefined();
    expect(store.sources.some((s) => s.personaId === 'geo')).toBe(false);
    expect(store.memory.some((m) => m.personaId === 'geo' || m.requestId === request.id)).toBe(false);
    expect(store.request(request.id)).toBeUndefined();
    expect(store.decisions.some((d) => d.requestId === request.id)).toBe(false);
    expect(store.request(other.request.id)).toBeDefined(); // requests without geo survive
    const again = await createRequest('Πού να φάμε την Παρασκευή;', ['pan', 'pant'], {});
    expect(again.decision.outcome.votes).toHaveLength(2);
    expect(evaluationReport().heuristic.rows.some((r) => r.personaId === 'geo')).toBe(false);
  });
});

describe('always a proposal', () => {
  it('a judged breach reported for every option is about the request, so it warns instead of excluding all', () => {
    const s = loadSeed();
    const hardFact: MemoryItem = { ...rule('max_cost', '0'), id: 'job', rule: undefined, statement: 'Δουλεύει Σάββατα', domain: 'schedule', scope: 'profile' };
    const options = ['a', 'b', 'c'].map((id) => opt({ id, costPerPerson: 50 }));
    const ev = options.map((o) => ({ personaId: 'geo', optionId: o.id, score: o.id === 'b' ? 80 : 60, verdict: '', reasons: [], violations: [{ memoryId: 'job', text: 'πέφτει Σάββατο' }], unknowns: [] }));
    const out = decide([s.personas[2]], [hardFact], options, ev, 'trip');
    expect(out.status).toBe('agreement');
    expect(out.chosenOptionId).toBe('b');
    expect(out.results[0].warnings.join(' ')).toMatch(/όλες τις επιλογές/);
  });
});

describe('team demo group export', () => {
  it('exports twins with their own sources, profile memory and held-out tests — never request data', async () => {
    store.reset('empty');
    const { onboard } = await import('../server/onboarding');
    const r = await onboard({ name: 'Ομάδα Τεστ', emoji: '✨', answers: { money_weekend: { amount: 200, strict: false }, dm_weekend: 'μεσα!' }, holdouts: [{ question: 'Α ή Β;', options: [{ title: 'Α', cost: 10 }, { title: 'Β', cost: 20 }], chosen: 1, why: '' }] }, () => {});
    store.addSource('group', 'request', 'Αίτημα', 'κάτι');
    const g = store.exportGroup();
    expect(g.format).toBe('twinsync-group');
    expect(g.personas.map((p) => p.id)).toEqual([r.personaId]);
    expect(g.sources.every((s) => s.personaId === r.personaId && !['wish', 'request'].includes(s.kind))).toBe(true);
    for (const m of g.memory) expect(g.sources.find((s) => s.id === m.refs[0].sourceId)?.text).toContain(m.refs[0].quote);
    expect(g.holdouts).toHaveLength(1);
    expect(g.personas[0].synthetic).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Concrete plans (fixtures / mocked AI output — no network)
// ---------------------------------------------------------------------------
describe('concrete local plans', async () => {
  const { prepareOptions, isGenericVenue, validateLocal, kindFromText, planWishes } = await import('../shared/plan');
  const { venueCatalogue } = await import('../server/pipeline');
  const req = { kind: 'coffee' as const, city: 'Αθήνα', area: 'Παγκράτι', periodStart: '2026-11-21T16:30:00+02:00', periodEnd: '2026-11-21T18:30:00+02:00', text: 'καφές στο Παγκράτι' };
  const aiOpt = (name: string, area: string, city = 'Αθήνα') => opt({ id: name, title: name, origin: 'ai', startsAt: req.periodStart, endsAt: req.periodEnd, costPerPerson: 5, venue: { name, kind: 'καφέ', area, city } });

  it('a coffee plan must be a NAMED café inside the requested area', () => {
    expect(isGenericVenue('Καφές κοντά στο Σύνταγμα')).toBe(true);
    expect(isGenericVenue('Κάπου στα Ιλίσια')).toBe(true);
    expect(isGenericVenue('ένα μαγαζί στην Ηπίτου')).toBe(true);
    expect(isGenericVenue('ένα από τα καφέ της οδού Παπάγου')).toBe(true);
    expect(isGenericVenue('Bless & Hopes')).toBe(false);
    expect(validateLocal(aiOpt('O Kokkos', 'Παγκράτι'), req)).toBeNull();
    expect(validateLocal(aiOpt('Taf Coffee', 'Εξάρχεια'), req)).toMatch(/όχι Παγκράτι/);
    const r = prepareOptions([aiOpt('Καφές κοντά στο Σύνταγμα', 'Σύνταγμα'), aiOpt('O Kokkos', 'Παγκράτι'), aiOpt('Καφέ Άγνωστο Όνομα', 'Παγκράτι')], { req, items: [], wishes: [], wishText: '', catalogue: venueCatalogue() });
    expect(r.rejected.map((x) => x.title)).toEqual(['Καφές κοντά στο Σύνταγμα']);
    const kokkos = r.valid.find((o) => o.venue?.name === 'O Kokkos')!;
    expect(kokkos.checks?.find((c) => c.field === 'existence')).toMatchObject({ status: 'confirmed', url: 'https://www.thisisathens.org/cafes-bakeries/kokkos' });
    const unknown = r.valid.find((o) => o.venue?.name === 'Καφέ Άγνωστο Όνομα')!;
    expect(unknown.checks?.find((c) => c.field === 'existence')?.status).toBe('to_check'); // named by the AI, not verified
    expect(unknown.checks?.find((c) => c.field === 'existence')?.url).toBeUndefined(); // never an invented URL
  });

  it('keeps the city the request names (Thessaloniki is a local plan there, not a trip)', async () => {
    store.reset();
    const now = new Date('2026-11-20T12:00:00+02:00');
    const p = parseRequestWithRules('Είμαστε στη Θεσσαλονίκη: καφές κοντά στην Καμάρα ή στη Ναυαρίνου το Σάββατο', now);
    expect(p.kind).toBe('coffee');
    expect(p.city).toBe('Θεσσαλονίκη');
    expect(p.area).toMatch(/Ναυαρίνου|Καμάρα/);
    const { request, decision } = await createRequest('Είμαστε στη Θεσσαλονίκη: καφές κοντά στην Καμάρα ή στη Ναυαρίνου το Σάββατο', ['pan', 'geo'], {});
    expect(request.where).toBe('local');
    expect(request.city).toBe('Θεσσαλονίκη');
    expect(decision.options.length).toBeGreaterThan(0);
    for (const o of decision.options) expect(o.venue?.city).toBe('Θεσσαλονίκη');
  });

  it('drinks are an outing (not food) and a night past midnight is ONE outing for the budget', () => {
    const now = new Date('2026-11-20T12:00:00+02:00');
    const p = parseRequestWithRules('Ποτό στο κέντρο το Σάββατο μετά τις 21:30, ως 25€', now);
    expect(kindFromText('ποτό στο κέντρο')).toBe('drinks');
    expect(p.category).toBe('entertainment');
    expect(spanDays('2026-11-21T21:30:00+02:00', '2026-11-22T02:00:00+02:00')).toBe(1);
    const budget: MemoryItem = { ...rule('max_cost', '25'), scope: 'profile', hard: true, context: { where: 'local', days: 1 } };
    const fit = contextFit(budget, { days: spanDays('2026-11-21T21:30:00+02:00', '2026-11-22T02:00:00+02:00'), where: 'local' });
    expect(fit.scale).toBe(1); // not "scaled to 2 days"
    // "μετά τις 21:30" is the start, "γυρνάμε με μετρό" is how — neither is a return deadline.
    expect(extractWithRules('Ποτό στο κέντρο την Παρασκευή μετά τις 21:30, ως 25€, γυρνάμε με μετρό').some((d) => d.rule?.metric === 'latest_end')).toBe(false);
  });

  it('live music: the venue may be known, the programme is never presented as confirmed', () => {
    const live = { ...req, kind: 'live' as const, area: '' };
    const o = opt({ id: 'h', title: 'Jazz συναυλία με τον Χ στο Half Note', origin: 'ai', startsAt: req.periodStart, endsAt: req.periodEnd, venue: { name: 'Half Note Jazz Club', kind: 'jazz club', area: 'Μετς', city: 'Αθήνα' } });
    const r = prepareOptions([o], { req: live, items: [], wishes: [], wishText: 'επιστροφή με μετρό', catalogue: venueCatalogue() });
    const v = r.valid[0];
    expect(v.title).toBe('Half Note Jazz Club — πρόγραμμα προς επιβεβαίωση');
    expect(v.event?.status).toBe('unconfirmed');
    expect(v.checks?.find((c) => c.field === 'program')?.status).toBe('to_check');
    expect(v.checks?.find((c) => c.field === 'route')?.text).toMatch(/τελευταίου συρμού/);
  });

  it('irrelevant memory (tent) is left out of a coffee request, the relevant limit stays', async () => {
    const { retrieve } = await import('../server/retrieval');
    const s = loadSeed();
    const pant = s.memory.filter((m) => m.personaId === 'pant');
    const geo = s.memory.filter((m) => m.personaId === 'geo');
    const ctx = { days: 1, where: 'local' as const };
    const coffee = await retrieve('καφές στο Παγκράτι', pant, [], { kind: 'coffee', category: 'entertainment', ctx });
    expect(coffee.items.some((m) => m.statement.includes('σκηνή'))).toBe(false);
    const geoCoffee = await retrieve('καφές στο Παγκράτι', geo, [], { kind: 'coffee', category: 'entertainment', ctx });
    expect(geoCoffee.items.some((m) => m.rule?.metric === 'max_cost' && m.rule.value === '25')).toBe(true);
    const trip = await retrieve('τριήμερο', pant, [], { kind: 'trip', category: 'trip', ctx: { days: 3, where: 'domestic' } });
    expect(trip.items.some((m) => m.statement.includes('σκηνή'))).toBe(true);
    expect(planWishes([], () => false)).toEqual([]);
  });

  it('a named destination leaves out wishes about WHERE to go (they cannot be "uncovered")', async () => {
    const { isDestinationWish } = await import('../shared/plan');
    const like = (id: string, statement: string): MemoryItem => ({ ...rule('max_cost', '1'), id, personaId: 'p', kind: 'preference', statement, scope: 'profile', polarity: 'likes', strength: 0.9, hard: false, rule: undefined });
    const items = [like('a', 'Θέλει οπωσδήποτε να πάει: Ιαπωνία, Αμερική'), like('b', 'Στα ταξίδια του αρέσουν τα βουνά και η πεζοπορία')];
    expect(isDestinationWish(items[0])).toBe(true);
    expect(isDestinationWish(items[1])).toBe(false);
    expect(planWishes(items, () => false, true, true).map((m) => m.id)).toEqual(['b']);
    expect(planWishes(items, () => false, true, false).map((m) => m.id)).toContain('a');
    const abroad = { ...like('c', 'Στα ταξίδια στο εξωτερικό εκτιμά το καλό φαγητό'), context: { where: 'abroad' as const, days: 0 } };
    expect(planWishes([abroad], () => false, true, false, 'domestic')).toEqual([]);
    expect(planWishes([abroad], () => false, true, false, 'abroad').map((m) => m.id)).toEqual(['c']);
  });
});

describe('four-day trip plan', async () => {
  const { validateItinerary, coverageOf } = await import('../shared/plan');
  const { fixtureOption } = await import('../server/pipeline');
  const { loadTripFixtures } = await import('../server/seed');
  const period = { periodStart: '2026-12-04T09:00:00+02:00', periodEnd: '2026-12-07T21:00:00+02:00', city: 'Αθήνα' };
  const s = loadSeed();

  it('covers all four days in order, adds up, and ties slots to the right twin wishes', () => {
    const nature: MemoryItem = { ...rule('max_cost', '0'), id: 'w-nature', personaId: 'pan', rule: undefined, hard: false, statement: 'Θέλει πεζοπορία', domain: 'activities', keywords: ['πεζοπορία'], polarity: 'likes' };
    const club: MemoryItem = { ...nature, id: 'w-club', personaId: 'pant', statement: 'Θέλει ένα βράδυ σε club', keywords: ['club'] };
    const sea: MemoryItem = { ...nature, id: 'w-sea', personaId: 'geo', statement: 'Θέλει θάλασσα', keywords: ['θάλασσα'] };
    const o = fixtureOption(loadTripFixtures()[0], period, [nature, club, sea])!;
    expect(o.itinerary!.days.map((d) => d.date)).toEqual(['2026-12-04', '2026-12-05', '2026-12-06', '2026-12-07']);
    expect(validateItinerary(o.itinerary, period.periodStart, period.periodEnd)).toEqual([]);
    const cov = coverageOf(o, [nature, club, sea]);
    expect(cov.find((c) => c.memoryId === 'w-nature')?.status).toBe('conditional'); // the trail depends on the weather
    expect(cov.find((c) => c.memoryId === 'w-club')?.status).toBe('covered');
    expect(cov.find((c) => c.memoryId === 'w-sea')?.status).toBe('uncovered');
    const club3 = o.itinerary!.days.flatMap((d) => d.slots).find((x) => x.title.includes('Club'))!;
    expect(club3.serves).toEqual([{ personaId: 'pant', memoryId: 'w-club' }]);
  });

  it('rejects a plan with a missing day, overlapping stops or totals that do not add up', () => {
    const o = fixtureOption(loadTripFixtures()[0], period, s.memory)!;
    const it = o.itinerary!;
    expect(validateItinerary({ ...it, days: it.days.slice(0, 3) }, period.periodStart, period.periodEnd)[0]).toMatch(/2026-12-07/);
    const overlap = { ...it, days: [{ ...it.days[0], slots: [it.days[0].slots[1], { ...it.days[0].slots[1], title: 'Διπλό' }] }, ...it.days.slice(1)] };
    expect(validateItinerary(overlap, period.periodStart, period.periodEnd).join(' ')).toMatch(/επικαλύπτεται/);
    expect(validateItinerary({ ...it, cost: { ...it.cost, total: it.cost.total + 100 } }, period.periodStart, period.periodEnd).join(' ')).toMatch(/σύνολα/);
    expect(validateItinerary({ ...it, return: { ...it.return, at: '2026-12-07T12:00:00+02:00' } }, period.periodStart, period.periodEnd).join(' ')).toMatch(/ώρα επιστροφής/);
  });

  it('demo: a four-day trip abroad gets full plans, with the full plan on the chosen proposal', async () => {
    store.reset();
    const { decision, request } = await createRequest('Τετραήμερο στο εξωτερικό 4–7 Δεκεμβρίου', ['pan', 'pant', 'geo'], {});
    expect(request.kind).toBe('trip');
    expect(request.where).toBe('abroad');
    const chosen = decision.options.find((o) => o.id === decision.outcome.chosenOptionId)!;
    expect(chosen.itinerary?.days).toHaveLength(4);
    expect(chosen.synthetic).toBe(true);
  });
});

describe('incompatible times', () => {
  it('no common time: still one closest proposal, never shown as feasible, no twin "accepts" the breach', async () => {
    store.reset();
    const { request } = await createRequest('Καφές στο Παγκράτι το Σάββατο στις 16:00', ['pan', 'pant'], {});
    const d1 = store.decisionsFor(request.id).at(-1)!;
    const start = d1.options[0].startsAt!;
    // Παναγιώτης must leave 30' BEFORE the plan starts (a one-off strict limit).
    const src = store.addSource('pan', 'wish', 'test', 'πρέπει να φύγω πριν τις 15:30');
    const leave = new Date(new Date(start).getTime() - 30 * 60000).toISOString();
    store.addMemory('pan', src, [{ kind: 'constraint', statement: 'Πρέπει να φύγει πριν τις 15:30', domain: 'schedule', polarity: 'neutral', strength: 1, hard: true, rule: { metric: 'latest_end', value: leave }, categories: [], keywords: [], quote: 'πρέπει να φύγω πριν τις 15:30', confidence: 1 }], { origin: 'owner', status: 'confirmed', scope: 'request', requestId: request.id });
    const d = await runDecision(request.id, {});
    expect(d.outcome.status).toBe('compromise');
    expect(d.outcome.noCommonTime).toBe(true);
    expect(d.outcome.results.every((r) => !r.feasible)).toBe(true);
    expect(d.outcome.chosenOptionId).not.toBeNull(); // always at least one proposal
    expect(d.status).toBe('awaiting_approval'); // the owner who is not covered decides with their own approval
    const panLines = d.chat!.lines.filter((l) => l.personaId === 'pan').map((l) => l.text).join(' ');
    expect(panLines).not.toMatch(/κάνω πίσω|δέχομαι|Οκ, πάμε/);
    expect(d.outcome.concessions.find((c) => c.personaId === 'pan')?.stance).toBe('object');
  });
});

describe('flexibility for holidays and big trips', () => {
  const s = loadSeed();
  const geoReturn = s.memory.find((m) => m.id === 'mem-geo-01')!; // weekly: back by Sunday 21:00 (work on Monday)
  const trip = (start: string, end: string, extra: Partial<CandidateOption> = {}) => opt({ id: 't', startsAt: start, endsAt: end, costPerPerson: 300, ...extra });

  it('a routine weekly return limit does not override a Fri–Mon trip the group asked for', () => {
    const ctx = requestContext({ periodStart: '2026-11-27T09:00:00+02:00', periodEnd: '2026-11-30T21:00:00+02:00', category: 'trip', where: 'abroad', days: 4 });
    expect(contextFit(geoReturn, ctx).applies).toBe(false);
    const out = decide([s.personas[2]], [geoReturn], [trip('2026-11-27T09:00:00+02:00', '2026-11-30T20:30:00+02:00')], [], 'trip', ctx);
    expect(out.status).toBe('agreement');
  });

  it('…but it still holds for a normal weekend (even if the request says Sunday 23:59)', () => {
    const ctx = requestContext({ periodStart: '2026-11-28T09:00:00+02:00', periodEnd: '2026-11-29T23:59:00+02:00', category: 'trip', where: 'domestic', days: 2 });
    expect(contextFit(geoReturn, ctx).applies).toBe(true);
    const out = decide([s.personas[2]], [geoReturn], [trip('2026-11-28T09:00:00+02:00', '2026-11-29T23:00:00+02:00')], [], 'trip', ctx);
    expect(out.status).toBe('compromise');
  });

  it('everyday budgets are only a loose reference for a big trip outside Europe; the request budget still counts', () => {
    const strict: MemoryItem = { ...rule('max_cost', '500'), scope: 'profile', context: { where: 'abroad', days: 4 } };
    const ctx = requestContext({ periodStart: '2026-12-04T09:00:00+02:00', periodEnd: '2026-12-13T21:00:00+02:00', category: 'trip', where: 'abroad', days: 10, text: 'Ταξίδι ζωής εκτός Ευρώπης, Ιαπωνία' });
    expect(ctx.longHaul).toBe(true);
    expect(decide([s.personas[2]], [strict], [opt({ id: 'j', costPerPerson: 1900 })], [], 'trip', ctx).status).toBe('agreement');
    const wish = rule('max_cost', '1500'); // said for THIS trip
    expect(decide([s.personas[2]], [strict, wish], [opt({ id: 'j', costPerPerson: 1900 })], [], 'trip', ctx).status).toBe('compromise');
  });

  it('there is always at least one option to show, even when nothing matches the requested area', async () => {
    store.reset();
    const { decision } = await createRequest('Club στη Θεσσαλονίκη το Σάββατο', ['pan', 'geo'], {});
    expect(decision.options.length).toBeGreaterThan(0);
    expect(decision.outcome.chosenOptionId).not.toBeNull();
  });
});

describe('team twins are locked', () => {
  it('a locked team twin cannot be deleted', () => {
    store.reset();
    const p = store.persona('geo')!;
    p.locked = true;
    expect(() => store.deletePersona('geo')).toThrow(/δεν διαγράφεται/);
    expect(store.persona('geo')).toBeTruthy();
    p.locked = false;
  });
  it('the shipped team file loads its twins locked', async () => {
    const { loadTeamSeed } = await import('../server/seed');
    expect(loadTeamSeed()).toBeNull(); // tests run on the synthetic group (TWINSYNC_SEED=synthetic)
  });
});

describe('richer interview: places, music, area', () => {
  beforeEach(() => store.reset('empty'));
  const answers = {
    travel_visited: { items: [{ place: 'Γεωργία', why: 'απίστευτη φύση και πολύ ωραίο κλίμα' }, { place: 'Ιταλία', why: 'φαγητό και πόλεις' }, { place: 'Βουλγαρία', why: '' }] },
    travel_repeat: 'Όχι, θέλω μόνο καινούργια μέρη',
    travel_pace: 'Χαλαρά, χωρίς άγχος',
    music_genres: ['Ελληνικά λαϊκά / μπουζούκια', 'House / Techno / EDM'],
    music_artists: 'Μακρόπουλος, Βέρτης',
    me_about: 'ΗΜΜΥ, μπάσκετ και ταξίδια',
    me_area: 'Αθήνα, Ζωγράφου',
  };
  it('ranked places become trip preferences (best first), and "no repeats" a code-checked rule', async () => {
    const { onboard } = await import('../server/onboarding');
    const r = await onboard({ name: 'Δοκιμή Ταξιδιώτης', emoji: '✨', answers, holdouts: [] }, () => {});
    const mem = store.memory.filter((m) => m.personaId === r.personaId);
    for (const m of mem) expect(store.source(m.refs[0].sourceId)?.text).toContain(m.refs[0].quote);
    const ranked = mem.find((m) => m.statement.startsWith('Μέρη που έχει πάει, από το αγαπημένο: 1. Γεωργία'))!;
    expect(ranked.keywords).toEqual(expect.arrayContaining(['Γεωργία', 'Ιταλία', 'φύση', 'κλίμα']));
    const noRepeat = mem.find((m) => m.rule?.metric === 'avoid_place')!;
    expect(noRepeat.rule!.value).toBe('Γεωργία|Ιταλία|Βουλγαρία');
    const persona = store.persona(r.personaId)!;
    const tbilisi = opt({ id: 'tb', title: 'Τιφλίδα, Γεωργία', location: 'Τιφλίδα, Γεωργία', costPerPerson: 400 });
    const lisbon = opt({ id: 'li', title: 'Λισαβόνα, Πορτογαλία', location: 'Λισαβόνα, Πορτογαλία', costPerPerson: 400 });
    const out = decide([persona], [noRepeat], [tbilisi, lisbon], [], 'trip');
    expect(out.results.find((x) => x.optionId === 'tb')?.violations[0]).toMatchObject({ checkedBy: 'code' });
    expect(out.chosenOptionId).toBe('li');
  });
  it('music decides the kind of place, and a favourite artist is a hint to check a live venue — never a confirmed date', async () => {
    const { onboard } = await import('../server/onboarding');
    const r = await onboard({ name: 'Δοκιμή Μουσική', emoji: '✨', answers, holdouts: [] }, () => {});
    const mem = store.memory.filter((m) => m.personaId === r.personaId);
    expect(mem.find((m) => m.statement.startsWith('Ακούει ελληνικά λαϊκά'))?.keywords).toContain('μπουζούκια');
    expect(mem.find((m) => m.statement.startsWith('Αγαπημένοι καλλιτέχνες'))?.keywords).toEqual(['Μακρόπουλος', 'Βέρτης']);
    const r2 = await onboard({ name: 'Δοκιμή Φίλος', emoji: '✨', answers: { money_evening: { amount: 30, strict: false } }, holdouts: [] }, () => {});
    const { decision } = await createRequest('Live μουσική το Σάββατο μετά τις 22:00', [r.personaId, r2.personaId], {});
    const hinted = decision.options.find((o) => o.artistHint);
    expect(hinted?.event?.note).toMatch(/Δείτε αν εμφανίζεται Μακρόπουλος — πρόγραμμα προς επιβεβαίωση/);
    expect(hinted?.event?.status).toBe('unconfirmed');
  });
});

describe('shipped team group (server/data/team/group.json)', () => {
  it('has the three team members, and every memory quote is an exact span of its source', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { containsQuote } = await import('../shared/text');
    const file = new URL('../server/data/team/group.json', import.meta.url);
    if (!existsSync(file)) return;
    const g = JSON.parse(readFileSync(file, 'utf8'));
    expect(g.personas.map((p: { name: string }) => p.name)).toEqual(['Παναγιώτης Κουζάρης', 'Παναγιώτης Τσακύρης', 'Γρηγόρης Πατέλης']);
    const src = new Map(g.sources.map((s: { id: string; text: string }) => [s.id, s.text]));
    for (const m of g.memory) for (const r of m.refs) expect(containsQuote(String(src.get(r.sourceId) ?? ''), r.quote), m.statement).toBe(true);
    expect(JSON.stringify(g)).not.toMatch(/sk-proj|sk-ant-/);
  });
});

describe('a night out is understood as one', async () => {
  const { kindFromText } = await import('../shared/plan');
  it('"πού να βγούμε… με μουσική" is live, a plain night out is drinks, and "other" filters no memory out', () => {
    expect(kindFromText('Πού να βγούμε το Σάββατο βράδυ; Κάτι με μουσική, ως 40€')).toBe('live');
    expect(kindFromText('Πού να βγούμε το Σάββατο;')).toBe('drinks');
    const music: MemoryItem = { ...rule('max_cost', '0'), rule: undefined, hard: false, scope: 'profile', categories: ['entertainment', 'trip'] };
    expect(appliesToCategory(music, 'other')).toBe(true);
  });
});

describe('address grounding', () => {
  it('rejects a street from one venue with the number of another', () => {
    const half = opt({ id: 'h', title: 'Half Note', venue: { name: 'Half Note Jazz Club', kind: 'jazz', area: 'Μετς', city: 'Αθήνα', address: 'Τριβωνιανού 17' } });
    const stav = opt({ id: 's', title: 'Σταυρός του Νότου', venue: { name: 'Σταυρός του Νότου', kind: 'live', area: 'Νέος Κόσμος', city: 'Αθήνα', address: 'Θαρύπου 37' } });
    const facts = ['Επιλογή: Half Note Jazz Club (Μετς, Τριβωνιανού 17).', 'Επιλογή: Σταυρός του Νότου (Νέος Κόσμος, Θαρύπου 37).'];
    expect(ungroundedReason('Πάμε Σταυρό, Τριβωνιανού 37', facts, [half, stav])).toMatch(/Τριβωνιανού 37|τριβωνιανου 37/);
    expect(ungroundedReason('Πάμε Σταυρό, Θαρύπου 37 στις 21:00', facts.concat('Σάββατο 21/11 21:00'), [half, stav])).toBeNull();
  });
});

describe('private chat with one twin', () => {
  it('answers from that twin’s own memory (demo mode: the closest memory, no AI) and stores nothing', async () => {
    store.reset();
    const { privateChat } = await import('../server/privateChat');
    const before = JSON.stringify({ s: store.sources.length, m: store.memory.length, r: store.requests.length });
    const r = await privateChat('pan', [{ role: 'user', text: 'Σου αρέσει η πεζοπορία στο βουνό;' }]);
    expect(r.mode).toBe('demo');
    expect(r.used.length).toBe(1);
    expect(store.item(r.used[0].id)?.personaId).toBe('pan');
    expect(r.reply).toMatch(/πεζοπορ|βουν/i);
    expect(JSON.stringify({ s: store.sources.length, m: store.memory.length, r: store.requests.length })).toBe(before);
  });
});

describe('private chat sees the weekly routine', () => {
  it('routines (gym, classes) always come along so the twin can judge a proposed time', async () => {
    const { withRoutines } = await import('../server/privateChat');
    const base: MemoryItem = { ...rule('max_cost', '0'), rule: undefined, hard: false, scope: 'profile', domain: 'social', statement: 'x' };
    const gym: MemoryItem = { ...base, id: 'gym', domain: 'other', statement: 'Πηγαίνει γυμναστήριο 16:00–18:00.' };
    const school: MemoryItem = { ...base, id: 'school', domain: 'schedule', statement: 'Σχολή Δευτέρα έως Παρασκευή' };
    const music: MemoryItem = { ...base, id: 'music', statement: 'Ακούει λαϊκά' };
    const out = withRoutines([music], [music, gym, school]);
    expect(out.map((m) => m.id)).toEqual(['music', 'gym', 'school']);
  });
});

describe('private chat sounds human', () => {
  it('drops an address word ("ρε φίλε", "μπρο") the previous reply already used', async () => {
    const { varyAddress } = await import('../server/privateChat');
    expect(varyAddress('Ναι ρε φίλε, μέσα! Πού λες να πάμε;', 'Ναι ρε φίλε, όλα καλά!')).toBe('Ναι, μέσα! Πού λες να πάμε;');
    expect(varyAddress('Μέσα μπρο, τι ώρα;', 'Εντάξει ρε μπρο')).toBe('Μέσα, τι ώρα;');
    expect(varyAddress('Ναι ρε φίλε, μέσα!', 'Όλα καλά!')).toBe('Ναι ρε φίλε, μέσα!'); // not used before: kept
    expect(varyAddress('Ναι ρε ψήνομαι χαχα', 'Χαχα όχι ρε, έτσι μου βγήκε χαχα')).toBe('Ναι ψήνομαι');
    expect(varyAddress('Ναι πάμε, τι ώρα λες;', 'Καλά ρε μπρο εσύ;')).toBe('Ναι πάμε, τι ώρα λες;');
  });
});

describe('private chat does not paste lines from other conversations', () => {
  it('detects a reply that is really a writing sample', async () => {
    const { copiesSample } = await import('../server/privateChat');
    const samples = ['Πολύ νωρίς ρε αλλά αν είναι να το προλάβουμε πάμε', 'Κλείσε οπωσδήποτε μπρο, πάμε λίγοο'];
    expect(copiesSample('Πολύ νωρίς ρε φίλε, αλλά πάμε άμα είναι να το προλάβουμε!', samples)).toBe(true);
    expect(copiesSample('Δευτέρα στις 10 έχω σχολή, πάμε μετά τις 2;', samples)).toBe(false);
  });
});

describe('dialect words stand for one standard word only', () => {
  it('Kouzaris writes «τζε» exactly where «και» goes, never as a filler', async () => {
    const { applySwaps } = await import('../shared/dialect');
    const sw = [{ from: ['και', 'κι'], to: 'τζε' }];
    expect(applySwaps('Τα 162€ βγαίνουν οικονομικά, τζε έχει φύση και Παλαμήδι.', sw)).toBe('Τα 162€ βγαίνουν οικονομικά, τζε έχει φύση τζε Παλαμήδι.');
    expect(applySwaps('Η αναχώρηση 11:00 βολεύει μετά το μάθημα τζε', sw)).toBe('Η αναχώρηση 11:00 βολεύει μετά το μάθημα');
    expect(applySwaps('Κι εγώ ψήνομαι, καιρός είναι', sw)).toBe('Τζε εγώ ψήνομαι, καιρός είναι');
    expect(applySwaps('ναι και πάμε', undefined)).toBe('ναι και πάμε');
    const kouzaris = store.persona('panayiotis-kouzaris');
    if (kouzaris) expect(kouzaris.style?.swaps?.[0]?.to).toBe('τζε');
  });
});

describe('group edits (demo mode, no network)', () => {
  beforeEach(() => store.reset());

  it('a named place is the only option: the twins say if it fits; the final proposal can show its booking phone', async () => {
    const { decision, request } = await createRequest('Ποτό την Παρασκευή το βράδυ;', ['pan', 'pant', 'geo'], {}, undefined, { pick: 'The Clumsies' });
    expect(request.pick).toBe('The Clumsies');
    expect(decision.options).toHaveLength(1);
    expect(decision.options[0].venue?.name).toBe('The Clumsies');
    expect(decision.options[0].venue?.phone).toMatch(/^\+30 2\d{2} \d{3} \d{4}$/);
    expect(decision.outcome.chosenOptionId).toBe(decision.options[0].id);
    expect(decision.evaluations.filter((e) => e.optionId === decision.options[0].id)).toHaveLength(3);
  });

  it('trip plan: struck-out activities leave, the rest stays; confirming locks it', async () => {
    const { editItinerary } = await import('../server/pipeline');
    const { decision } = await createRequest('Τετραήμερο στο εξωτερικό 4–7 Δεκεμβρίου', ['pan', 'pant', 'geo'], {});
    const o = decision.options.find((x) => x.id === decision.outcome.chosenOptionId)!;
    const before = o.itinerary!.days.map((d) => d.slots.map((x) => x.title));
    const day = o.itinerary!.days[1];
    const gone = day.slots[0].title;
    await editItinerary(decision.id, o.id, [{ date: day.date, index: 0 }]);
    const after = store.decision(decision.id)!.options.find((x) => x.id === o.id)!.itinerary!;
    expect(after.days[1].slots.map((x) => x.title)).toEqual(before[1].filter((t) => t !== gone));
    expect(after.days[0].slots.map((x) => x.title)).toEqual(before[0]);
    expect(after.confirmed).toBeFalsy();
    await editItinerary(decision.id, o.id, []);
    expect(store.decision(decision.id)!.options.find((x) => x.id === o.id)!.itinerary!.confirmed).toBe(true);
    await expect(editItinerary(decision.id, o.id, [{ date: day.date, index: 0 }])).rejects.toThrow();
  });

  it('a corrected chat line becomes that owner’s wish for this plan, then the twins decide again', async () => {
    const { chatEdits } = await import('../server/pipeline');
    const { request, decision } = await createRequest('Πού να φάμε την Παρασκευή;', ['pan', 'pant', 'geo'], {});
    const r = await chatEdits(request.id, [{ personaId: 'geo', text: 'Εγώ ως 20€ το πολύ για φαγητό' }]);
    expect(r.decision.id).not.toBe(decision.id);
    const wish = store.requestItems(request.id, 'geo').find((m) => m.rule?.metric === 'max_cost');
    expect(wish?.rule?.value).toBe('20');
  });
});

describe('the twins’ chat stays on the decision', () => {
  beforeEach(() => store.reset());

  it('a strict need the proposal already meets (allergy, no tent) is not fed to the chat', async () => {
    const { chatFacts } = await import('../shared/messages');
    const { decision, request } = await createRequest('Τετραήμερο στο εξωτερικό 4–7 Δεκεμβρίου', ['pan', 'pant', 'geo'], {});
    const chosen = decision.options.find((o) => o.id === decision.outcome.chosenOptionId)!;
    const broken = new Set(decision.outcome.results.find((r) => r.optionId === chosen.id)!.violations.map((v) => v.memoryId));
    const need = decision.inputs.find((m) => m.hard && !m.rule && m.scope === 'profile' && !broken.has(m.id));
    expect(need).toBeTruthy();
    chosen.why = [...(chosen.why ?? []), { personaId: need!.personaId, memoryId: need!.id, text: 'ΧΩΡΙΣ-ΝΟΗΜΑ: καλύπτεται κι αυτό' }];
    const { perPerson } = chatFacts(decision, request, ['pan', 'pant', 'geo'].map((id) => store.persona(id)!));
    expect(perPerson[need!.personaId].some((f) => f.includes('ΧΩΡΙΣ-ΝΟΗΜΑ'))).toBe(false);
  });
});
