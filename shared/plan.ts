// Concrete, followable proposals — checked in code BEFORE the twins vote.
//  - Local plans (coffee, drinks, club, live, dinner): a NAMED place inside the requested
//    area/city, a time and an estimated cost. "Κάπου στα Ιλίσια" or "καφέ κοντά στο Σύνταγμα"
//    is rejected. Live music: the venue may be known, the programme is never promised.
//  - Trips: a full day-by-day itinerary (departure, stay, slots per day, return to the origin,
//    cost breakdown) that must cover every day, run in order without overlaps and add up.
//  - Every proposal carries per-detail checks: confirmed / estimated / to check.
//  - Each slot or reason is tied to a real memory id of the right twin.

import { normalizeGreek } from './text';
import { localParts, parseIso } from './time';
import type { CandidateOption, Category, GroupRequest, Itinerary, MemoryItem, OptionCheck, PersonaId, RequestKind, Venue, WishCoverage, WishLink } from './types';

export const LOCAL_KINDS: RequestKind[] = ['coffee', 'drinks', 'club', 'live', 'dinner'];

export const KIND_CATEGORY: Record<RequestKind, Category> = {
  coffee: 'entertainment',
  drinks: 'entertainment',
  club: 'entertainment',
  live: 'entertainment',
  dinner: 'food',
  trip: 'trip',
  activity: 'activity',
  gift: 'gift',
  other: 'other',
};

export const KIND_LABEL: Record<RequestKind, string> = {
  coffee: 'Καφές',
  drinks: 'Ποτό',
  club: 'Club',
  live: 'Live μουσική',
  dinner: 'Φαγητό',
  trip: 'Ταξίδι',
  activity: 'Δραστηριότητα',
  gift: 'Δώρο',
  other: 'Άλλο',
};

/** Demo-mode / fallback understanding of what was asked. */
export function kindFromText(text: string): RequestKind | null {
  const n = normalizeGreek(text);
  // A trip that includes a club night is still a trip.
  if (/(ταξιδ|εκδρομ|διημερ|τριημερ|τετραημερ|πενθημερ|\d\s*-?\s*ημερ|διακοπ|εξωτερικ)/.test(n)) return 'trip';
  if (/(μπουζουκ|συναυλι|live|λαιβ|ζωντανη μουσικη|jazz|τζαζ)/.test(n)) return 'live';
  if (/(club|κλαμπ|clubbing|χορο μεχρι)/.test(n)) return 'club';
  if (/(ποτο|ποτακι|cocktail|κοκτειλ|μπαρ|bar|κρασι|wine|μπυρα)/.test(n)) return 'drinks';
  if (/(καφε|καφεδακι|coffee|διαβασμα σε καφε|brunch)/.test(n)) return 'coffee';
  if (/(φαγητ|φαμε|δειπν|εστιατορ|ταβερν|μεσημεριαν|τσιπουραδ|μεζε)/.test(n)) return 'dinner';
  if (/(ταξιδ|εκδρομ|διημερ|τριημερ|τετραημερ|πενθημερ|\d\s*-?\s*ημερ|σαββατοκυριακ|διακοπ|εξωτερικ)/.test(n)) return 'trip';
  if (/(δωρο|δωρα)/.test(n)) return 'gift';
  return null;
}

const CITIES: [RegExp, string][] = [
  [/θεσσαλονικ|σαλονικ/, 'Θεσσαλονίκη'],
  [/αθηνα|αθηνων/, 'Αθήνα'],
  [/πειραι/, 'Πειραιάς'],
  [/πατρα/, 'Πάτρα'],
  [/ηρακλει/, 'Ηράκλειο'],
  [/λαρισα/, 'Λάρισα'],
  [/βολο/, 'Βόλος'],
  [/ιωαννιν|γιαννεν/, 'Ιωάννινα'],
];

/** City stated in a LOCAL request ("είμαστε στη Θεσσαλονίκη", "καφέ στη Θεσσαλονίκη"). */
export function cityFromText(text: string): string | null {
  const n = normalizeGreek(text);
  for (const [re, name] of CITIES) if (re.test(n)) return name;
  return null;
}

