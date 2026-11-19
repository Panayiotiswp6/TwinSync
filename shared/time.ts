// Time helpers in Europe/Athens. Constraint checks (latest_end) run in code.

export const TZ = 'Europe/Athens';
export const WEEKDAYS_EL = ['Κυριακή', 'Δευτέρα', 'Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή', 'Σάββατο'];

interface Parts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  weekday: number;
}

export function localParts(date: Date): Parts {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(date);
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? '';
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { y: +get('year'), m: +get('month'), d: +get('day'), hh: +get('hour') % 24, mm: +get('minute'), weekday: wd };
}

/** UTC offset of Athens at a given instant, e.g. "+02:00". */
function offsetAt(date: Date): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' }).formatToParts(date).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+2';
  const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return '+02:00';
  return `${m[1]}${m[2].padStart(2, '0')}:${m[3] ?? '00'}`;
}

/** Build an Athens-local ISO string for a calendar date + time. */
export function athensIso(y: number, m: number, d: number, hh: number, mm: number): string {
  const probe = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const off = offsetAt(probe);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:00${off}`;
}

export function addDays(iso: string, days: number, hh?: number, mm?: number): string {
  const p = localParts(new Date(iso));
  const base = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return athensIso(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hh ?? p.hh, mm ?? p.mm);
}

export function parseIso(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Next occurrence of `weekday` (0=Sun) at hh:mm, at or after `from` (Athens time). */
export function nextWeekly(from: Date, weekday: number, hh: number, mm: number): Date {
  const p = localParts(from);
  for (let i = 0; i < 8; i++) {
    const day = new Date(Date.UTC(p.y, p.m - 1, p.d + i));
    if (day.getUTCDay() !== weekday) continue;
    const at = new Date(athensIso(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm));
    if (at.getTime() >= from.getTime()) return at;
  }
  return new Date(from.getTime() + 7 * 86400000);
}

/** Resolve a latest_end rule value to a deadline for an option that starts at `start`. */
export function deadlineFor(value: string, start: Date | null): Date | null {
  const weekly = value.match(/^weekly:(\d):(\d{1,2}):(\d{2})$/);
  if (weekly) return nextWeekly(start ?? new Date(), Number(weekly[1]), Number(weekly[2]), Number(weekly[3]));
  return parseIso(value);
}

export function describeDeadline(value: string): string {
  const weekly = value.match(/^weekly:(\d):(\d{1,2}):(\d{2})$/);
  if (weekly) return `${WEEKDAYS_EL[Number(weekly[1])]} ${weekly[2].padStart(2, '0')}:${weekly[3]}`;
  const d = parseIso(value);
  return d ? formatWhen(d.toISOString()) : value;
}

export function formatWhen(iso: string | null): string {
  const d = parseIso(iso);
  if (!d) return '—';
  const p = localParts(d);
  return `${WEEKDAYS_EL[p.weekday]} ${p.d}/${p.m} ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
}

/** Default planning window: the coming weekend (Sat 09:00 → Sun 21:00), or Fri→Sun/Mon for a long weekend. */
export function upcomingWeekend(now: Date, days = 2): { start: string; end: string } {
  const p = localParts(now);
  const offset = (6 - p.weekday + 7) % 7 || 7; // next Saturday
  let startOffset = days >= 3 ? offset - (days - 2) : offset; // 3 days: Friday, 4 days: Thursday…
  if (startOffset < 1) startOffset += 7;
  const sat = new Date(Date.UTC(p.y, p.m - 1, p.d + startOffset));
  const start = athensIso(sat.getUTCFullYear(), sat.getUTCMonth() + 1, sat.getUTCDate(), days >= 3 ? 18 : 9, 0);
  return { start, end: addDays(start, Math.max(days - 1, 0) + (days >= 3 ? 0 : 0), 21, 0) };
}
