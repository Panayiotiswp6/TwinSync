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

// Windows-1252 code points 0x80–0x9F that differ from Latin-1.
const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
const greekCount = (s: string) => (s.match(/[Ͱ-Ͽἀ-῿]/g) ?? []).length;

/**
 * Repair UTF-8 text that was decoded as Windows-1252/Latin-1 ("Î Ï..." instead of Greek),
 * e.g. a file opened and re-saved with the wrong encoding. Returns the input unchanged
 * unless the repaired text is valid UTF-8 and clearly more Greek.
 */
export function repairMojibake(text: string): string {
  if (!/[ÎÏ][\u0080-ÿŒ-™]/.test(text)) return text;
  const bytes: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c <= 0xff) bytes.push(c);
    else if (CP1252[c] !== undefined) bytes.push(CP1252[c]);
    else return text; // a real non-Latin character: not mojibake
  }
  // Some tools DROP the bytes 0x81/0x8D/0x8F/0x90/0x9D (undefined in Windows-1252). In Greek UTF-8 the
  // lost continuation byte after 0xCF is almost always 0x81 ("ρ") and after 0xCE it is 0x9D ("Ν").
  const healed: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    healed.push(bytes[i]);
    const next = bytes[i + 1];
    const isCont = next !== undefined && next >= 0x80 && next <= 0xbf;
    if (bytes[i] === 0xcf && !isCont) healed.push(0x81);
    else if (bytes[i] === 0xce && !isCont) healed.push(0x9d);
  }
  try {
    const fixed = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(healed));
    return greekCount(fixed) > greekCount(text) ? fixed : text;
  } catch {
    return text;
  }
}