/** Known neighbourhoods, so the demo can read "Ιλίσια", "Παγκράτι", "Καμάρα"… */
const AREAS = ['Παγκράτι', 'Ιλίσια', 'Ζωγράφου', 'Εξάρχεια', 'Κουκάκι', 'Ψυρρή', 'Μοναστηράκι', 'Σύνταγμα', 'Κολωνάκι', 'Πλάκα', 'Θησείο', 'Μετς', 'Γκάζι', 'Νέος Κόσμος', 'Κέντρο', 'Ναυαρίνου', 'Καμάρα', 'Λαδάδικα', 'Βαλαωρίτου'];
export function areaFromText(text: string): string {
  const n = normalizeGreek(text);
  return AREAS.filter((a) => n.includes(normalizeGreek(a).slice(0, Math.max(5, normalizeGreek(a).length - 2)))).join(' ή ');
}

export function areasOf(area: string | undefined | null): string[] {
  return (area ?? '')
    .split(/\s+(?:ή|η|και|or)\s+|\s*[,/]\s*/i)
    .map((a) => normalizeGreek(a).trim())
    .filter((a) => a.length >= 3);
}

const CENTRE = ['κεντρο', 'ιστορικο κεντρο', 'ψυρρη', 'μοναστηρακι', 'συνταγμα', 'πλακα', 'θησειο', 'κολωνακι', 'εξαρχεια', 'κεραμεικο', 'γκαζι', 'μακρυγιανν', 'κουκακι', 'ομονοια', 'αγια ειρηνη'];
/** Places next to each other count as the same area for a walk-in plan. */
const NEAR: Record<string, string[]> = {
  καμαρα: ['ναυαρινου', 'κεντρο'],
  ναυαρινου: ['καμαρα', 'κεντρο'],
  ζωγραφου: ['ιλισια'],
  ιλισια: ['ζωγραφου'],
  παγκρατι: ['μετς'],
};

/** Is the venue inside one of the requested areas? */
export function inArea(v: Pick<Venue, 'area' | 'address'>, areas: string[]): boolean {
  if (!areas.length) return true;
  const where = normalizeGreek(`${v.area} ${v.address ?? ''}`);
  return areas.some((a) => {
    const stem = a.slice(0, Math.max(4, a.length - 2));
    if (where.includes(stem)) return true;
    if (a.includes('κεντρ') && CENTRE.some((c) => where.includes(c))) return true;
    return (NEAR[a] ?? []).some((x) => where.includes(x));
  });
}

const GENERIC = [
  /(^|\s)(καπου|καποιο|καποια|οποιοδηποτε|διαφορα|μπαρακια|μαγαζια)(\s|$)/,
  /ενα (μαγαζι|καφε|μπαρ|απο τα|απο τους|απο τις)/,
  /(στην οδο|στον πεζοδρομο|της οδου|στην περιοχη|γυρω απο|κοντα σ)/,
  /^(καφε|καφεσ|καφετερια|μπαρ|bar|club|κλαμπ|ταβερνα|εστιατοριο|wine bar|cocktail bar|μπουζουκια|live)\s+(στο|στη|στην|στα|στισ|στον|τησ|του)(\s|$)/,
];
/** "Καφέ κοντά στο Σύνταγμα", "Κάπου στα Ιλίσια", "ένα μαγαζί στην Ηπίτου" are not places you can go to. */
export function isGenericVenue(name: string | undefined | null): boolean {
  const n = normalizeGreek(name ?? '').trim();
  if (n.length < 3) return true;
  return GENERIC.some((re) => re.test(n));
}

/** Local plan: named place in the requested city/area, of the requested kind. */
export function validateLocal(o: CandidateOption, req: Pick<GroupRequest, 'kind' | 'city' | 'area'>): string | null {
  const v = o.venue;
  if (!v?.name) return 'χωρίς συγκεκριμένο μαγαζί';
  if (isGenericVenue(v.name)) return `«${v.name}» δεν είναι συγκεκριμένο μαγαζί`;
  if (req.city && v.city && !normalizeGreek(v.city).includes(normalizeGreek(req.city).slice(0, 5))) return `είναι στην πόλη ${v.city}, όχι ${req.city}`;
  const areas = areasOf(req.area);
  if (areas.length && !inArea(v, areas)) return `είναι στην περιοχή ${v.area || '?'}, όχι ${req.area}`;
  const k = normalizeGreek(`${v.kind}`);
  if (req.kind === 'coffee' && /(club|κλαμπ|μπουζουκ)/.test(k) && !/(καφε|cafe|coffee)/.test(k)) return `είναι ${v.kind}, όχι καφέ`;
  if (req.kind === 'club' && /(καφε|cafe|coffee)/.test(k) && !/(bar|μπαρ|club)/.test(k)) return `είναι ${v.kind}, όχι club`;
  if (!o.startsAt) return 'χωρίς ώρα';
  return null;
}

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

