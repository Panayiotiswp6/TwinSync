// In-memory store. Loads the synthetic seed, validates every citation, and keeps
// profiles, trip-only overrides and decisions. "Reset demo" reloads the seed.

import { randomUUID } from 'node:crypto';
import seed from './data/seed.json';
import { decide } from '../shared/engine';
import { PREF_META, describePref } from '../shared/prefs';
import { extractWithRules } from '../shared/extractRules';
import type {
  Decision,
  DecisionDiff,
  ExtractionCandidate,
  Owner,
  OwnerId,
  Preference,
  PrefKey,
  PrefOrigin,
  PrefScope,
  PrefValue,
  Source,
  SourceKind,
  TripOption,
  TripRequest,
} from '../shared/types';
import { stampPreference } from './memory';

const nowIso = () => new Date().toISOString();

export function findQuote(text: string, quote: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return norm(text).includes(norm(quote));
}

interface State {
  owners: Owner[];
  sources: Source[];
  preferences: Preference[]; // profile + trip scope, all statuses
  trips: TripOption[];
  request: TripRequest;
  decisions: Decision[];
}

function loadSeed(): State {
  const sources = seed.sources as Source[];
  const preferences: Preference[] = seed.preferences.map((p) => ({
    ...(p as Omit<Preference, 'status' | 'scope' | 'origin' | 'createdAt'>),
    key: p.key as PrefKey,
    status: 'confirmed',
    scope: 'profile',
    origin: 'seed',
    createdAt: '2026-11-12T12:00:00+02:00',
  }));
  for (const p of preferences) {
    for (const ref of p.sourceRefs) {
      const src = sources.find((s) => s.id === ref.sourceId);
      if (!src || !findQuote(src.text, ref.quote)) {
        throw new Error(`Seed citation does not match its source: ${p.id} -> ${ref.sourceId} «${ref.quote}»`);
      }
    }
    p.memory = stampPreference(p, sources);
  }
  return {
    owners: seed.owners as Owner[],
    sources,
    preferences,
    trips: seed.trips as TripOption[],
    request: { ...seed.defaultRequest },
    decisions: [],
  };
}

let state: State = loadSeed();

