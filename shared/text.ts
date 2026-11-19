/** Lowercase and strip Greek accents/diaeresis so "Θάλασσα" ~ "θαλασσα". */
export function normalizeGreek(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ς/g, 'σ');
}

/** Split into sentences, keeping the original text (Greek question mark is ";"). */
export function sentences(text: string): string[] {
  // Lines first (chat exports and interview answers have one message per line), then sentences.
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!;;])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

/** True if `quote` occurs in `text` (whitespace-insensitive). */
export function containsQuote(text: string, quote: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return quote.trim().length > 0 && norm(text).includes(norm(quote));
}

const GREEK_LATIN: Record<string, string> = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x', ο: 'o', π: 'p',
  ρ: 'r', σ: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
};

/** URL-safe latin slug ("Μαρία Κ." -> "maria-k"). */
export function slug(s: string): string {
  return [...normalizeGreek(s)]
    .map((c) => GREEK_LATIN[c] ?? c)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

export const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
