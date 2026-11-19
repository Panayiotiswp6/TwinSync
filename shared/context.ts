// Context-aware use of memory. A statement is said in a context ("συνήθως δίνω 200€ για ένα
// διήμερο" = a weekend in Greece). It must not become a rule for a different situation
// (4 days abroad). This module decides, in code, whether a profile item applies to a request
// and how a numeric reference scales with the request's duration.
//
// Precedence: what a person says for THIS request (scope "request") always beats their
// general profile on the same metric.

import { localParts, parseIso } from './time';
import type { Category, GroupRequest, MemoryItem, Where } from './types';

export interface RequestContext {
  days: number;
  where: Exclude<Where, 'any'> | null;
}

export const WHERE_LABEL: Record<Where, string> = {
  any: 'οπουδήποτε',
  local: 'έξοδο στην πόλη',
  domestic: 'ταξίδι στην Ελλάδα',
  abroad: 'ταξίδι στο εξωτερικό',
};

/** Calendar days a plan spans in Athens time (Fri evening → Sun night = 3; one evening = 1). */
export function spanDays(start: string | null | undefined, end: string | null | undefined): number {
  const s = parseIso(start ?? null);
  const e = parseIso(end ?? null);
  if (!s || !e || e < s) return 1;
  const a = localParts(s);
  const b = localParts(e);
  const da = Date.UTC(a.y, a.m - 1, a.d);
  const db = Date.UTC(b.y, b.m - 1, b.d);
  return Math.max(1, Math.round((db - da) / 86400000) + 1);
}

export function requestContext(req: Pick<GroupRequest, 'periodStart' | 'periodEnd' | 'category' | 'days' | 'where'>): RequestContext {
  const days = req.days && req.days > 0 ? req.days : spanDays(req.periodStart, req.periodEnd);
  const where = req.where ?? (req.category === 'trip' ? 'domestic' : 'local');
  return { days, where };
}

export interface Fit {
  applies: boolean;
  /** Multiplier for a max_cost reference (request days / statement days). */
  scale: number;
  note: string | null;
}

const FULL: Fit = { applies: true, scale: 1, note: null };

/** Does a profile item apply to this request, and how should its numbers scale? */
export function contextFit(m: MemoryItem, ctx?: RequestContext | null): Fit {
  if (!ctx || m.scope === 'request' || !m.context) return FULL;
  const c = m.context;
  if (c.where !== 'any' && ctx.where && c.where !== ctx.where) {
    return { applies: false, scale: 1, note: `ειπώθηκε για ${WHERE_LABEL[c.where]}, όχι για ${WHERE_LABEL[ctx.where]}` };
  }
  if (m.rule?.metric === 'max_cost' && c.days > 0 && ctx.days > 0 && c.days !== ctx.days) {
    return { applies: true, scale: ctx.days / c.days, note: `ειπώθηκε για ${c.days} ${c.days === 1 ? 'μέρα' : 'μέρες'} — αναγωγή σε ${ctx.days}` };
  }
  return FULL;
}

export function appliesToCategory(item: MemoryItem, category: Category): boolean {
  return item.categories.length === 0 || item.categories.includes(category);
}

/** Effective euro limit of a max_cost item for this request (scaled by duration). */
export function costLimit(m: MemoryItem, fit: Fit): number | null {
  if (m.rule?.metric !== 'max_cost') return null;
  const v = Number(m.rule.value);
  return Number.isFinite(v) ? Math.round(v * fit.scale) : null;
}

export interface ActiveRule {
  item: MemoryItem;
  fit: Fit;
}

/**
 * Hard items that bind this request, per person:
 *  - category must match, context must fit;
 *  - a request-only item on a metric (cost / end time) replaces the profile items on that metric.
 */
export function bindingHard(items: MemoryItem[], category: Category, ctx?: RequestContext | null): ActiveRule[] {
  const confirmed = items.filter((m) => m.status === 'confirmed' && appliesToCategory(m, category));
  const overridden = new Set(confirmed.filter((m) => m.scope === 'request' && m.rule).map((m) => `${m.personaId}|${m.rule!.metric}`));
  const out: ActiveRule[] = [];
  for (const m of confirmed) {
    if (!m.hard) continue;
    if (m.scope === 'profile' && m.rule && overridden.has(`${m.personaId}|${m.rule.metric}`)) continue;
    const fit = contextFit(m, ctx);
    if (!fit.applies) continue;
    out.push({ item: m, fit });
  }
  return out;
}

/** Soft numeric references ("συνήθως δίνω ~200€ για διήμερο") — shown as warnings, never block. */
export function softReferences(items: MemoryItem[], category: Category, ctx?: RequestContext | null): ActiveRule[] {
  const confirmed = items.filter((m) => m.status === 'confirmed' && appliesToCategory(m, category));
  const overridden = new Set(confirmed.filter((m) => m.scope === 'request' && m.rule).map((m) => `${m.personaId}|${m.rule!.metric}`));
  return confirmed
    .filter((m) => !m.hard && m.rule && !(m.scope === 'profile' && overridden.has(`${m.personaId}|${m.rule.metric}`)))
    .map((m) => ({ item: m, fit: contextFit(m, ctx) }))
    .filter((r) => r.fit.applies);
}

/** How a profile item should be read for this request — given to the model next to each item. */
export function contextHint(m: MemoryItem, ctx?: RequestContext | null): string {
  if (m.scope === 'request') return 'ΜΟΝΟ ΓΙΑ ΑΥΤΟ — υπερισχύει του προφίλ';
  const parts: string[] = [];
  if (m.context && (m.context.where !== 'any' || m.context.days > 0)) {
    parts.push(`πλαίσιο: ${m.context.where !== 'any' ? WHERE_LABEL[m.context.where] : ''}${m.context.days > 0 ? `${m.context.where !== 'any' ? ', ' : ''}${m.context.days} μέρες` : ''}`);
  }
  const fit = contextFit(m, ctx);
  if (!fit.applies) parts.push(`ΔΕΝ ισχύει αυτούσιο εδώ (${fit.note}) — μόνο ως ένδειξη`);
  else if (fit.scale !== 1) {
    const lim = costLimit(m, fit);
    parts.push(`${fit.note}: ≈${lim}€`);
  }
  if (m.rule && !m.hard) parts.push('ενδεικτικό, όχι όριο');
  return parts.join(' · ');
}
