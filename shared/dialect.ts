// Dialect words that stand for a standard word. Cypriot «τζε» means «και»: a twin writes it
// exactly where standard Greek has «και» (every time) and nowhere else — never as a filler.

import type { StyleCard, WordSwap } from './types';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Greek letters are not \w in JS regex: word edges are "not a letter" on either side.
const word = (w: string) => `(?<!\\p{L})${esc(w)}(?!\\p{L})`;

function likeCase(src: string, w: string): string {
  const upper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();
  if (src.length > 1 && [...src].every(upper)) return w.toUpperCase();
  return upper(src[0]) ? w.charAt(0).toUpperCase() + w.slice(1) : w;
}

/** Applies a person's dialect words: stray fillers go, every standard word becomes theirs. */
export function applySwaps(text: string, swaps?: WordSwap[] | null): string {
  if (!swaps?.length) return text;
  let out = text;
  for (const s of swaps) {
    // At the end of a sentence it cannot stand for «και» ("βολεύει μετά το μάθημα τζε") — drop it.
    out = out.replace(new RegExp(`[ \\t]*${word(s.to)}(?=[ \\t]*(?:[.,!;?…·)\\n]|$))`, 'giu'), '');
    for (const f of s.from) out = out.replace(new RegExp(word(f), 'giu'), (m) => likeCase(m, s.to));
  }
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/^[ \t,]+/, '').trim();
  if (!out) return text;
  return /^\s*\p{Lu}/u.test(text) ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}

/** The instruction for the model, next to the style notes. */
export function swapsNote(style: StyleCard | null | undefined): string {
  return (style?.swaps ?? [])
    .map((s) => `Writes «${s.to}» exactly where standard Greek has ${s.from.map((f) => `«${f}»`).join('/')} — every time, and never anywhere else (not as a filler, not at the end of a sentence).`)
    .join(' ');
}
