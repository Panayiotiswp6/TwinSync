// Adapter between TwinSync memory items and OpenSelf memory records (vendored, MIT).
// Every profile item gets OpenSelf's validated record shape: memory type, source
// locator, trust ladder (external -> verified -> owner) and content hash.

import { normalizeMemory } from './vendor/openself/schema.js';
import type { MemoryItem, MemoryStamp, Source } from '../shared/types';

const TYPE: Record<MemoryItem['kind'], string> = {
  preference: 'preference',
  constraint: 'commitment',
  fact: 'fact',
  decision_pattern: 'decision',
  style: 'note',
};

function trustFor(m: MemoryItem): MemoryStamp['sourceTrust'] {
  if (m.origin === 'owner') return 'owner';
  if (m.status === 'confirmed') return 'verified';
  return 'external';
}

export function stamp(m: MemoryItem, sources: Source[]): MemoryStamp {
  const first = m.refs[0];
  const src = first ? sources.find((s) => s.id === first.sourceId) : undefined;
  const record = normalizeMemory({
    type: TYPE[m.kind],
    content: `${m.statement} — «${m.refs.map((r) => r.quote).join('» / «')}»`,
    summary: m.statement.slice(0, 480),
    source: { kind: src?.kind ?? 'manual', locator: first ? `twinsync://sources/${first.sourceId}` : '', title: src?.title ?? '' },
    scope: `twin/${m.personaId}${m.scope === 'request' ? `/request/${m.requestId ?? ''}` : ''}`,
    sensitivity: 'personal',
    sourceTrust: trustFor(m),
    confidence: Math.max(0, Math.min(1, m.confidence)),
    occurredAt: src && Number.isFinite(Date.parse(src.date)) ? new Date(src.date).toISOString() : null,
    tags: [m.domain, m.kind, ...(m.hard ? ['hard'] : [])],
  });
  return { id: record.id, type: record.type, sourceTrust: record.sourceTrust, contentHash: record.contentHash, scope: record.scope };
}
