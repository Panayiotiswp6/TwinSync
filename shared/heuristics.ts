// DEMO MODE ONLY (no API key): deterministic rules that stand in for the model,
// so the app always runs. Clearly labelled as "demo" everywhere in the UI.

import { clamp, normalizeGreek, sentences } from './text';
import { upcomingWeekend } from './time';
import type { CandidateOption, Category, Domain, Evaluation, MemoryItem, MemoryKind, NumericRule, Polarity } from './types';

export interface MemoryDraft {
  kind: MemoryKind;
  statement: string;
  domain: Domain;
  polarity: Polarity;
  strength: number;
  hard: boolean;
  rule?: NumericRule;
  categories: Category[];
  keywords: string[];
  quote: string;
  confidence: number;
}

const NEG = /(^|\s)(δεν|οχι|ουτε|ποτε|καθολου|βαριεμαι|μισω)(\s|$|,)/;
const WEEKDAY_RE: [number, RegExp][] = [
  [0, /κυριακ/],
  [1, /δευτερ/],
  [2, /τριτη/],
  [3, /τεταρτ/],
  [4, /πεμπτ/],
  [5, /παρασκευ/],
  [6, /σαββατ/],
];

interface Topic {
  re: RegExp;
  statement: [string, string]; // likes, avoids
  domain: Domain;
  keywords: string[];
  categories?: Category[];
  strength?: number;
}

const TOPICS: Topic[] = [
  { re: /(πεζοπορ|μονοπατ|αναβασ|ορειβασ|βουνο)/, statement: ['Του αρέσει η πεζοπορία και το βουνό', 'Αποφεύγει πολλή πεζοπορία / βουνό'], domain: 'activities', keywords: ['πεζοπορία', 'μονοπάτι', 'βουνό', 'ανάβαση'] },
  { re: /(θαλασσ|παραλι|βουτι|κολυμπ)/, statement: ['Του αρέσει η θάλασσα', 'Αποφεύγει τη θάλασσα'], domain: 'activities', keywords: ['θάλασσα', 'παραλία', 'βουτιά'] },
  { re: /(κλαμπ|club|ξενυχτ|νυχτεριν|παρτι|party|διασκεδα|χορο)/, statement: ['Θέλει νυχτερινή ζωή / διασκέδαση', 'Αποφεύγει κλαμπ και ξενύχτι'], domain: 'social', keywords: ['κλαμπ', 'νυχτερινή ζωή', 'πάρτι', 'dj'] },
  { re: /(γνωρισ|νεα ατομα|νεο κοσμο|καινουργια ατομα|νεουσ ανθρωπουσ)/, statement: ['Θέλει να γνωρίσει νέο κόσμο', 'Δεν θέλει πολύ κόσμο'], domain: 'social', keywords: ['γνωριμίες', 'κόσμος', 'κοινωνικό', 'μπαρ'] },
  { re: /(μουσει|ιστορι|αρχαι|αξιοθεατ|καστρο|πολιτισμ)/, statement: ['Του αρέσουν πολιτισμός και αξιοθέατα', 'Βαριέται μουσεία και αξιοθέατα'], domain: 'activities', keywords: ['μουσείο', 'κάστρο', 'αξιοθέατα', 'ιστορία'] },
  { re: /(σινεμα|ταινι)/, statement: ['Του αρέσει το σινεμά', 'Δεν τον ενδιαφέρει το σινεμά'], domain: 'activities', keywords: ['σινεμά', 'ταινία'] },
  { re: /(επιτραπεζ|board game)/, statement: ['Του αρέσουν τα επιτραπέζια', 'Δεν του αρέσουν τα επιτραπέζια'], domain: 'social', keywords: ['επιτραπέζια', 'board game'] },
  { re: /(καλο φαγητο|φαγητο|ταβερν|εστιατορ|κρασι|γαστρονομ)/, statement: ['Δίνει σημασία στο καλό φαγητό', 'Δεν δίνει σημασία στο φαγητό'], domain: 'food', keywords: ['φαγητό', 'ταβέρνα', 'εστιατόριο', 'κρασί'] },
  { re: /(ησυχ|ξεκουρασ|ηρεμ|χαλαρωσ)/, statement: ['Θέλει ησυχία και ξεκούραση', 'Δεν θέλει κάτι πολύ ήσυχο'], domain: 'comfort', keywords: ['ήσυχο', 'ησυχία', 'χαλαρό', 'ξεκούραση'] },
  { re: /(κρεβατι|ανεση|ανετ|ξενοδοχει|ζεστο ντουσ|ιδιωτικο μπανιο|δικο μασ μπανιο)/, statement: ['Θέλει άνετη διαμονή', 'Δεν τον νοιάζει η άνεση'], domain: 'comfort', keywords: ['ξενοδοχείο', 'ιδιωτικό μπάνιο', 'άνετο', 'δίκλινα'] },
];

