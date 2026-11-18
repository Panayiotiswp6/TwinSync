import { beforeEach, describe, expect, it } from 'vitest';
import { runEvaluation } from '../server/evaluation';
import { store } from '../server/store';
import { extractWithRules } from '../shared/extractRules';
import seed from '../server/data/seed.json';

describe('decision engine scenarios (synthetic data)', () => {
  const report = runEvaluation();
  for (const s of report.scenarios) {
    it(s.name, () => expect(s.pass, s.detail).toBe(true));
  }
  it('predicts held-out decisions it was never given, and reports uncertainty instead of guessing', () => {
    expect(report.holdout.correct).toBeGreaterThanOrEqual(6);
    const unseen = report.holdout.rows.find((r) => r.id === 'hold-pant-3')!;
    expect(unseen.outcome).toBe('uncertain');
  });
  it('rule extractor recovers every seed profile key from the seed sources', () => {
    for (const e of report.extraction) expect(e.recall, e.ownerId).toBe(1);
  });
});

describe('demo-mode extraction', () => {
  it('turns an owner note into a cited private-bathroom constraint', () => {
    const c = extractWithRules(seed.twinBuilderSamples.pant);
    const bath = c.find((x) => x.key === 'requires_private_bath');
    expect(bath?.value).toBe(true);
    expect(seed.twinBuilderSamples.pant).toContain(bath!.quote);
    // "ακόμα κι αν βγει λίγο ακριβότερο" = willing to pay more, must not become "prefers low cost"
    expect(c.find((x) => x.key === 'prefers_low_cost')).toBeUndefined();
  });
  it('reads budget and return time, and invents nothing for unrelated text', () => {
    const c = extractWithRules(seed.twinBuilderSamples.geo);
    expect(c.find((x) => x.key === 'budget_max')?.value).toBe(110);
    expect(c.find((x) => x.key === 'return_by')?.value).toBe('20:30');
    expect(extractWithRules('Ο καιρός σήμερα είναι συννεφιασμένος.')).toEqual([]);
  });
});

describe('store flow: source -> preference -> position -> decision -> correction -> new decision', () => {
  beforeEach(() => store.reset());

  it('every seed citation is an exact span of its source and carries an OpenSelf memory stamp', () => {
    for (const p of store.preferences) {
      expect(p.memory?.contentHash).toMatch(/^[0-9a-f]{64}$/);
      for (const r of p.sourceRefs) expect(store.sources.find((s) => s.id === r.sourceId)?.text).toContain(r.quote);
    }
  });

  it('confirming an extracted constraint changes the outcome only after owner approval', () => {
    const src = store.addSource('pant', 'owner_input', 'test', seed.twinBuilderSamples.pant);
    const [cand] = store.addCandidates('pant', src, extractWithRules(src.text).filter((c) => c.key === 'requires_private_bath'), 'rules');
    expect(cand.status).toBe('candidate');
    expect(cand.memory?.sourceTrust).toBe('external');
    store.correct('geo', 'budget_max', 110, 'trip');
    expect(store.plan().result.chosenOptionId).toBe('trip-geraneia'); // candidate not used yet
    store.confirm(cand.id);
    expect(store.pref(cand.id)?.memory?.sourceTrust).toBe('verified');
    const d = store.plan();
    expect(d.result.status).toBe('deadlock');
    expect(d.diff?.changes.join(' ')).toContain('Παντελής');
  });

  it('trip-only correction does not touch the profile; profile correction does', () => {
    store.applyRequest(store.request);
    const first = store.plan();
    store.correct('geo', 'budget_max', 110, 'trip');
    const second = store.plan();
    expect(second.diff?.priceDelta).toBe(-30);
    const profileBudget = store.preferences.find((p) => p.ownerId === 'geo' && p.key === 'budget_max' && p.scope === 'profile' && p.status === 'confirmed');
    expect(profileBudget?.value).toBe(150);
    expect(first.result.chosenOptionId).not.toBe(second.result.chosenOptionId);

    store.correct('geo', 'budget_max', 95, 'profile');
    const saved = store.preferences.find((p) => p.ownerId === 'geo' && p.key === 'budget_max' && p.scope === 'profile' && p.status === 'confirmed');
    expect(saved?.value).toBe(95);
    expect(saved?.memory?.sourceTrust).toBe('owner');
  });

  it('a limit in the request text applies to everyone for this weekend only', () => {
    store.applyRequest({ ...store.request, text: 'Βρες μας κάτι μέχρι 100€ το άτομο αυτό το ΣΚ.' });
    const d = store.plan();
    expect(d.result.chosenOptionId).toBe('trip-geraneia');
    expect(d.inputs.filter((p) => p.scope === 'trip' && p.key === 'budget_max')).toHaveLength(3);
  });

  it('final proposal needs every owner to approve', () => {
    const d = store.plan();
    store.approve(d.id, 'pan', true);
    store.approve(d.id, 'pant', true);
    expect(d.status).toBe('awaiting_approval');
    store.approve(d.id, 'geo', true);
    expect(d.status).toBe('approved');
  });
});