const hm = (s: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h <= 24 && mm < 60 ? h * 60 + mm : null;
};
const ymd = (d: Date) => {
  const p = localParts(d);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
};

/** Calendar dates (Athens) from start to end inclusive. */
export function datesBetween(start: string | null, end: string | null): string[] {
  const s = parseIso(start);
  const e = parseIso(end);
  if (!s || !e || e < s) return s ? [ymd(s)] : [];
  const out: string[] = [];
  for (let t = s.getTime(); out.length < 15; t += 86400000) {
    const d = ymd(new Date(t));
    if (out.at(-1) !== d) out.push(d);
    if (d === ymd(e)) break;
  }
  return out;
}

/** Errors that make a trip plan unusable (empty list = valid). */
export function validateItinerary(it: Itinerary | undefined, periodStart: string | null, periodEnd: string | null): string[] {
  if (!it) return ['χωρίς πρόγραμμα ανά ημέρα'];
  const errors: string[] = [];
  const dates = datesBetween(periodStart, periodEnd);
  const byDate = new Map(it.days.map((d) => [d.date, d]));
  for (const d of dates) if (!byDate.get(d)?.slots.length) errors.push(`λείπει πρόγραμμα για ${d}`);
  for (const day of it.days) {
    let prevEnd = -1;
    for (const s of day.slots) {
      const a = hm(s.start);
      let b = hm(s.end);
      if (a === null || b === null) {
        errors.push(`${day.date}: μη έγκυρη ώρα «${s.start}–${s.end}»`);
        continue;
      }
      if (b <= a) b += 24 * 60; // runs past midnight
      if (a < prevEnd) errors.push(`${day.date}: επικαλύπτεται «${s.title}» με την προηγούμενη στάση`);
      prevEnd = b;
    }
  }
  const dep = parseIso(it.depart.at);
  const ret = parseIso(it.return.at);
  if (!dep || !ret) errors.push('χωρίς ώρα αναχώρησης ή επιστροφής');
  else if (ret <= dep) errors.push('η επιστροφή είναι πριν την αναχώρηση');
  else if (dates.length && (ymd(dep) !== dates[0] || ymd(ret) < dates.at(-1)!)) errors.push(`αναχώρηση/επιστροφή εκτός των ημερών ${dates[0]} → ${dates.at(-1)}`);
  else {
    // The last stop of the plan and the stated arrival back home must tell the same story.
    const last = it.days.find((d) => d.date === ymd(ret))?.slots.at(-1);
    const end = last ? hm(last.end) : null;
    const p = localParts(ret);
    if (end !== null && Math.abs(end - (p.hh * 60 + p.mm)) > 120) errors.push(`η ώρα επιστροφής (${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}) δεν συμφωνεί με το τέλος του προγράμματος (${last!.end})`);
  }
  const c = it.cost;
  const sum = c.transport + c.stay + c.food + c.activities;
  if (!(c.total > 0) || Math.abs(sum - c.total) > Math.max(5, c.total * 0.03)) errors.push(`τα σύνολα κόστους δεν συμφωνούν (${sum}€ ≠ ${c.total}€)`);
  return errors;
}

// ---------------------------------------------------------------------------
// Checks, wish links, coverage
// ---------------------------------------------------------------------------

export function matchVenue(name: string, catalogue: Venue[]): Venue | undefined {
  const n = normalizeGreek(name);
  return catalogue.find((v) => {
    const c = normalizeGreek(v.name);
    return c.length >= 4 && (n.includes(c) || c.includes(n));
  });
}