function weekdayIn(n: string): number | null {
  for (const [d, re] of WEEKDAY_RE) if (re.test(n)) return d;
  return null;
}

function categoriesFor(n: string): Category[] {
  if (/(διημερ|τριημερ|ταξιδ|εκδρομ|σκ |σαββατοκυριακ|διαμονη)/.test(n)) return ['trip'];
  if (/(φαγητ|εξοδο|δειπν|βραδυ|ποτο)/.test(n)) return ['food', 'entertainment'];
  return [];
}

/** Extract generic memory drafts from free text (owner sources, or a one-off wish). */
export function extractWithRules(text: string): MemoryDraft[] {
  const out: MemoryDraft[] = [];
  for (const s of sentences(text)) {
    const n = normalizeGreek(s);
    const neg = NEG.test(n);
    const quote = s.replace(/[.!;;]+$/, '');

    const budget =
      n.match(/(οριο|μεχρι|εωσ|το πολυ|max|budget)\D{0,15}?(\d{2,4})(?:\s*-\s*(\d{2,4}))?\s*(€|ευρω)/) ??
      (neg ? n.match(/(πανω απο|παραπανω απο)\D{0,5}?(\d{2,4})()\s*(€|ευρω)/) : null);
    if (budget) {
      const v = Number(budget[3] || budget[2]);
      out.push({ kind: 'constraint', statement: `Όριο κόστους ${v}€ ανά άτομο`, domain: 'money', polarity: 'neutral', strength: 1, hard: true, rule: { metric: 'max_cost', value: String(v) }, categories: categoriesFor(n), keywords: [], quote, confidence: 0.7 });
    }
    if (/(φθην|φτην|οικονομικ|χαμηλο κοστοσ|δεν τ[οα] δινω|να μη σκασουμε)/.test(n)) {
      out.push({ kind: 'preference', statement: 'Προτιμά χαμηλό κόστος', domain: 'money', polarity: 'likes', strength: 0.6, hard: false, categories: [], keywords: ['φθηνό', 'οικονομικό'], quote, confidence: 0.6 });
    }

    if (/(πισω|επιστροφ|γυρισ|γυρνα|να ειμαι αθηνα|στην αθηνα)/.test(n)) {
      const wd = weekdayIn(n);
      const t = n.match(/(\d{1,2})[:.](\d{2})/);
      if (wd !== null) {
        const hh = t ? Number(t[1]) : 23;
        const mm = t ? Number(t[2]) : 59;
        const label = t ? `${['Κυριακή', 'Δευτέρα', 'Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή', 'Σάββατο'][wd]} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` : ['Κυριακή', 'Δευτέρα', 'Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή', 'Σάββατο'][wd];
        out.push({ kind: 'constraint', statement: `Επιστροφή το αργότερο ${label}`, domain: 'schedule', polarity: 'neutral', strength: 1, hard: true, rule: { metric: 'latest_end', value: `weekly:${wd}:${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` }, categories: [], keywords: [], quote, confidence: 0.7 });
      }
    }

    if (/σκην/.test(n) && neg) out.push({ kind: 'constraint', statement: 'Δεν κοιμάται σε σκηνή', domain: 'comfort', polarity: 'avoids', strength: 1, hard: true, categories: ['trip'], keywords: ['σκηνή', 'κάμπινγκ'], quote, confidence: 0.7 });
    if (/(χορτοφαγ|vegan|χωρισ κρεασ)/.test(n)) out.push({ kind: 'constraint', statement: 'Χορτοφάγος — χρειάζεται επιλογές χωρίς κρέας', domain: 'food', polarity: 'likes', strength: 1, hard: true, categories: ['food'], keywords: ['χορτοφαγικ', 'χωρίς κρέας', 'vegan'], quote, confidence: 0.7 });
    if (/(δικο μασ μπανιο|ιδιωτικο μπανιο)/.test(n) && /(οπωσδηποτε|μονο|πρεπει|απαραιτητ)/.test(n)) {
      out.push({ kind: 'constraint', statement: 'Απαραίτητο ιδιωτικό μπάνιο', domain: 'comfort', polarity: 'likes', strength: 1, hard: true, categories: ['trip'], keywords: ['ιδιωτικό μπάνιο'], quote, confidence: 0.7 });
    }
    if (/(πριν τισ \d|στισ [5-7] το πρωι|πρωινοσ τυποσ|πρωινη αναχωρηση)/.test(n) && neg) {
      out.push({ kind: 'preference', statement: 'Αποφεύγει τις πολύ πρωινές αναχωρήσεις', domain: 'schedule', polarity: 'avoids', strength: 0.5, hard: false, categories: [], keywords: ['06:', '07:', 'ξημερώματα', 'πολύ νωρίς'], quote, confidence: 0.6 });
    }

    for (const t of TOPICS) {
      if (!t.re.test(n)) continue;
      out.push({ kind: 'preference', statement: neg ? t.statement[1] : t.statement[0], domain: t.domain, polarity: neg ? 'avoids' : 'likes', strength: t.strength ?? 0.6, hard: false, categories: t.categories ?? [], keywords: t.keywords, quote, confidence: 0.6 });
    }
  }
  const seen = new Set<string>();
  return out.filter((d) => (seen.has(d.statement) ? false : (seen.add(d.statement), true)));
}

