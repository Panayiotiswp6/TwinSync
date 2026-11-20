// Retrieval of the memory relevant to a request (RAG over each twin's memory).
// Always included: request-only wishes and strict needs that bind this request. Soft memory is filtered by
// relevance (category, context, domain) and ranked by
// cosine similarity (OpenAI text-embedding-3-large, cached per item) or, without embeddings,
// by keyword overlap. Keeps prompts small as owners add many sources.

import { normalizeGreek } from '../shared/text';
import { coreDomain, relevantTo, type RequestContext } from '../shared/context';
import type { Category, MemoryItem, RequestKind } from '../shared/types';
import { aiErrorReason, embed, embeddingsEnabled } from './ai';
import { store } from './store';

const TOP_K = Number(process.env.RETRIEVAL_TOP_K || 12);

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
  method: 'embeddings' | 'keywords';
  note?: string;
}

export interface RetrievalScope {
  kind?: RequestKind;
  category: Category;
  ctx?: RequestContext | null;
}

/**
 * Only memory that concerns THIS request:
 *  - the twin's own wishes for the request — always;
 *  - strict needs that bind here (category + context) — always;
 *  - soft memory: relevant by category/context, then ranked (embeddings or keywords), even for small profiles.
 */
export async function retrieve(query: string, profile: MemoryItem[], requestItems: MemoryItem[], scope?: RetrievalScope): Promise<RetrievalResult> {
  const fits = (m: MemoryItem) => !scope || relevantTo(m, scope.kind, scope.category, scope.ctx);
  const always = [...requestItems, ...profile.filter((m) => m.hard && fits(m))];
  const candidates = profile.filter((m) => !m.hard && m.kind !== 'style' && fits(m));
  const q = tokens(query);
  const overlap = (m: MemoryItem) => [...tokens(itemText(m))].filter((t) => q.has(t)).length;
  // Small profiles too: an item must either share words with the request or belong to a domain that matters for it.
  const soft = candidates.filter((m) => overlap(m) > 0 || coreDomain(m, scope?.kind) || m.rule);

  if (embeddingsEnabled() && soft.length > TOP_K) {
    try {
      const missing = soft.filter((m) => !store.vectors[m.id]);
      for (let i = 0; i < missing.length; i += 64) {
        const batch = missing.slice(i, i + 64);
        const vecs = await embed(batch.map(itemText));
        batch.forEach((m, j) => (store.vectors[m.id] = vecs[j]));
      }
      const [qv] = await embed([query]);
      store.save();
      const ranked = [...soft].sort((a, b) => cosine(qv, store.vectors[b.id]) - cosine(qv, store.vectors[a.id]));
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