export function buildChecks(o: CandidateOption, req: Pick<GroupRequest, 'kind'>, mentionsMetro: boolean): OptionCheck[] {
  const checks: OptionCheck[] = [];
  const v = o.venue;
  if (v) {
    checks.push(
      v.catalogId
        ? { field: 'existence', status: 'confirmed', text: `Υπάρχει σε δημόσια καταχώριση${v.address ? ` · ${v.address}` : ''}`, source: v.source, url: v.url, date: v.checkedAt }
        : { field: 'existence', status: 'to_check', text: o.synthetic ? 'Συνθετικό fixture του demo — όχι πραγματικό μαγαζί' : 'Όνομα από το AI — ύπαρξη και διεύθυνση προς επιβεβαίωση' },
    );
    checks.push({ field: 'open', status: 'to_check', text: 'Ωράριο τη συγκεκριμένη μέρα και ώρα: προς επιβεβαίωση' });
  }
  if (req.kind === 'live' || o.event) checks.push({ field: 'program', status: 'to_check', text: 'Πρόγραμμα προς επιβεβαίωση για τη συγκεκριμένη ημερομηνία (καλλιτέχνης, ώρα, είσοδος)' });
  checks.push(o.costPerPerson === null ? { field: 'price', status: 'to_check', text: 'Κόστος άγνωστο' } : { field: 'price', status: 'estimated', text: `≈${o.costPerPerson}€/άτομο — εκτίμηση, όχι τιμή καταστήματος` });
  if (o.itinerary) {
    checks.push({ field: 'existence', status: 'to_check', text: o.synthetic ? 'Συνθετικό fixture του demo — αξιοθέατα πραγματικά, ώρες/τιμές ενδεικτικές' : 'Ονόματα χώρων στο πρόγραμμα (π.χ. club, μουσείο) από το AI — ύπαρξη και ωράρια προς επιβεβαίωση' });
    checks.push({ field: 'route', status: 'estimated', text: `${o.itinerary.depart.mode} / ${o.itinerary.return.mode}: ώρες και τιμές εκτίμηση, χωρίς live έλεγχο δρομολογίων` });
    checks.push({ field: 'availability', status: 'to_check', text: 'Διαθεσιμότητα και τιμή διαμονής προς επιβεβαίωση' });
  } else if (mentionsMetro) {
    checks.push({ field: 'route', status: 'to_check', text: 'Επιστροφή με μετρό: εκκρεμεί έλεγχος τελευταίου συρμού για την ώρα λήξης' });
  }
  return checks;
}

/** Keep only links to real memory items of the SAME twin. */
export function cleanLinks<T extends { personaId: PersonaId; memoryId: string }>(links: T[], owner: Map<string, PersonaId>): T[] {
  const seen = new Set<string>();
  return links.filter((l) => owner.get(l.memoryId) === l.personaId && !seen.has(l.memoryId + l.personaId) && seen.add(l.memoryId + l.personaId));
}

/** Which of each twin's wishes the plan covers, only under a condition, or leaves out. */
export function coverageOf(o: CandidateOption, wishes: MemoryItem[], all: MemoryItem[] = wishes): WishCoverage[] {
  // The same group ask is stored once per participant: a link to any copy counts.
  const same = (id: string, m: MemoryItem) => id === m.id || all.find((x) => x.id === id)?.statement === m.statement;
  return wishes.map((m) => {
    const slots = o.itinerary?.days.flatMap((d) => d.slots.filter((s) => s.serves.some((x) => same(x.memoryId, m))).map((s) => ({ s, d }))) ?? [];
    const why = o.why?.find((w) => same(w.memoryId, m));
    const firm = slots.find(({ s }) => !s.conditional);
    const where = firm ? `${firm.d.title || firm.d.date} — ${firm.s.title}` : slots[0] ? `${slots[0].d.title || slots[0].d.date} — ${slots[0].s.title}` : why?.text;
    // A reason can also say what is NOT covered ("δεν εξασφαλίζει live μουσική").
    const w = normalizeGreek(why?.text ?? '');
    const whyStatus: WishCoverage['status'] | null = !why ? null : /(δεν |χωρισ |λειπει)/.test(w) ? 'uncovered' : /(αν |εφοσον|προυποθεσ|επιβεβαιωσ|ελεγχ)/.test(w) ? 'conditional' : 'covered';
    const metro = /(μετρο|συρμ)/.test(normalizeGreek(m.statement)) && o.checks?.some((c) => c.field === 'route' && c.status === 'to_check');
    const status: WishCoverage['status'] = firm ? 'covered' : whyStatus ?? (slots.length || metro ? 'conditional' : 'uncovered');
    if (metro && !where) return { personaId: m.personaId, memoryId: m.id, statement: m.statement, status, where: 'εκκρεμεί έλεγχος τελευταίου συρμού' };
    return { personaId: m.personaId, memoryId: m.id, statement: m.statement, status, where };
  });
}

/**
 * The wishes a plan should answer to: each twin's own wishes for this request, the group's qualitative asks
 * (once), and — for trips — each twin's strongest likes (max 2 each).
 */