/** Demo request understanding: category + planning window. */
export function parseRequestWithRules(text: string, now: Date): { title: string; category: Category; periodStart: string; periodEnd: string } {
  const n = normalizeGreek(text);
  const title = text.trim().replace(/\s+/g, ' ').slice(0, 70);
  if (/(τριημερ|τριημερο)/.test(n)) {
    const w = upcomingWeekend(now, 3);
    return { title, category: 'trip', periodStart: w.start, periodEnd: w.end };
  }
  if (/(διημερ|ταξιδ|εκδρομ|σαββατοκυριακ|σκ\b|διακοπ)/.test(n)) {
    const w = upcomingWeekend(now, 2);
    return { title, category: 'trip', periodStart: w.start, periodEnd: w.end };
  }
  const fri = upcomingWeekend(now, 3).start.replace('T18:00', 'T21:00');
  if (/(φαγητ|φαμε|δειπν|εστιατορ|ταβερν|μεσημεριαν)/.test(n)) return { title, category: 'food', periodStart: fri, periodEnd: fri };
  if (/(δωρο|δωρα)/.test(n)) return { title, category: 'gift', periodStart: fri, periodEnd: fri };
  if (/(ταινι|σινεμα|εξοδο|ποτο|μπαρ|βραδια|παρτι|κλαμπ)/.test(n)) return { title, category: 'entertainment', periodStart: fri, periodEnd: fri };
  return { title, category: 'activity', periodStart: fri, periodEnd: fri };
}

/** Demo evaluator: keyword match between a twin's memory and an option's text. */
export function evaluateWithRules(personaId: string, items: MemoryItem[], options: CandidateOption[]): Evaluation[] {
  const costs = options.map((o) => o.costPerPerson).filter((c): c is number => c !== null);
  const min = Math.min(...costs);
  const max = Math.max(...costs);
  const soft = items.filter((m) => !m.hard && (m.kind === 'preference' || m.kind === 'decision_pattern'));
  const hardQual = items.filter((m) => m.hard && !m.rule && m.keywords.length);
  return options.map((o) => {
    const text = normalizeGreek([o.title, o.summary, o.location, ...o.features].join(' '));
    const has = (m: MemoryItem) => m.keywords.some((k) => text.includes(normalizeGreek(k)));
    let sum = 0;
    let den = 0;
    const reasons: Evaluation['reasons'] = [];
    for (const m of soft) {
      den += m.strength;
      let c = 0;
      if (m.domain === 'money' && m.polarity === 'likes' && o.costPerPerson !== null && max > min) {
        c = ((1 - (o.costPerPerson - min) / (max - min)) * 2 - 1) * m.strength;
        if (Math.abs(c) > 0.15) reasons.push({ memoryId: m.id, effect: c > 0 ? 'for' : 'against', text: `${o.costPerPerson}€/άτομο — ${c > 0 ? 'από τις φθηνότερες' : 'από τις ακριβότερες'} επιλογές («${m.statement}»)` });
      } else if (m.keywords.length && has(m) && m.polarity !== 'neutral') {
        c = (m.polarity === 'likes' ? 1 : -1) * m.strength;
        reasons.push({ memoryId: m.id, effect: c > 0 ? 'for' : 'against', text: `${c > 0 ? 'Ταιριάζει με' : 'Αντίθετο με'} «${m.statement}»` });
      }
      sum += c;
    }
    const violations: Evaluation['violations'] = [];
    for (const m of hardQual) {
      const match = has(m);
      if (m.polarity === 'avoids' && match) violations.push({ memoryId: m.id, text: `έχει κάτι που αποκλείει: «${m.statement}»` });
      if (m.polarity === 'likes' && !match) violations.push({ memoryId: m.id, text: `δεν φαίνεται να καλύπτει: «${m.statement}»` });
    }
    const score = Math.round(clamp(50 + (60 * sum) / Math.max(den, 1), 3, 97));
    return {
      personaId,
      optionId: o.id,
      score,
      verdict: score >= 65 ? 'Μου ταιριάζει' : score >= 40 ? 'Μπορώ να το δεχτώ' : 'Δεν μου ταιριάζει',
      reasons: reasons.sort((a, b) => (a.effect === b.effect ? 0 : a.effect === 'for' ? -1 : 1)).slice(0, 4),
      violations,
      unknowns: reasons.length ? [] : ['Καμία ανάμνηση δεν αφορά αυτή την επιλογή — ουδέτερη βαθμολογία.'],
    };
  });
}
