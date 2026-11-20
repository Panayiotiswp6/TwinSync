// Private chat with one twin. Nothing is stored: the browser sends the conversation, the twin
// answers in its owner's voice from its own memory, and the reply says which memory it used.

import { applySwaps } from '../shared/dialect';
import { styleSamples } from '../shared/messages';
import { normalizeGreek } from '../shared/text';
import type { MemoryItem } from '../shared/types';
import { aiErrorReason, aiModel, liveAi, privateReply, type ChatTurn } from './ai';
import { retrieve } from './retrieval';
import { store } from './store';

export interface PrivateChatResult {
  reply: string;
  used: Pick<MemoryItem, 'id' | 'statement' | 'refs'>[];
  mode: 'live' | 'demo';
  model: string | null;
  note?: string;
}

const ROUTINE = /(σχολ|μαθημ|εργαστηρ|γυμναστ|τζιμ|gym|προπονη|δουλει|εργαζ|δευτερα|τριτη|τεταρτη|πεμπτη|παρασκευη|σαββατο|κυριακη|καθημεριν|\d{1,2}[:.]\d{2}|\d{1,2}\s*[–-]\s*\d{1,2})/;

/** A person's weekly routines (classes, gym, work) always come along, so the twin can judge a proposed time. */
export function withRoutines(relevant: MemoryItem[], profile: MemoryItem[]): MemoryItem[] {
  const ids = new Set(relevant.map((m) => m.id));
  const routines = profile.filter((m) => !ids.has(m.id) && m.kind !== 'style' && (m.domain === 'schedule' || ROUTINE.test(normalizeGreek(m.statement))));
  return [...relevant, ...routines.slice(0, 12)];
}

const words = (t: string) => new Set(normalizeGreek(t).split(/[^a-zα-ω0-9]+/).filter((w) => w.length >= 3));

/** Is the reply (nearly) a sample line from another conversation? */
export function copiesSample(reply: string, samples: string[]): boolean {
  const r = words(reply);
  if (r.size < 3) return false;
  return samples.some((line) => {
    const l = words(line);
    if (l.size < 4) return false;
    let common = 0;
    for (const w of l) if (r.has(w)) common++;
    return common / Math.min(l.size, r.size) >= 0.7;
  });
}

const ADDRESS = ['ρε φίλε', 'ρε μπρο', 'ρε μάγκα', 'φίλε', 'μπρο', 'μάγκα', 'αδερφέ', 'ρε'];

/** A real person does not say "ρε φίλε" in every message: drop an address word the previous reply already used. */
export function varyAddress(reply: string, previous: string): string {
  const prev = normalizeGreek(previous);
  let out = reply;
  for (const w of ADDRESS) {
    const nw = normalizeGreek(w);
    if (!prev.includes(nw)) continue;
    const re = new RegExp(`(^|[\\s,])${w.replace(/ /g, '\\s+')}(?=[\\s,!.;?…]|$)`, 'giu');
    out = out.replace(re, '$1');
  }
  // The same laugh at the end of two messages in a row reads like a template.
  if (/χαχα\S*\s*$/i.test(previous.trim()) && /\s+χαχα\S*\s*$/i.test(out)) out = out.replace(/\s+χαχα\S*\s*$/i, '');
  out = out.replace(/\s+,/g, ',').replace(/,\s*([!.;?…])/g, '$1').replace(/^[\s,]+/, '').replace(/\s{2,}/g, ' ').trim();
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : reply;
}

/** Demo mode: the closest memory item, said plainly (no AI). */
function demoReply(items: MemoryItem[], text: string): { reply: string; used: MemoryItem[] } {
  const words = new Set(normalizeGreek(text).split(/[^a-zα-ω0-9]+/).filter((w) => w.length > 3).map((w) => w.slice(0, 5)));
  const scored = items
    .map((m) => ({ m, s: normalizeGreek(`${m.statement} ${m.keywords.join(' ')}`).split(/[^a-zα-ω0-9]+/).filter((w) => words.has(w.slice(0, 5))).length }))
    .sort((a, b) => b.s - a.s);
  const best = scored[0]?.s ? scored[0].m : undefined;
  return best ? { reply: `Χμ, για αυτό: ${best.statement.charAt(0).toLowerCase()}${best.statement.slice(1)}`, used: [best] } : { reply: 'Δεν ξέρω ακόμα τι να σου πω γι’ αυτό — ρώτα με κάτι άλλο!', used: [] };
}

export async function privateChat(personaId: string, turns: ChatTurn[]): Promise<PrivateChatResult> {
  const persona = store.persona(personaId);
  if (!persona) throw new Error('not found');
  const last = turns.filter((t) => t.role === 'user').at(-1)?.text ?? '';
  const context = turns.slice(-4).map((t) => t.text).join(' ');
  const profile = store.profile(personaId);
  const { items: relevant } = await retrieve(`${last} ${context}`, profile, []);
  const items = withRoutines(relevant, profile);
  const pick = (ids: string[]) => ids.map((id) => items.find((m) => m.id === id)!).filter(Boolean).map((m) => ({ id: m.id, statement: m.statement, refs: m.refs }));
  if (liveAi()) {
    try {
      const samples = styleSamples(store.sources, personaId).flatMap((s) => s.text.split('\n')).map((l) => l.trim()).filter((l) => l.length > 1).slice(0, 14);
      const mem = items.filter((m) => m.kind !== 'style');
      let r = await privateReply(persona, mem, samples, turns.slice(-12));
      // A reply that is really a sample from another conversation ("…να το προλάβουμε") gets one rewrite.
      if (copiesSample(r.reply, samples)) r = await privateReply(persona, mem, samples, turns.slice(-12), new Date(), r.reply);
      const previous = turns.filter((t) => t.role === 'twin').at(-1)?.text ?? '';
      return { reply: applySwaps(varyAddress(r.reply, previous), persona.style?.swaps), used: pick(r.usedMemoryIds), mode: 'live', model: aiModel() };
    } catch (e) {
      const d = demoReply(items, last);
      return { reply: d.reply, used: pick(d.used.map((m) => m.id)), mode: 'demo', model: null, note: `Live AI απέτυχε (${aiErrorReason(e)}) — απάντηση χωρίς AI.` };
    }
  }
  const d = demoReply(items, last);
  return { reply: d.reply, used: pick(d.used.map((m) => m.id)), mode: 'demo', model: null, note: 'Demo mode: χωρίς κλειδί AI το Twin απαντά μόνο με την πιο σχετική ανάμνηση, χωρίς το ύφος του κατόχου.' };
}
