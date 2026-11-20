// Context-aware use of memory. A statement is said in a context ("συνήθως δίνω 200€ για ένα
// διήμερο" = a weekend in Greece). It must not become a rule for a different situation
// (4 days abroad). This module decides, in code, whether a profile item applies to a request
// and how a numeric reference scales with the request's duration.
//
// Precedence: what a person says for THIS request (scope "request") always beats their
// general profile on the same metric.

import { deadlineFor, localParts, parseIso } from './time';
import { normalizeGreek } from './text';
import type { Category, Domain, GroupRequest, MemoryItem, RequestKind, Where } from './types';

export interface RequestContext {
  days: number;
  where: Exclude<Where, 'any'> | null;
  /** The requested period: a routine weekly limit cannot override dates the group explicitly asked for. */
  start?: string | null;
  end?: string | null;
  /** A big trip outside Europe: everyday money amounts are only a loose reference. */
  longHaul?: boolean;
}

const LONG_HAUL = /(εκτοσ ευρωπ|εξω απο την ευρωπ|ασια|αφρικ|αμερικ|η\.?π\.?α|ιαπων|τοκιο|ταιλανδ|μπανγκοκ|μπαλι|ινδονησ|βιετναμ|ινδια|κινα|κορεα|νεα υορκη|καραιβ|μαλδιβ|σεισελ|μαυρικ|αυστραλ|ζηλανδ|μεξικ|βραζιλ|αργεντιν|περου|κουβα|ντουμπαι|εμιρατ|αιγυπτ|μαροκ|ιορδαν|ζανζιβαρ|κενυα|ταξιδι ζωησ|μεγαλο ταξιδι|μεγαλη εμπειρια|safari|σαφαρι|japan|thailand|bali|usa|new york)/;

/** "Τετραήμερο στην Ιαπωνία", "κάτι εκτός Ευρώπης για εμπειρία ζωής". */
export function isLongHaul(text: string): boolean {
  return LONG_HAUL.test(normalizeGreek(text));
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
  // One outing that runs past midnight is ONE outing (budget is not doubled).
  if (e.getTime() - s.getTime() <= 20 * 3600 * 1000) return 1;
  const a = localParts(s);
  const b = localParts(e);
  const da = Date.UTC(a.y, a.m - 1, a.d);
  const db = Date.UTC(b.y, b.m - 1, b.d);
  return Math.max(1, Math.round((db - da) / 86400000) + 1);
}

export function requestContext(req: Pick<GroupRequest, 'periodStart' | 'periodEnd' | 'category' | 'days' | 'where'> & Partial<Pick<GroupRequest, 'text' | 'place'>>): RequestContext {
  const days = req.days && req.days > 0 ? req.days : spanDays(req.periodStart, req.periodEnd);
  const where = req.where ?? (req.category === 'trip' ? 'domestic' : 'local');
  const longHaul = where === 'abroad' && isLongHaul(`${req.text ?? ''} ${req.place ?? ''}`);
  return { days, where, start: req.periodStart, end: req.periodEnd, ...(longHaul ? { longHaul } : {}) };
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
  if (!ctx || m.scope === 'request') return FULL;
  // A routine weekly limit ("back by Sunday 21:00 — work on Monday") does not override a trip the group
  // explicitly asked to end later: whoever joins a Fri–Mon trip has arranged that Monday.
  if (m.rule?.metric === 'latest_end' && m.rule.value.startsWith('weekly:') && ctx.start && ctx.end) {
    const deadline = deadlineFor(m.rule.value, parseIso(ctx.start));
    const end = parseIso(ctx.end);
    // Only when the trip runs into a LATER DAY (e.g. Monday): a weekend ending at 23:59 instead of 21:00 is still a weekend.
    const day = (d: Date) => {
      const p = localParts(d);
      return p.y * 10000 + p.m * 100 + p.d;
    };
    if (deadline && end && day(end) > day(deadline)) {
      return { applies: false, scale: 1, note: 'το αίτημα ορίζει επιστροφή αργότερα (διακοπές/άδεια) — το όριο της ρουτίνας δεν ισχύει εδώ' };
    }
  }
  // Big trips outside Europe: everyday budgets are a loose reference, never a block.
  if (m.rule?.metric === 'max_cost' && ctx.longHaul) {
    return { applies: false, scale: 1, note: 'μεγάλο ταξίδι εκτός Ευρώπης — τα συνηθισμένα ποσά είναι μόνο ένδειξη' };
  }
  if (!m.context) return FULL;
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

// ---------------------------------------------------------------------------
// Relevance: which memory a request should even look at (retrieval + recall).
// ---------------------------------------------------------------------------

const STAY = /(σκην|καμπινγκ|camping|διαμον|δωματι|μπανιο|ξενοδοχ|hostel|καναπ|airbnb|κρεβατ|διανυκτερ)/;
const TRAVEL_ONLY = /(πτησ|αεροπλαν|πλοιο|καραβι|φερι|ωρες στο αυτοκινητο|ωρες δρομο|οδηγ)/;
const CORE: Partial<Record<RequestKind, Domain[]>> = {
  coffee: ['money', 'schedule', 'social', 'comfort', 'food'],
  drinks: ['money', 'schedule', 'social', 'comfort', 'food'],
  club: ['money', 'schedule', 'social'],
  live: ['money', 'schedule', 'social'],
  dinner: ['money', 'schedule', 'social', 'comfort', 'food'],
};

/**
 * Should this memory item be considered for this request at all?
 *  - category and context must fit (a trip budget is not about an evening, and vice versa);
 *  - accommodation / long-distance travel items only matter for trips;
 *  - request-only wishes always count.
 */
export function relevantTo(m: MemoryItem, kind: RequestKind | undefined, category: Category, ctx?: RequestContext | null): boolean {
  if (m.scope === 'request') return true;
  if (!appliesToCategory(m, category)) return false;
  const trip = (ctx?.where ?? (category === 'trip' ? 'domestic' : 'local')) !== 'local';
  const w = m.context?.where;
  if (w && w !== 'any' && (w === 'local') === trip) return false; // trip budget for an evening, or evening budget for a trip
  if (!trip) {
    const text = normalizeGreek(`${m.statement} ${m.keywords.join(' ')}`);
    if (STAY.test(text) || TRAVEL_ONLY.test(text) || m.domain === 'travel') return false;
  }
  return true;
}

/** Domains that matter for a local kind even without keyword overlap. */
export function coreDomain(m: MemoryItem, kind: RequestKind | undefined): boolean {
  const core = kind ? CORE[kind] : undefined;
  return !core || core.includes(m.domain);
}
