// Loads the synthetic seed: persona text files (server/data/personas/<id>/*.md|*.txt
// with a small front-matter block), persona metadata and the pre-extracted profile.
// Every citation is verified against its source text; a mismatch stops the server.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { containsQuote } from '../shared/text';
import type { CandidateOption, Category, HeldOutCase, MemoryItem, Persona, Source, SourceKind } from '../shared/types';
import { stamp } from './memory';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Works from source (server/) and from the bundle (dist/server/). */
export const DATA_SEED_DIR = [path.resolve(here, 'data'), path.resolve(here, '../../server/data'), path.resolve(here, '../server/data')].find((d) => {
  try {
    readdirSync(path.join(d, 'personas'));
    return true;
  } catch {
    return false;
  }
})!;

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(DATA_SEED_DIR, name), 'utf8')) as T;
}

export function parseFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2].trim() };
}

export interface CatalogEntry extends Omit<CandidateOption, 'startsAt' | 'endsAt' | 'origin'> {
  category: Category;
  start: { day: number; time: string };
  end: { day: number; time: string };
}

export interface Seed {
  personas: Persona[];
  sources: Source[];
  memory: MemoryItem[];
  catalog: CatalogEntry[];
}

export function loadSeed(): Seed {
  const { personas } = readJson<{ personas: Persona[] }>('personas.json');
  const sources: Source[] = [];
  for (const p of personas) {
    const dir = path.join(DATA_SEED_DIR, 'personas', p.id);
    for (const file of readdirSync(dir).sort()) {
      if (!/\.(md|txt)$/i.test(file)) continue;
      const { meta, body } = parseFrontMatter(readFileSync(path.join(dir, file), 'utf8'));
      sources.push({
        id: meta.id || `src-${p.id}-${file}`,
        personaId: p.id,
        kind: (meta.kind as SourceKind) || 'document',
        title: meta.title || file,
        date: meta.date || p.createdAt,
        text: body,
        fileName: file,
        synthetic: meta.synthetic !== 'false',
        analyzed: true,
      });
    }
  }
  const raw = readJson<{ items: Omit<MemoryItem, 'status' | 'origin' | 'scope' | 'createdAt'>[] }>('memory.json').items;
  const memory: MemoryItem[] = raw.map((m) => ({ ...m, status: 'confirmed', origin: 'seed', scope: 'profile', createdAt: '2026-11-12T12:00:00+02:00' }));
  const check = (sourceId: string, quote: string, where: string) => {
    const src = sources.find((s) => s.id === sourceId);
    if (!src || !containsQuote(src.text, quote)) throw new Error(`Seed citation does not match its source: ${where} -> ${sourceId} «${quote}»`);
  };
  for (const m of memory) {
    for (const r of m.refs) check(r.sourceId, r.quote, m.id);
    m.memory = stamp(m, sources);
  }
  for (const p of personas) for (const r of p.style?.phrases ?? []) check(r.sourceId, r.quote, `${p.id}.style`);
  const { options: catalog } = readJson<{ options: CatalogEntry[] }>('catalog.json');
  return { personas, sources, memory, catalog };
}

// ---------------------------------------------------------------------------
// The team's own twins (with consent), exported from the app ("Εξαγωγή παρέας")
// and committed as server/data/team/group.json. When present, it is the default
// starting group; the synthetic group stays available (and is what tests use).
// ---------------------------------------------------------------------------

export interface GroupExport {
  format: 'twinsync-group';
  version: 1;
  exportedAt: string;
  personas: Persona[];
  sources: Source[];
  memory: MemoryItem[];
  holdouts: HeldOutCase[];
}

const TEAM_FILE = () => path.join(DATA_SEED_DIR, 'team', 'group.json');

export function hasTeamSeed(): boolean {
  return process.env.TWINSYNC_SEED !== 'synthetic' && existsSync(TEAM_FILE());
}

/** Loads the team group. Memory whose quote is not an exact span of its source is dropped. */
export function loadTeamSeed(): GroupExport | null {
  if (!hasTeamSeed()) return null;
  try {
    const g = JSON.parse(readFileSync(TEAM_FILE(), 'utf8')) as GroupExport;
    if (g.format !== 'twinsync-group') return null;
    const sources = new Map(g.sources.map((s) => [s.id, s]));
    const memory = g.memory.filter((m) => m.refs.every((r) => containsQuote(sources.get(r.sourceId)?.text ?? '', r.quote)));
    return { ...g, memory };
  } catch (e) {
    console.warn('[seed] could not read team/group.json:', (e as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Curated venues (real, public listings) and synthetic demo trip plans.
// ---------------------------------------------------------------------------

export interface VenueEntry {
  id: string;
  name: string;
  kind: 'coffee' | 'drinks' | 'live' | 'club' | 'dinner';
  subtype: string;
  city: string;
  area: string;
  address?: string;
  quiet?: boolean;
  priceHint?: number;
  source: string;
  url: string;
  checkedAt: string;
  features: string[];
}

export function loadVenues(): VenueEntry[] {
  try {
    return readJson<{ venues: VenueEntry[] }>('venues.json').venues;
  } catch {
    return [];
  }
}

export interface FixtureSlot {
  start: string;
  end: string;
  part: 'morning' | 'afternoon' | 'evening' | 'night';
  title: string;
  place: string;
  tags: string[];
  alternative?: string;
  conditional?: string;
}
export interface TripFixture {
  id: string;
  title: string;
  emoji: string;
  summary: string;
  destination: string;
  country: string;
  where: 'abroad' | 'domestic';
  depart: { time: string; mode: string };
  return: { time: string; mode: string };
  stay: { name: string; area: string; note: string };
  cost: { transport: number; stayPerNight: number; foodPerDay: number; activitiesPerDay: number };
  features: string[];
  first: { title: string; slots: FixtureSlot[] };
  middle: { title: string; slots: FixtureSlot[] }[];
  last: { title: string; slots: FixtureSlot[] };
}

export function loadTripFixtures(): TripFixture[] {
  try {
    return readJson<{ trips: TripFixture[] }>('trip-fixtures.json').trips;
  } catch {
    return [];
  }
}
