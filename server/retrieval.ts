// Retrieval of the memory relevant to a request (RAG over each twin's memory).
// Always included: hard constraints and request-only wishes. Soft memory is ranked by
// cosine similarity (OpenAI text-embedding-3-large, cached per item) or, without embeddings,
// by keyword overlap. Keeps prompts small as owners add many sources.

import { normalizeGreek } from '../shared/text';
import type { MemoryItem } from '../shared/types';
import { aiErrorReason, embed, embeddingsEnabled } from './ai';
import { store } from './store';

const TOP_K = Number(process.env.RETRIEVAL_TOP_K || 16);

const itemText = (m: MemoryItem) => `${m.statement}. ${m.keywords.join(', ')}`;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

function tokens(s: string): Set<string> {
  return new Set(
    normalizeGreek(s)
      .split(/[^a-zα-ω0-9]+/)
      .filter((w) => w.length > 3)
      .map((w) => w.slice(0, 6)),
  );
}

export interface RetrievalResult {
  items: MemoryItem[];
  method: 'embeddings' | 'keywords' | 'all';
  note?: string;
}

export async function retrieve(query: string, profile: MemoryItem[], requestItems: MemoryItem[]): Promise<RetrievalResult> {
  const always = [...profile.filter((m) => m.hard), ...requestItems];
  const soft = profile.filter((m) => !m.hard && m.kind !== 'style');
  if (soft.length + always.length <= TOP_K + 4) return { items: [...always, ...soft], method: 'all' };

  if (embeddingsEnabled()) {
    try {
      const missing = soft.filter((m) => !store.vectors[m.id]);
      for (let i = 0; i < missing.length; i += 64) {
        const batch = missing.slice(i, i + 64);
        const vecs = await embed(batch.map(itemText));
        batch.forEach((m, j) => (store.vectors[m.id] = vecs[j]));
      }
      const [q] = await embed([query]);
      store.save();
      const ranked = [...soft].sort((a, b) => cosine(q, store.vectors[b.id]) - cosine(q, store.vectors[a.id]));
      return { items: [...always, ...ranked.slice(0, TOP_K)], method: 'embeddings' };
    } catch (e) {
      const note = `embeddings απέτυχαν (${aiErrorReason(e)}) — χρησιμοποιήθηκαν λέξεις-κλειδιά`;
      return { items: [...always, ...keywordRank(query, soft)], method: 'keywords', note };
    }
  }
  return { items: [...always, ...keywordRank(query, soft)], method: 'keywords' };
}

function keywordRank(query: string, soft: MemoryItem[]): MemoryItem[] {
  const q = tokens(query);
  const score = (m: MemoryItem) => {
    let s = m.strength;
    for (const t of tokens(itemText(m))) if (q.has(t)) s += 1;
    return s;
  };
  return [...soft].sort((a, b) => score(b) - score(a)).slice(0, TOP_K);
}