export const store = {
  reset() {
    state = loadSeed();
  },
  get owners() {
    return state.owners;
  },
  get sources() {
    return state.sources;
  },
  get trips() {
    return state.trips;
  },
  get request() {
    return state.request;
  },
  get decisions() {
    return state.decisions;
  },
  get preferences() {
    return state.preferences;
  },
  samples: seed.twinBuilderSamples as Record<OwnerId, string>,

  owner(id: OwnerId) {
    return state.owners.find((o) => o.id === id);
  },
  pref(id: string) {
    return state.preferences.find((p) => p.id === id);
  },

  addSource(ownerId: OwnerId | 'group', kind: SourceKind, title: string, text: string): Source {
    const src: Source = {
      id: `src-${ownerId}-${kind === 'owner_correction' ? 'fix' : kind === 'trip_request' ? 'req' : 'in'}-${randomUUID().slice(0, 6)}`,
      ownerId,
      kind,
      title,
      date: nowIso(),
      text,
      synthetic: true,
    };
    state.sources.push(src);
    return src;
  },

  addCandidates(ownerId: OwnerId, source: Source, candidates: ExtractionCandidate[], origin: PrefOrigin): Preference[] {
    const created: Preference[] = [];
    for (const c of candidates) {
      if (!findQuote(source.text, c.quote)) continue; // never keep a citation we cannot show
      const p: Preference = {
        id: `pref-${ownerId}-${c.key}-${randomUUID().slice(0, 6)}`,
        ownerId,
        key: c.key,
        value: c.value,
        weight: PREF_META[c.key].kind === 'constraint' ? 1 : c.weight,
        status: 'candidate',
        scope: 'profile',
        confidence: c.confidence,
        origin,
        sourceRefs: [{ sourceId: source.id, quote: c.quote }],
        createdAt: nowIso(),
      };
      p.memory = stampPreference(p, state.sources);
      state.preferences.push(p);
      created.push(p);
    }
    return created;
  },

  /** Confirm (optionally corrected) candidate into the profile; supersedes an older item with the same key. */
  confirm(id: string, value?: PrefValue, weight?: number): Preference {
    const p = store.pref(id);
    if (!p) throw new Error('not found');
    if (value !== undefined && value !== p.value) {
      p.correctedFrom = p.value;
      p.value = value;
    }
    if (weight !== undefined && PREF_META[p.key].kind === 'preference') p.weight = weight;
    p.status = 'confirmed';
    for (const other of state.preferences) {
      if (other !== p && other.ownerId === p.ownerId && other.key === p.key && other.scope === p.scope && other.status === 'confirmed') {
        other.status = 'superseded';
      }
    }
    p.memory = stampPreference(p, state.sources);
    return p;
  },

  reject(id: string) {
    const p = store.pref(id);
    if (!p) throw new Error('not found');
    p.status = 'rejected';
    return p;
  },

  /** Owner correction: "trip" applies only to this weekend, "profile" is saved to the twin. */
  correct(ownerId: OwnerId, key: PrefKey, value: PrefValue, scope: PrefScope, weight?: number): Preference {
    const owner = store.owner(ownerId)!;
    const label = describePref({ key, value });
    const text =
      scope === 'trip'
        ? `Διόρθωση από ${owner.name}, μόνο για το ${state.request.weekendLabel}: ${label}.`
        : `Διόρθωση από ${owner.name}, αποθηκεύεται στο προφίλ: ${label}.`;
    const src = store.addSource(ownerId, 'owner_correction', scope === 'trip' ? 'Διόρθωση μόνο για αυτό το διήμερο' : 'Διόρθωση προφίλ', text);
    const previous = state.preferences.find((p) => p.ownerId === ownerId && p.key === key && p.status === 'confirmed' && (p.scope === scope || scope === 'trip'));
    const p: Preference = {
      id: `pref-${ownerId}-${key}-${scope}-${randomUUID().slice(0, 6)}`,
      ownerId,
      key,
      value,
      weight: PREF_META[key].kind === 'constraint' ? 1 : weight ?? previous?.weight ?? PREF_META[key].defaultWeight,
      status: 'confirmed',
      scope,
      confidence: 1,
      origin: 'owner',
      sourceRefs: [{ sourceId: src.id, quote: label }],
      correctedFrom: previous?.value,
      createdAt: nowIso(),
    };
    for (const other of state.preferences) {
      if (other.ownerId === ownerId && other.key === key && other.scope === scope && other.status === 'confirmed') other.status = 'superseded';
    }
    p.memory = stampPreference(p, state.sources);
    state.preferences.push(p);
    return p;
  },

  removeOverride(id: string) {
    const p = store.pref(id);
    if (p && p.scope === 'trip') p.status = 'rejected';
  },

  /** Effective inputs for the engine: confirmed profile items, replaced per key by trip-only items. */
  effectivePreferences(participants: OwnerId[]): Preference[] {
    const confirmed = state.preferences.filter((p) => p.status === 'confirmed' && participants.includes(p.ownerId));
    const trip = confirmed.filter((p) => p.scope === 'trip');
    const profile = confirmed.filter((p) => p.scope === 'profile' && !trip.some((t) => t.ownerId === p.ownerId && t.key === p.key));
    return [...profile, ...trip];
  },

  /** Group constraints typed in the request ("μέχρι 100€") become trip-only items for every participant. */
  applyRequest(request: TripRequest) {
    state.request = request;
    for (const p of state.preferences) if (p.scope === 'trip' && p.sourceRefs.some((r) => r.sourceId.startsWith('src-group-req'))) p.status = 'superseded';
    const found = extractWithRules(request.text).filter((c) => PREF_META[c.key].kind === 'constraint');
    if (!found.length) return;
    const src = store.addSource('group', 'trip_request', 'Αίτημα παρέας', request.text);
    for (const ownerId of request.participants) {
      for (const c of found) {
        for (const other of state.preferences) {
          if (other.ownerId === ownerId && other.key === c.key && other.scope === 'trip' && other.status === 'confirmed') other.status = 'superseded';
        }
        const p: Preference = {
          id: `pref-${ownerId}-${c.key}-req-${randomUUID().slice(0, 6)}`,
          ownerId,
          key: c.key,
          value: c.value,
          weight: 1,
          status: 'confirmed',
          scope: 'trip',
          confidence: c.confidence,
          origin: 'rules',
          sourceRefs: [{ sourceId: src.id, quote: c.quote }],
          createdAt: nowIso(),
        };
        // A group request can only tighten an owner's own limit, never loosen it.
        const own = store.effectivePreferences([ownerId]).find((x) => x.key === c.key);
        if (own && c.key === 'budget_max' && Number(own.value) <= Number(c.value)) continue;
        if (own && c.key === 'return_by' && String(own.value) <= String(c.value)) continue;
        p.memory = stampPreference(p, state.sources);
        state.preferences.push(p);
      }
    }
  },

  plan(): Decision {
    const req = state.request;
    const owners = state.owners.filter((o) => req.participants.includes(o.id));
    const inputs = store.effectivePreferences(req.participants);
    const result = decide(owners, inputs, state.trips);
    const previous = state.decisions[state.decisions.length - 1];
    const decision: Decision = {
      id: `dec-${String(state.decisions.length + 1).padStart(3, '0')}`,
      createdAt: nowIso(),
      request: { ...req },
      inputs: inputs.map((p) => ({ ...p })),
      result,
      approvals: Object.fromEntries(owners.map((o) => [o.id, 'pending'])),
      status: result.status === 'deadlock' ? 'deadlock' : 'awaiting_approval',
    };
    if (previous) decision.diff = diffDecisions(previous, decision, state.trips, state.owners);
    state.decisions.push(decision);
    return decision;
  },

  approve(decisionId: string, ownerId: OwnerId, approve: boolean): Decision {
    const d = state.decisions.find((x) => x.id === decisionId);
    if (!d) throw new Error('not found');
    if (d.status === 'deadlock') throw new Error('Δεν υπάρχει πρόταση προς έγκριση.');
    if (!(ownerId in d.approvals)) throw new Error('Ο κάτοχος δεν συμμετέχει.');
    d.approvals[ownerId] = approve ? 'approved' : 'rejected';
    const vals = Object.values(d.approvals);
    d.status = vals.includes('rejected') ? 'rejected' : vals.every((v) => v === 'approved') ? 'approved' : 'awaiting_approval';
    return d;
  },
};

