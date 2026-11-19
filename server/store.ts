// Persistent store. State lives in DATA_DIR/state.json (a Docker volume in compose),
// so personas, uploaded sources, confirmed memory and decisions survive restarts.
// First run (or "Reset demo") loads the synthetic seed.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { containsQuote, repairMojibake, slug } from '../shared/text';
import type { MemoryDraft } from '../shared/heuristics';
import type { Approval, Decision, GroupRequest, HeldOutCase, MemoryItem, Origin, Persona, PersonaId, Source, SourceKind, Usage } from '../shared/types';
import { stamp } from './memory';
import { hasTeamSeed, loadSeed, loadTeamSeed, type CatalogEntry, type GroupExport } from './seed';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const STATE_VERSION = 2;

interface State {
  version: number;
  personas: Persona[];
  sources: Source[];
  memory: MemoryItem[];
  requests: GroupRequest[];
  decisions: Decision[];
  usage: Usage;
  /** Embedding cache: memory id -> vector (only with an OpenAI key). */
  vectors: Record<string, number[]>;
  liveEval?: unknown;
  /** Held-out decisions imported from owners' questionnaire ZIPs (never used as sources). */
  holdouts?: HeldOutCase[];
}

const nowIso = () => new Date().toISOString();
const PALETTE: [string, string][] = [
  ['#f72585', '#7209b7'],
  ['#4361ee', '#4cc9f0'],
  ['#ff9f1c', '#ff4040'],
  ['#06d6a0', '#118ab2'],
  ['#8338ec', '#ff006e'],
];

let catalog: CatalogEntry[] = [];

export type StartGroup = 'team' | 'synthetic' | 'empty';

/** A fresh state: the team's own group (if committed), the synthetic demo group, or nothing. */
function fresh(kind: StartGroup = hasTeamSeed() ? 'team' : 'synthetic'): State {
  const seed = loadSeed();
  catalog = seed.catalog;
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0, embeddingTokens: 0 };
  const base = { version: STATE_VERSION, requests: [], decisions: [], usage, vectors: {} };
  if (kind === 'empty') return { ...base, personas: [], sources: [], memory: [], holdouts: [] };
  const team = kind === 'team' ? loadTeamSeed() : null;
  if (team) return repairState({ ...base, personas: team.personas, sources: team.sources, memory: team.memory, holdouts: team.holdouts });
  return { ...base, personas: seed.personas, sources: seed.sources, memory: seed.memory };
}

function load(): State {
  const seedState = fresh(); // also loads the catalog
  if (process.env.TWINSYNC_EPHEMERAL === '1') return seedState;
  try {
    if (existsSync(STATE_FILE)) {
      const s = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;
      if (s.version === STATE_VERSION) return repairState(s);
      console.warn('[store] state file from another version — starting from the seed');
    }
  } catch (e) {
    console.warn('[store] could not read state file, starting from the seed:', (e as Error).message);
  }
  return seedState;
}

const SOURCE_KINDS = ['document', 'note', 'chat', 'email', 'past_decision', 'wish', 'correction', 'request'];
const MEMORY_KINDS = ['preference', 'constraint', 'fact', 'decision_pattern', 'style'];
const DOMAIN_LIST = ['travel', 'food', 'money', 'schedule', 'social', 'activities', 'comfort', 'style', 'other'];
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : v == null ? fallback : String(v));