describe('group messages in the owner style: grounding guard (no network)', async () => {
  const { messageFacts, styleSamples, templateMessage, ungroundedReason } = await import('../shared/messages');
  beforeEach(() => store.reset());

  it('facts come only from the decision, style samples only from the owner own writing', () => {
    const d = store.plan();
    const facts = messageFacts(d, 'geo', store.trips, store.owners);
    expect(facts.join(' ')).toContain('Στενή Δίρφυος & Χιλιαδού');
    expect(facts.join(' ')).toContain('128€');
    const samples = styleSamples(store.sources, 'geo');
    expect(samples.length).toBe(4);
    expect(samples.every((s) => s.ownerId === 'geo')).toBe(true);
  });

  it('rejects a draft that invents a price, a time or another destination', () => {
    const d = store.plan();
    const facts = messageFacts(d, 'pan', store.trips, store.owners);
    expect(ungroundedReason('Οκ για Δίρφυ, 128€ και πίσω 20:15, πάμε!', facts, store.trips)).toBeNull();
    expect(ungroundedReason('Πάμε Δίρφυ, βγαίνει 99€ όλο!', facts, store.trips)).toMatch(/99/);
    expect(ungroundedReason('Πάμε, γυρνάμε στις 18:00', facts, store.trips)).toMatch(/18:00/);
    expect(ungroundedReason('Καλύτερα Ναύπλιο ρε παιδιά', facts, store.trips)).toMatch(/Ναύπλιο/);
  });

  it('templates pass the guard for agreement and deadlock', () => {
    const ok = store.plan();
    for (const o of store.owners) {
      const t = templateMessage(ok, o.id, store.trips);
      expect(ungroundedReason(t, messageFacts(ok, o.id, store.trips, store.owners), store.trips), t).toBeNull();
    }
    store.correct('geo', 'budget_max', 90, 'trip');
    const stuck = store.plan();
    expect(stuck.result.status).toBe('deadlock');
    const t = templateMessage(stuck, 'geo', store.trips);
    expect(ungroundedReason(t, messageFacts(stuck, 'geo', store.trips, store.owners), store.trips), t).toBeNull();
  });
});

describe('interests beyond the fixed trip keys', () => {
  beforeEach(() => store.reset());

  it('the judge sentence about clubs and new people becomes two cited interests, not "nothing found"', () => {
    const text = 'Θέλω να πάω σε κλαμπ ,. να γνωρίσω νέα άτομα και να διασκεδάσω';
    const c = extractWithRules(text);
    expect(c.map((x) => `${x.key}:${x.value}`).sort()).toEqual(['likes_activity:nightlife', 'likes_activity:social']);
    for (const x of c) expect(text).toContain(x.quote);
  });

  it('several interests of one owner coexist and change that twin scores', async () => {
    const { twinPosition } = await import('../shared/engine');
    const src = store.addSource('pan', 'owner_input', 'test', 'Θέλω κλαμπ και να γνωρίσω νέα άτομα.');
    const created = store.addCandidates('pan', src, extractWithRules(src.text), 'rules');
    for (const p of created) store.confirm(p.id);
    const active = store.preferences.filter((p) => p.ownerId === 'pan' && p.key === 'likes_activity' && p.status === 'confirmed');
    expect(active).toHaveLength(2);
    const before = twinPosition('pan', store.preferences.filter((p) => p.ownerId === 'pan' && p.key !== 'likes_activity' && p.status === 'confirmed'), store.trips);
    const after = twinPosition('pan', store.effectivePreferences(['pan']), store.trips);
    const score = (pos: typeof after, id: string) => pos.ranking.find((r) => r.optionId === id)!.score;
    expect(score(after, 'trip-nafplio')).toBeGreaterThan(score(before, 'trip-nafplio'));
    expect(after.reasons.some((r) => r.text.includes('νυχτερινή ζωή'))).toBe(true);
  });
});
