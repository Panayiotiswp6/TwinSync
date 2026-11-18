// Adapter between TwinSync preferences and OpenSelf memory records.
// Smallest working integration: we reuse OpenSelf's validated record shape
// (memory type, source locator, trust ladder, content hash) for every profile
// item, instead of inventing our own provenance format.

import { normalizeMemory } from './vendor/openself/schema.js';
import { describePref } from '../shared/prefs';
import type { MemoryStamp, Preference, Source } from '../shared/types';

function trustFor(p: Preference): MemoryStamp['sourceTrust'] {
  if (p.origin === 'owner') return 'owner'; // owner typed the correction
  if (p.status === 'confirmed') return 'verified'; // owner confirmed it against the source
  return 'external'; // model or rule proposal, not yet reviewed
}

export function stampPreference(p: Preference, sources: Source[]): MemoryStamp {
  const first = p.sourceRefs[0];
  const src = first ? sources.find((s) => s.id === first.sourceId) : undefined;
  const record = normalizeMemory({
    type: 'preference',
    content: `${describePref(p)} — «${p.sourceRefs.map((r) => r.quote).join('» / «')}»`,
    summary: `${p.key}=${String(p.value)}`,
    source: {
      kind: src?.kind ?? 'manual',
      locator: first ? `twinsync://sources/${first.sourceId}` : '',
      title: src?.title ?? '',
    },
    scope: `twin/${p.ownerId}${p.scope === 'trip' ? '/trip' : ''}`,
    sensitivity: 'personal',
    sourceTrust: trustFor(p),
    confidence: Math.max(0, Math.min(1, p.confidence)),
    occurredAt: src?.date ?? null,
    tags: [p.key, p.scope],
  });
  return {
    id: record.id,
    type: 'preference',
    sourceTrust: record.sourceTrust,
    contentHash: record.contentHash,
    scope: record.scope,
  };
}