/** Make a saved state safe to render (fields from older versions or failed imports). Never drops user data. */
export function repairState(s: State): State {
  let fixed = 0;
  const count = <T>(before: T, after: T) => (before !== after ? (fixed++, after) : after);
  s.personas = arr<Persona>(s.personas).map((p) => ({
    ...p,
    id: str(p.id),
    name: count(p.name, str(p.name, p.id)),
    handle: count(p.handle, str(p.handle, p.id)),
    initials: count(p.initials, str(p.initials, str(p.name, '?').slice(0, 2).toUpperCase())),
    colors: Array.isArray(p.colors) && p.colors.length === 2 ? p.colors : (fixed++, ['#7f5af0', '#ff8a3d'] as [string, string]),
    emoji: str(p.emoji, ''),
    bio: str(p.bio, ''),
    style: p.style && typeof p.style === 'object' ? { summary: str(p.style.summary), traits: arr<string>(p.style.traits), phrases: arr(p.style.phrases), usesEmoji: !!p.style.usesEmoji } : null,
    createdAt: str(p.createdAt, nowIso()),
  }));
  s.sources = arr<Source>(s.sources).map((x) => ({
    ...x,
    kind: SOURCE_KINDS.includes(x.kind) ? x.kind : (fixed++, 'document' as SourceKind),
    title: str(x.title, 'Χωρίς τίτλο'),
    text: count(x.text, repairMojibake(str(x.text))),
    date: Number.isFinite(Date.parse(str(x.date))) ? x.date : (fixed++, nowIso()),
  }));
  s.memory = arr<MemoryItem>(s.memory).map((m) => ({
    ...m,
    kind: MEMORY_KINDS.includes(m.kind) ? m.kind : (fixed++, 'fact' as MemoryItem['kind']),
    domain: DOMAIN_LIST.includes(m.domain) ? m.domain : (fixed++, 'other' as MemoryItem['domain']),
    statement: str(m.statement, '—'),
    refs: arr<MemoryItem['refs'][number]>(m.refs).filter((r) => r && typeof r.sourceId === 'string').map((r) => ({ sourceId: r.sourceId, quote: str(r.quote) })),
    keywords: arr<string>(m.keywords),
    categories: arr(m.categories),
    strength: typeof m.strength === 'number' ? m.strength : 0.5,
    confidence: typeof m.confidence === 'number' ? m.confidence : 0.5,
  }));
  s.requests = arr(s.requests);
  s.decisions = arr(s.decisions);
  s.holdouts = arr(s.holdouts);
  s.vectors = s.vectors && typeof s.vectors === 'object' ? s.vectors : {};
  s.usage = s.usage ?? { calls: 0, inputTokens: 0, outputTokens: 0, embeddingTokens: 0 };
  if (fixed) console.warn(`[store] repaired ${fixed} field(s) in the saved state (no data removed)`);
  return s;
}

let state: State = load();
let saveTimer: NodeJS.Timeout | null = null;

function persist() {
  if (process.env.TWINSYNC_EPHEMERAL === '1') return;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${STATE_FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, STATE_FILE);
    } catch (e) {
      console.warn('[store] save failed:', (e as Error).message);
    }
  }, 150);
}

