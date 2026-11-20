// DEMO MODE ONLY (no API key): deterministic rules that stand in for the model,
// so the app always runs. Clearly labelled as "demo" everywhere in the UI.

import { clamp, normalizeGreek, sentences } from './text';
import { areaFromText, cityFromText, KIND_CATEGORY, kindFromText } from './plan';
import { athensIso, localParts, upcomingWeekend } from './time';
import type { CandidateOption, Category, Domain, Evaluation, MemoryContext, MemoryItem, MemoryKind, NumericRule, Polarity, RequestKind } from './types';

export interface MemoryDraft {
  kind: MemoryKind;
  statement: string;
  domain: Domain;
  polarity: Polarity;
  strength: number;
  hard: boolean;
  rule?: NumericRule;
  context?: MemoryContext;
  categories: Category[];
  keywords: string[];
  quote: string;
  confidence: number;
}

/** Context a sentence was said in: "για ένα διήμερο" = 2 days in Greece, "στο εξωτερικό" = abroad. */
export function contextOf(n: string): MemoryContext {
  const where: MemoryContext['where'] = /(εξωτερικ|ευρωπ|abroad|πτησ|αεροπλαν)/.test(n)
    ? 'abroad'
    : /(ελλαδα|εκδρομ|διημερ|τριημερ|σαββατοκυριακ|νησι)/.test(n)
      ? 'domestic'
      : /(εξοδο|βραδυ|φαγητ|ποτο|μπαρ|ταβερν)/.test(n)
        ? 'local'
        : 'any';
  const num = n.match(/(\d)\s*(μερ|ημερ|νυχτ|βραδι)/);
  const digitDays = n.match(/(\d)\s*-?\s*ημερ/);
  const days = /διημερ|σαββατοκυριακ/.test(n) ? 2 : /τριημερ/.test(n) ? 3 : /τετραημερ/.test(n) ? 4 : /πενθημερ/.test(n) ? 5 : digitDays ? Number(digitDays[1]) : num ? Number(num[1]) : 0;
  return { where, days };
}

/** "Συνήθως / περίπου" = a habit, not a limit. Only explicit absolutes become hard. */
const HABITUAL = /(συνηθωσ|συνηθισμεν|περιπου|γυρω στα|κατα μεσο|αναλογα|ενδεικτικ|συχνα)/;
const ABSOLUTE = /(οριο|το πολυ|δεν μπορω|δεν δινω|δεν βγαινω|σε καμια περιπτωση|αυστηρ|οπωσδηποτε|max)/;

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
/** Only the owner's own words: drop interviewer questions (Ε:) and summaries written by someone else. */
export function ownerText(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*(\*\*)?\s*(Ε|Q)\s*:/.test(l) && !/^\s*\(?\s*Σύνοψη/i.test(l))
    .map((l) => l.replace(/^\s*(\*\*)?\s*(Α|A)\s*:\s*(\*\*)?\s*/, ''))
    .join('\n');
}

