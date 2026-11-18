import type { PrefKey, PrefKind, PrefValue, Preference } from './types';

export interface PrefMeta {
  kind: PrefKind;
  /** Short Greek label for the profile chip. */
  label: string;
  valueType: 'number' | 'time' | 'boolean';
  unit?: string;
  /** Default importance when an extractor proposes this key. */
  defaultWeight: number;
  /** Decision dimension, used to report missing data as uncertainty. */
  dimension: Dimension;
}

export type Dimension = 'cost' | 'return' | 'stay' | 'hiking' | 'sea';

export const DIMENSION_LABEL: Record<Dimension, string> = {
  cost: 'κόστος',
  return: 'ώρα επιστροφής',
  stay: 'διαμονή',
  hiking: 'πεζοπορία',
  sea: 'θάλασσα',
};

export const PREF_META: Record<PrefKey, PrefMeta> = {
  budget_max: { kind: 'constraint', label: 'Όριο κόστους / άτομο', valueType: 'number', unit: '€', defaultWeight: 1, dimension: 'cost' },
  return_by: { kind: 'constraint', label: 'Επιστροφή Κυριακή έως', valueType: 'time', defaultWeight: 1, dimension: 'return' },
  no_camping: { kind: 'constraint', label: 'Όχι σκηνή', valueType: 'boolean', defaultWeight: 1, dimension: 'stay' },
  requires_private_bath: { kind: 'constraint', label: 'Απαραίτητο ιδιωτικό μπάνιο', valueType: 'boolean', defaultWeight: 1, dimension: 'stay' },
  likes_hiking: { kind: 'preference', label: 'Πεζοπορία', valueType: 'boolean', defaultWeight: 0.6, dimension: 'hiking' },
  max_hike_hours: { kind: 'preference', label: 'Πεζοπορία το πολύ', valueType: 'number', unit: 'ώρες', defaultWeight: 0.3, dimension: 'hiking' },
  prefers_low_cost: { kind: 'preference', label: 'Χαμηλό κόστος', valueType: 'boolean', defaultWeight: 0.4, dimension: 'cost' },
  prefers_comfort: { kind: 'preference', label: 'Άνετη διαμονή', valueType: 'boolean', defaultWeight: 0.7, dimension: 'stay' },
  likes_sea: { kind: 'preference', label: 'Θάλασσα', valueType: 'boolean', defaultWeight: 0.5, dimension: 'sea' },
};

export const PREF_KEYS = Object.keys(PREF_META) as PrefKey[];

export function isPrefKey(key: string): key is PrefKey {
  return key in PREF_META;
}

export function formatValue(key: PrefKey, value: PrefValue): string {
  const meta = PREF_META[key];
  if (meta.valueType === 'boolean') {
    if (key === 'likes_hiking' || key === 'likes_sea') return value ? 'ναι' : 'όχι, το αποφεύγει';
    return value ? 'ναι' : 'όχι';
  }
  if (meta.valueType === 'time') return String(value);
  return `${value}${meta.unit === '€' ? '€' : meta.unit ? ` ${meta.unit}` : ''}`;
}

export function describePref(p: Pick<Preference, 'key' | 'value'>): string {
  const meta = PREF_META[p.key];
  if (meta.valueType === 'boolean') {
    if (p.value === false && (p.key === 'likes_hiking' || p.key === 'likes_sea')) {
      return p.key === 'likes_hiking' ? 'Αποφεύγει πολλή πεζοπορία' : 'Αποφεύγει τη θάλασσα';
    }
    return meta.label;
  }
  return `${meta.label}: ${formatValue(p.key, p.value)}`;
}

export function importanceLabel(weight: number): string {
  if (weight >= 0.65) return 'υψηλή';
  if (weight >= 0.35) return 'μέτρια';
  return 'χαμηλή';
}

/** Coerce user / model input to the value type the engine expects. Returns null if invalid. */
export function coerceValue(key: PrefKey, raw: unknown): PrefValue | null {
  const meta = PREF_META[key];
  if (meta.valueType === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return null;
  }
  if (meta.valueType === 'number') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.').replace(/[^\d.]/g, ''));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
  }
  const m = String(raw).trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
