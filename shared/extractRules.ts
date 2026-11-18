// Demo-mode extractor: deterministic Greek keyword rules, no LLM.
// Used when no ANTHROPIC_API_KEY is configured, for the trip request text,
// and as a fallback if the live model call fails. Every candidate carries
// the exact sentence it came from, so the owner can check it.

import { PREF_META } from './prefs';
import type { ExtractionCandidate, PrefKey, PrefValue } from './types';

/** Lowercase and strip Greek accents/diaeresis so "Θάλασσα" ~ "θαλασσα". */
export function normalizeGreek(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ς/g, 'σ');
}

/** Split into sentences, keeping the original text (Greek question mark is ";"). */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!;;\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

const NEG = /(^|\s)(δεν|οχι|ουτε|ποτε|καθολου)(\s|$|,)/;

function cand(key: PrefKey, value: PrefValue, quote: string, confidence = 0.6, weight?: number): ExtractionCandidate {
  return { key, value, quote: quote.replace(/[.!;;]+$/, ''), confidence, weight: weight ?? PREF_META[key].defaultWeight };
}

function hhmm(h: number, m: number) {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function extractWithRules(text: string): ExtractionCandidate[] {
  const out: ExtractionCandidate[] = [];
  for (const s of sentences(text)) {
    const n = normalizeGreek(s);

    // Budget ceiling: "όριο 150€", "μέχρι 100 ευρώ", "το πολύ 120€"
    // "δεν μπορώ πάνω από 110€" is a cap only when the sentence is negated.
    const budget =
      n.match(/(οριο|μεχρι|εωσ|το πολυ|max|budget)\D{0,15}?(\d{2,4})\s*(€|ευρω)/) ??
      (NEG.test(n) ? n.match(/(πανω απο)\D{0,5}?(\d{2,4})\s*(€|ευρω)/) : null);
    if (budget) out.push(cand('budget_max', Number(budget[2]), s, 0.7));
    // Not "ακριβ…": "ακόμα κι αν βγει ακριβότερο" means the opposite (willing to pay more).
    if (/(φθην|φτην|οικονομικ|χαμηλο κοστοσ|δεν τ[οα] δινω|να μη σκασουμε)/.test(n)) out.push(cand('prefers_low_cost', true, s));

    // Return time: "πίσω στην Αθήνα μέχρι τις 21:00", "επιστροφή ως 20.30", "στις 9 το βράδυ"
    if (/(πισω|επιστροφ|γυρισ|γυρνα|αθηνα)/.test(n)) {
      const t = n.match(/(\d{1,2})[:.](\d{2})/);
      const evening = n.match(/(\d{1,2})\s*(το βραδυ|μμ)/);
      if (t) out.push(cand('return_by', hhmm(Number(t[1]), Number(t[2])), s, 0.7));
      else if (evening) out.push(cand('return_by', hhmm((Number(evening[1]) % 12) + 12, 0), s, 0.6));
    }

    // Stay
    if (/σκην/.test(n) && NEG.test(n)) out.push(cand('no_camping', true, s, 0.7));
    const privateBath = /(δικο|ιδιωτικο)\s+(μασ\s+)?μπανιο/.test(n);
    if (privateBath && /(οπωσδηποτε|μονο|πρεπει|απαραιτητ|σε καμια περιπτωση)/.test(n)) {
      out.push(cand('requires_private_bath', true, s, 0.7));
    } else if (privateBath || /(κρεβατι|ανεση|ανετ|ξενοδοχει|ζεστο ντουσ)/.test(n)) {
      out.push(cand('prefers_comfort', true, s));
    }

    // Hiking: an explicit hour cap wins over a generic like/dislike in the same sentence.
    const cap = n.match(/(μεχρι|το πολυ|εωσ)\s*(\d)(\s*-\s*(\d))?\s*ωρ/);
    if (cap && /(περπατ|πεζοπορ|μονοπατ|αναβασ)/.test(n)) {
      out.push(cand('max_hike_hours', Number(cap[4] ?? cap[2]), s));
    } else if (/(πεζοπορ|μονοπατ|αναβασ|ορειβασ|βουνο)/.test(n)) {
      const dislikes = NEG.test(n) || /κουραζ/.test(n);
      out.push(cand('likes_hiking', !dislikes, s, 0.6, dislikes ? 0.2 : undefined));
    }

    // Sea
    if (/(θαλασσ|παραλι|βουτι|κολυμπ)/.test(n)) out.push(cand('likes_sea', !NEG.test(n), s));
  }

  // One candidate per key: keep the first (most explicit sentence comes first in our sources),
  // except numeric constraints where the strictest value wins.
  const byKey = new Map<PrefKey, ExtractionCandidate>();
  for (const c of out) {
    const prev = byKey.get(c.key);
    if (!prev) byKey.set(c.key, c);
    else if (c.key === 'budget_max' && Number(c.value) < Number(prev.value)) byKey.set(c.key, c);
    else if (c.key === 'return_by' && String(c.value) < String(prev.value)) byKey.set(c.key, c);
  }
  return [...byKey.values()];
}