export function extractWithRules(text: string): MemoryDraft[] {
  const out: MemoryDraft[] = [];
  for (const s of sentences(ownerText(text))) {
    const n = normalizeGreek(s);
    const neg = NEG.test(n);
    const quote = s.replace(/[.!;;]+$/, '');

    const budget =
      n.match(/(οριο|μεχρι|εωσ|(?<![α-ω])ωσ|το πολυ|max|budget|≤|<=)\D{0,15}?(\d{1,4})(?:\s*-\s*(\d{1,4}))?\s*(€|ευρω)/) ??
      (neg ? n.match(/(πανω απο|παραπανω απο)\D{0,5}?(\d{2,4})()\s*(€|ευρω)/) : null);
    if (budget) {
      // A sentence about a money limit is not a statement about the topic itself ("όχι πάνω από 30€ για φαγητό").
      const v = Number(budget[3] || budget[2]);
      const hard = !HABITUAL.test(n) && (ABSOLUTE.test(n) || (neg && /(πανω απο|παραπανω)/.test(n)));
      const context = contextOf(n);
      const where = context.where === 'abroad' ? ' (εξωτερικό)' : context.where === 'domestic' ? ' (Ελλάδα)' : '';
      const span = context.days ? ` για ${context.days} μέρες` : '';
      out.push({
        kind: hard ? 'constraint' : 'preference',
        statement: hard ? `Όριο κόστους ${v}€ ανά άτομο${span}${where}` : `Συνήθως ξοδεύει έως ~${v}€ ανά άτομο${span}${where} — ενδεικτικά`,
        domain: 'money', polarity: 'neutral', strength: hard ? 1 : 0.6, hard, rule: { metric: 'max_cost', value: String(v) }, context, categories: categoriesFor(n), keywords: [], quote, confidence: 0.7,
      });
    }
    if (/(φθην|φτην|οικονομικ|χαμηλο κοστοσ|δεν τ[οα] δινω|να μη σκασουμε)/.test(n)) {
      out.push({ kind: 'preference', statement: 'Προτιμά χαμηλό κόστος', domain: 'money', polarity: 'likes', strength: 0.6, hard: false, categories: [], keywords: ['φθηνό', 'οικονομικό'], quote, confidence: 0.6 });
    }

    // "μετά τις 21:30" is when a plan STARTS and "γυρνάμε με μετρό" is HOW, not a return deadline.
    const deadlineWord = /(μεχρι|ωσ|εωσ|πριν|αργοτερ\S*)\s+(τισ\s+|την?\s+|το\s+)?(\d{1,2}[:.]\d{2}|δευτερ|τριτ|τεταρτ|πεμπτ|παρασκευ|σαββατ|κυριακ)/.test(n);
    const notDeadline = !deadlineWord && (/μετα (τισ|απο)/.test(n) || /(γυρναμε|επιστροφη|γυρισμα) με/.test(n));
    if (/(πισω|επιστροφ|γυρισ|γυρνα|να ειμαι αθηνα|στην αθηνα)/.test(n) && !notDeadline) {
      const wd = weekdayIn(n);
      const t = n.match(/(?:μεχρι|ωσ|εωσ|πριν|αργοτερο)\D{0,20}(\d{1,2})[:.](\d{2})/) ?? n.match(/(\d{1,2})[:.](\d{2})/);
      if (wd !== null) {
        const hh = t ? Number(t[1]) : 23;
        const mm = t ? Number(t[2]) : 59;
        const label = t ? `${['Κυριακή', 'Δευτέρα', 'Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή', 'Σάββατο'][wd]} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` : ['Κυριακή', 'Δευτέρα', 'Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή', 'Σάββατο'][wd];
        const hard = !HABITUAL.test(n);
        out.push({ kind: hard ? 'constraint' : 'preference', statement: `Επιστροφή το αργότερο ${label}${hard ? '' : ' (συνήθως)'}`, domain: 'schedule', polarity: 'neutral', strength: hard ? 1 : 0.6, hard, rule: { metric: 'latest_end', value: `weekly:${wd}:${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` }, categories: [], keywords: [], quote, confidence: 0.7 });
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
      if (budget || !t.re.test(n)) continue;
      out.push({ kind: 'preference', statement: neg ? t.statement[1] : t.statement[0], domain: t.domain, polarity: neg ? 'avoids' : 'likes', strength: t.strength ?? 0.6, hard: false, categories: t.categories ?? [], keywords: t.keywords, quote, confidence: 0.6 });
    }
  }
  const seen = new Set<string>();
  return out.filter((d) => (seen.has(d.statement) ? false : (seen.add(d.statement), true)));
}

const MONTHS = ['ιανουαρ', 'φεβρουαρ', 'μαρτ', 'απριλ', 'μαι', 'ιουν', 'ιουλ', 'αυγουστ', 'σεπτεμβρ', 'οκτωβρ', 'νοεμβρ', 'δεκεμβρ'];
const START_TIME: Partial<Record<RequestKind, [number, number, number]>> = {
  // start hh, mm, duration in minutes
  coffee: [17, 0, 120],
  drinks: [21, 30, 180],
  club: [23, 30, 240],
  live: [21, 30, 180],
  dinner: [21, 0, 150],
};

/** Explicit dates: "12 Δεκεμβρίου", "4–7 Δεκεμβρίου". */
function datesIn(n: string, now: Date): { from: [number, number, number]; to?: [number, number, number] } | null {
  const m = n.match(/(\d{1,2})(?:\s*(?:-|–|εως|μεχρι)\s*(\d{1,2}))?\s+(ιανουαρ|φεβρουαρ|μαρτ|απριλ|μαι|ιουν|ιουλ|αυγουστ|σεπτεμβρ|οκτωβρ|νοεμβρ|δεκεμβρ)/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[3]) + 1;
  const p = localParts(now);
  const year = month < p.m || (month === p.m && Number(m[1]) < p.d) ? p.y + 1 : p.y;
  return { from: [year, month, Number(m[1])], to: m[2] ? [year, month, Number(m[2])] : undefined };
}

/** Demo request understanding: kind, category, city/area and the planning window. */
export function parseRequestWithRules(
  text: string,
  now: Date,
): { title: string; category: Category; kind: RequestKind; periodStart: string; periodEnd: string; city: string | null; area: string } {
  const n = normalizeGreek(text);
  const title = text.trim().replace(/\s+/g, ' ').slice(0, 70);
  const kind = kindFromText(text) ?? 'activity';
  const category = KIND_CATEGORY[kind];
  const c = contextOf(n);
  const explicit = datesIn(n, now);
  if (kind === 'trip') {
    if (explicit?.to) {
      const [y, m, d] = explicit.from;
      const [y2, m2, d2] = explicit.to;
      return { title, category, kind, periodStart: athensIso(y, m, d, 9, 0), periodEnd: athensIso(y2, m2, d2, 21, 0), city: null, area: '' };
    }
    const days = c.days >= 2 ? Math.min(c.days, 7) : c.where === 'abroad' ? 4 : 2;
    const w = upcomingWeekend(now, days);
    return { title, category, kind, periodStart: w.start, periodEnd: w.end, city: null, area: '' };
  }
  const [dh, dm, dur] = START_TIME[kind] ?? [21, 0, 150];
  const t = n.match(/(?:στισ|μετα τισ|απο τισ|γυρω στισ)\s*(\d{1,2})(?:[:.](\d{2}))?/);
  const hh = t ? Number(t[1]) : dh;
  const mm = t?.[2] ? Number(t[2]) : t ? 0 : dm;
  const p = localParts(now);
  let day: Date;
  if (explicit) day = new Date(Date.UTC(explicit.from[0], explicit.from[1] - 1, explicit.from[2]));
  else if (/(αποψε|σημερα)/.test(n)) day = new Date(Date.UTC(p.y, p.m - 1, p.d));
  else if (/αυριο/.test(n)) day = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  else {
    const wd = weekdayIn(n) ?? (kind === 'coffee' ? 6 : 5);
    const off = (wd - p.weekday + 7) % 7 || 7;
    day = new Date(Date.UTC(p.y, p.m - 1, p.d + off));
  }
  const start = athensIso(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm);
  const end = new Date(new Date(start).getTime() + dur * 60000);
  const e = localParts(end);
  return { title, category, kind, periodStart: start, periodEnd: athensIso(e.y, e.m, e.d, e.hh, e.mm), city: cityFromText(text), area: areaFromText(text) };
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