export const store = {
  get personas() {
    return state.personas;
  },
  get sources() {
    return state.sources;
  },
  get memory() {
    return state.memory;
  },
  get requests() {
    return state.requests;
  },
  get decisions() {
    return state.decisions;
  },
  get usage() {
    return state.usage;
  },
  get vectors() {
    return state.vectors;
  },
  get catalog() {
    return catalog;
  },
  get holdouts(): HeldOutCase[] {
    return state.holdouts ?? [];
  },
  /** Replace the imported held-out cases of one persona. */
  setHoldouts(personaId: PersonaId, cases: HeldOutCase[]) {
    state.holdouts = [...(state.holdouts ?? []).filter((c) => c.personaId !== personaId), ...cases];
    persist();
  },
  personaByHandle(handle: string) {
    const h = handle.trim().replace(/^@/, '').toLowerCase();
    return state.personas.find((p) => p.handle.toLowerCase() === h);
  },
  updatePersona(id: PersonaId, patch: Partial<Pick<Persona, 'name' | 'bio' | 'emoji'>>) {
    const p = store.persona(id);
    if (p) Object.assign(p, Object.fromEntries(Object.entries(patch).filter(([, v]) => typeof v === 'string' && v.trim())));
    persist();
    return p;
  },
  get liveEval() {
    return state.liveEval;
  },
  set liveEval(v: unknown) {
    state.liveEval = v;
    persist();
  },
  save: persist,

  /** Back to the synthetic demo group, or (empty) to no twins at all. AI usage counters are kept. */
  reset(kind: StartGroup = 'synthetic') {
    const usage = state.usage;
    state = fresh(kind);
    state.usage = usage;
    persist();
  },

  /** The twins (profile memory, own sources, held-out tests) as a file to commit as the team demo group. */
  exportGroup(): GroupExport {
    const ids = new Set(state.personas.map((p) => p.id));
    const keepSource = (k: SourceKind) => !['wish', 'request', 'correction'].includes(k);
    const sources = state.sources.filter((x) => x.personaId !== 'group' && ids.has(x.personaId) && keepSource(x.kind));
    const srcIds = new Set(sources.map((x) => x.id));
    const memory = state.memory.filter((m) => m.scope === 'profile' && m.status !== 'rejected' && m.status !== 'superseded' && m.refs.every((r) => srcIds.has(r.sourceId)));
    return {
      format: 'twinsync-group',
      version: 1,
      exportedAt: nowIso(),
      personas: state.personas.map((p) => ({ ...p, synthetic: false })),
      sources: sources.map((x) => ({ ...x, synthetic: false })),
      memory,
      holdouts: (state.holdouts ?? []).filter((c) => ids.has(c.personaId)),
    };
  },

  persona(id: PersonaId) {
    return state.personas.find((p) => p.id === id);
  },
  source(id: string) {
    return state.sources.find((s) => s.id === id);
  },
  item(id: string) {
    return state.memory.find((m) => m.id === id);
  },
  request(id: string) {
    return state.requests.find((r) => r.id === id);
  },
  decision(id: string) {
    return state.decisions.find((d) => d.id === id);
  },

  addPersona(name: string, bio: string, emoji = '✨', handle?: string): Persona {
    const clean = name.trim().slice(0, 40);
    const words = clean.split(/\s+/);
    const initials = (words.length > 1 ? words[0][0] + words[1][0] : clean.slice(0, 2)).toUpperCase();
    let id = slug(clean) || `p${state.personas.length + 1}`;
    while (state.personas.some((p) => p.id === id)) id = `${id}-${randomUUID().slice(0, 4)}`;
    const p: Persona = {
      id,
      name: clean,
      handle: (handle && /^[a-z0-9._]{2,30}$/i.test(handle.replace(/^@/, '')) ? handle.replace(/^@/, '') : slug(clean).replace(/-/g, '.') || id).toLowerCase(),
      initials,
      colors: PALETTE[state.personas.length % PALETTE.length],
      emoji,
      bio: bio.trim().slice(0, 200),
      style: null,
      synthetic: false,
      createdAt: nowIso(),
    };
    state.personas.push(p);
    persist();
    return p;
  },

  addSource(personaId: PersonaId | 'group', kind: SourceKind, title: string, text: string, fileName?: string, date?: string): Source {
    const s: Source = {
      id: `src-${personaId}-${randomUUID().slice(0, 8)}`,
      personaId,
      kind,
      title: title.trim().slice(0, 120) || 'Χωρίς τίτλο',
      date: date && Number.isFinite(Date.parse(date)) ? date : nowIso(),
      text: repairMojibake(text.replace(/\r\n/g, '\n')).trim(),
      fileName,
      synthetic: false,
      analyzed: false,
    };
    state.sources.push(s);
    persist();
    return s;
  },

  /**
   * Delete a twin and everything that belongs to it: profile, sources, memory, embeddings,
   * held-out tests, and the group requests it took part in (their decisions hold its votes).
   */
  deletePersona(id: PersonaId) {
    if (!store.persona(id)) throw new Error('not found');
    const requestIds = new Set(state.requests.filter((r) => r.participants.includes(id)).map((r) => r.id));
    const memoryIds = new Set(state.memory.filter((m) => m.personaId === id || (m.requestId && requestIds.has(m.requestId))).map((m) => m.id));
    const removed = {
      sources: state.sources.filter((s) => s.personaId === id).length,
      memories: state.memory.filter((m) => m.personaId === id).length,
      requests: requestIds.size,
    };
    state.personas = state.personas.filter((p) => p.id !== id);
    state.sources = state.sources.filter((s) => s.personaId !== id);
    state.memory = state.memory.filter((m) => !memoryIds.has(m.id));
    for (const mid of memoryIds) delete state.vectors[mid];
    state.holdouts = (state.holdouts ?? []).filter((c) => c.personaId !== id);
    state.requests = state.requests.filter((r) => !requestIds.has(r.id));
    state.decisions = state.decisions.filter((d) => !requestIds.has(d.requestId));
    const live = state.liveEval as { rows?: { personaId: string }[] } | undefined;
    if (live?.rows) live.rows = live.rows.filter((r) => r.personaId !== id);
    persist();
    return removed;
  },

  deleteSource(id: string) {
    state.sources = state.sources.filter((s) => s.id !== id);
    for (const m of state.memory) if (m.refs.some((r) => r.sourceId === id) && m.status !== 'rejected') m.status = 'superseded';
    persist();
  },

  /** Store extracted drafts. Drafts whose quote is not an exact span of the source are dropped. */
  addMemory(
    personaId: PersonaId,
    source: Source,
    drafts: MemoryDraft[],
    opts: { origin: Origin; status: MemoryItem['status']; scope: MemoryItem['scope']; requestId?: string },
  ): { created: MemoryItem[]; dropped: number } {
    const created: MemoryItem[] = [];
    let dropped = 0;
    for (const d of drafts) {
      if (!containsQuote(source.text, d.quote)) {
        dropped++;
        continue;
      }
      const m: MemoryItem = {
        id: `mem-${personaId}-${randomUUID().slice(0, 8)}`,
        personaId,
        kind: d.kind,
        statement: d.statement,
        domain: d.domain,
        polarity: d.polarity,
        strength: d.strength,
        hard: d.hard,
        rule: d.rule,
        ...(d.context ? { context: d.context } : {}),
        categories: d.categories,
        keywords: d.keywords,
        refs: [{ sourceId: source.id, quote: d.quote }],
        confidence: d.confidence,
        status: opts.status,
        origin: opts.origin,
        scope: opts.scope,
        requestId: opts.requestId,
        createdAt: nowIso(),
      };
      m.memory = stamp(m, state.sources);
      state.memory.push(m);
      created.push(m);
    }
    persist();
    return { created, dropped };
  },

  updateMemory(id: string, patch: Partial<Pick<MemoryItem, 'statement' | 'strength' | 'hard' | 'rule' | 'status' | 'polarity'>>) {
    const m = store.item(id);
    if (!m) throw new Error('not found');
    const edited = patch.statement !== undefined && patch.statement !== m.statement;
    Object.assign(m, patch);
    if (edited) m.origin = 'owner';
    m.memory = stamp(m, state.sources);
    persist();
    return m;
  },

  confirmAll(personaId: PersonaId) {
    for (const m of state.memory) {
      if (m.personaId === personaId && m.status === 'candidate' && m.scope === 'profile') {
        m.status = 'confirmed';
        m.memory = stamp(m, state.sources);
      }
    }
    persist();
  },

  /** Confirmed permanent profile of a persona. */
  profile(personaId: PersonaId): MemoryItem[] {
    return state.memory.filter((m) => m.personaId === personaId && m.scope === 'profile' && m.status === 'confirmed');
  },
  requestItems(requestId: string, personaId?: PersonaId): MemoryItem[] {
    return state.memory.filter((m) => m.scope === 'request' && m.requestId === requestId && m.status === 'confirmed' && (!personaId || m.personaId === personaId));
  },

  setStyle(personaId: PersonaId, style: Persona['style']) {
    const p = store.persona(personaId);
    if (p) p.style = style;
    persist();
  },

  addRequest(r: Omit<GroupRequest, 'id' | 'createdAt'>): GroupRequest {
    const req: GroupRequest = { ...r, id: `req-${String(state.requests.length + 1).padStart(3, '0')}-${randomUUID().slice(0, 4)}`, createdAt: nowIso() };
    state.requests.push(req);
    persist();
    return req;
  },
  updateRequest(id: string, patch: Partial<GroupRequest>) {
    const r = store.request(id);
    if (r) Object.assign(r, patch);
    persist();
    return r;
  },

  addDecision(d: Omit<Decision, 'id' | 'createdAt'>): Decision {
    const dec: Decision = { ...d, id: `dec-${String(state.decisions.length + 1).padStart(3, '0')}`, createdAt: nowIso() };
    state.decisions.push(dec);
    persist();
    return dec;
  },
  decisionsFor(requestId: string) {
    return state.decisions.filter((d) => d.requestId === requestId);
  },
  approve(decisionId: string, personaId: PersonaId, value: Approval) {
    const d = store.decision(decisionId);
    if (!d) throw new Error('not found');
    if (d.status === 'deadlock') throw new Error('Δεν υπάρχει πρόταση προς έγκριση.');
    if (!(personaId in d.approvals)) throw new Error('Δεν συμμετέχει.');
    d.approvals[personaId] = value;
    const v = Object.values(d.approvals);
    d.status = v.includes('rejected') ? 'rejected' : v.every((x) => x === 'approved') ? 'approved' : 'awaiting_approval';
    persist();
    return d;
  },

  addUsage(u: Partial<Usage>) {
    state.usage.calls += u.calls ?? 0;
    state.usage.inputTokens += u.inputTokens ?? 0;
    state.usage.outputTokens += u.outputTokens ?? 0;
    state.usage.embeddingTokens += u.embeddingTokens ?? 0;
    persist();
  },
};
