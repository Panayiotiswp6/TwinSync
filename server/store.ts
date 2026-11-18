// Persistent store. State lives in DATA_DIR/state.json (a Docker volume in compose),
// so personas, uploaded sources, confirmed memory and decisions survive restarts.
// First run (or "Reset demo") loads the synthetic seed.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { containsQuote, slug } from '../shared/text';
import type { MemoryDraft } from '../shared/heuristics';
import type { Approval, Decision, GroupRequest, MemoryItem, Origin, Persona, PersonaId, Source, SourceKind, Usage } from '../shared/types';
import { stamp } from './memory';
import { loadSeed, type CatalogEntry } from './seed';

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

function fresh(): State {
  const seed = loadSeed();
  catalog = seed.catalog;
  return { version: STATE_VERSION, personas: seed.personas, sources: seed.sources, memory: seed.memory, requests: [], decisions: [], usage: { calls: 0, inputTokens: 0, outputTokens: 0, embeddingTokens: 0 }, vectors: {} };
}

function load(): State {
  const seedState = fresh(); // also loads the catalog
  if (process.env.TWINSYNC_EPHEMERAL === '1') return seedState;
  try {
    if (existsSync(STATE_FILE)) {
      const s = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;
      if (s.version === STATE_VERSION) return s;
      console.warn('[store] state file from another version — starting from the seed');
    }
  } catch (e) {
    console.warn('[store] could not read state file, starting from the seed:', (e as Error).message);
  }
  return seedState;
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
  get liveEval() {
    return state.liveEval;
  },
  set liveEval(v: unknown) {
    state.liveEval = v;
    persist();
  },
  save: persist,

  reset() {
    state = fresh();
    persist();
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

  addPersona(name: string, bio: string, emoji = '✨'): Persona {
    const clean = name.trim().slice(0, 40);
    const words = clean.split(/\s+/);
    const initials = (words.length > 1 ? words[0][0] + words[1][0] : clean.slice(0, 2)).toUpperCase();
    let id = slug(clean) || `p${state.personas.length + 1}`;
    while (state.personas.some((p) => p.id === id)) id = `${id}-${randomUUID().slice(0, 4)}`;
    const p: Persona = {
      id,
      name: clean,
      handle: `${slug(clean).replace(/-/g, '.') || id}`,
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

  addSource(personaId: PersonaId | 'group', kind: SourceKind, title: string, text: string, fileName?: string): Source {
    const s: Source = {
      id: `src-${personaId}-${randomUUID().slice(0, 8)}`,
      personaId,
      kind,
      title: title.trim().slice(0, 120) || 'Χωρίς τίτλο',
      date: nowIso(),
      text: text.replace(/\r\n/g, '\n').trim(),
      fileName,
      synthetic: false,
      analyzed: false,
    };
    state.sources.push(s);
    persist();
    return s;
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