export function diffDecisions(prev: Decision, next: Decision, trips: TripOption[], owners: Owner[]): DecisionDiff {
  const name = (id: string | null) => (id ? trips.find((t) => t.id === id)?.name ?? id : 'καμία εφικτή επιλογή');
  const price = (id: string | null) => (id ? trips.find((t) => t.id === id)?.pricePerPerson ?? null : null);
  const from = prev.result.chosenOptionId;
  const to = next.result.chosenOptionId;
  const changes: string[] = [];
  const key = (p: Preference) => `${p.ownerId}:${p.key}`;
  const before = new Map(prev.inputs.map((p) => [key(p), p]));
  const after = new Map(next.inputs.map((p) => [key(p), p]));
  const ownerName = (id: string) => owners.find((o) => o.id === id)?.name ?? id;
  for (const [k, p] of after) {
    const b = before.get(k);
    if (!b) changes.push(`Νέο: ${ownerName(p.ownerId)} — ${describePref(p)}${p.scope === 'trip' ? ' (μόνο για αυτό το διήμερο)' : ''}`);
    else if (b.value !== p.value) changes.push(`${ownerName(p.ownerId)}: ${describePref(b)} → ${describePref(p)}${p.scope === 'trip' ? ' (μόνο για αυτό το διήμερο)' : ''}`);
  }
  for (const [k, b] of before) if (!after.has(k)) changes.push(`Αφαιρέθηκε: ${ownerName(b.ownerId)} — ${describePref(b)}`);
  if (from !== to) changes.push(`Πρόταση: ${name(from)} → ${name(to)}`);
  const pf = price(from);
  const pt = price(to);
  return { previousDecisionId: prev.id, fromOptionId: from, toOptionId: to, priceDelta: pf !== null && pt !== null ? pt - pf : null, changes };
}