export function planWishes(items: MemoryItem[], isGroupItem: (m: MemoryItem) => boolean, trip = true): MemoryItem[] {
  const qualitative = (m: MemoryItem) => !m.rule && m.status === 'confirmed' && m.scope === 'request' && m.polarity !== 'avoids';
  const own = items.filter((m) => qualitative(m) && !isGroupItem(m));
  const seen = new Set<string>();
  const group = items.filter((m) => qualitative(m) && isGroupItem(m) && !seen.has(m.statement) && seen.add(m.statement));
  if (!trip) return [...own, ...group];
  const likes = items.filter((m) => !m.rule && m.status === 'confirmed' && m.scope === 'profile' && !m.hard && m.polarity === 'likes' && m.strength >= 0.7 && m.kind !== 'style');
  const per = new Map<string, number>();
  const strongest = [...likes]
    .sort((a, b) => Number(b.hard) - Number(a.hard) || b.strength - a.strength)
    .filter((m) => {
      const n = (per.get(m.personaId) ?? 0) + (own.some((o) => o.personaId === m.personaId) ? 1 : 0);
      if (n >= 2) return false;
      per.set(m.personaId, (per.get(m.personaId) ?? 0) + 1);
      return true;
    });
  return [...own, ...group, ...strongest];
}

/** Demo / fallback: link plan slots and reasons to memory by keywords (the AI links them itself in live mode). */
export function linkByKeywords(text: string, items: MemoryItem[]): { personaId: PersonaId; memoryId: string; statement: string }[] {
  const n = normalizeGreek(text);
  return items
    .filter((m) => m.polarity !== 'avoids' && m.keywords.some((k) => k.length >= 3 && n.includes(normalizeGreek(k))))
    .map((m) => ({ personaId: m.personaId, memoryId: m.id, statement: m.statement }));
}

export interface PrepareInput {
  req: Pick<GroupRequest, 'kind' | 'city' | 'area' | 'periodStart' | 'periodEnd' | 'text'>;
  /** Every item the twins brought (to verify ids). */
  items: MemoryItem[];
  /** What the plan should answer to (each twin's own wishes + strict needs); see planWishes. */
  wishes: MemoryItem[];
  wishText: string;
  catalogue: Venue[];
}

/** Validate and enrich options before the twins vote. Invalid ones are returned with a reason. */
export function prepareOptions(options: CandidateOption[], inp: PrepareInput): { valid: CandidateOption[]; rejected: { title: string; reason: string }[] } {
  const { req } = inp;
  const owner = new Map(inp.items.map((m) => [m.id, m.personaId]));
  const wishes = inp.wishes;
  const metro = /(μετρο|metro|συρμ|ηλεκτρικ)/.test(normalizeGreek(`${req.text} ${inp.wishText}`));
  const local = !!req.kind && LOCAL_KINDS.includes(req.kind);
  const valid: CandidateOption[] = [];
  const rejected: { title: string; reason: string }[] = [];
  for (const raw of options) {
    const o: CandidateOption = { ...raw };
    if (o.venue) {
      const hit = matchVenue(o.venue.name, inp.catalogue);
      if (hit) o.venue = { ...o.venue, name: hit.name, area: hit.area || o.venue.area, city: hit.city, address: hit.address ?? o.venue.address, catalogId: hit.catalogId, source: hit.source, url: hit.url, checkedAt: hit.checkedAt };
      else o.venue = { ...o.venue, catalogId: undefined, source: undefined, url: undefined, checkedAt: undefined };
    }
    if (o.why) o.why = cleanLinks<WishLink>(o.why, owner);
    if (o.itinerary) {
      o.itinerary = { ...o.itinerary, days: o.itinerary.days.map((d) => ({ ...d, slots: d.slots.map((s) => ({ ...s, serves: cleanLinks(s.serves, owner) })) })) };
      o.costPerPerson = Math.round(o.itinerary.cost.total);
      o.startsAt = o.itinerary.depart.at;
      o.endsAt = o.itinerary.return.at;
    }
    let reason: string | null = null;
    if (req.kind === 'trip' && o.origin === 'ai') reason = validateItinerary(o.itinerary, req.periodStart, req.periodEnd)[0] ?? null;
    else if (req.kind === 'trip' && o.itinerary) reason = validateItinerary(o.itinerary, req.periodStart, req.periodEnd)[0] ?? null;
    else if (local && (o.origin === 'ai' || o.venue)) reason = validateLocal(o, req);
    if (reason) {
      rejected.push({ title: o.title, reason });
      continue;
    }
    if (req.kind === 'live' && o.venue) {
      // We know the place, not who plays that night: never present it as a confirmed event.
      o.event = { status: 'unconfirmed', note: 'Πρόγραμμα προς επιβεβαίωση για τη συγκεκριμένη ημερομηνία' };
      o.title = `${o.venue.name} — πρόγραμμα προς επιβεβαίωση`;
    }
    o.costEstimated = true;
    o.checks = buildChecks(o, req, metro);
    o.coverage = coverageOf(o, wishes, inp.items);
    valid.push(o);
  }
  return { valid, rejected };
}
