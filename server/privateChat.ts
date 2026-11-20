// Private chat with one twin. Nothing is stored: the browser sends the conversation, the twin
// answers in its owner's voice from its own memory, and the reply says which memory it used.

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
  const { items } = await retrieve(`${last} ${context}`, store.profile(personaId), []);
  const pick = (ids: string[]) => ids.map((id) => items.find((m) => m.id === id)!).filter(Boolean).map((m) => ({ id: m.id, statement: m.statement, refs: m.refs }));
  if (liveAi()) {
    try {
      const samples = styleSamples(store.sources, personaId).flatMap((s) => s.text.split('\n')).map((l) => l.trim()).filter((l) => l.length > 1).slice(0, 14);
      const r = await privateReply(persona, items.filter((m) => m.kind !== 'style'), samples, turns.slice(-12));
      return { reply: r.reply, used: pick(r.usedMemoryIds), mode: 'live', model: aiModel() };
    } catch (e) {
      const d = demoReply(items, last);
      return { reply: d.reply, used: pick(d.used.map((m) => m.id)), mode: 'demo', model: null, note: `Live AI απέτυχε (${aiErrorReason(e)}) — απάντηση χωρίς AI.` };
    }
  }
  const d = demoReply(items, last);
  return { reply: d.reply, used: pick(d.used.map((m) => m.id)), mode: 'demo', model: null, note: 'Demo mode: χωρίς κλειδί AI το Twin απαντά μόνο με την πιο σχετική ανάμνηση, χωρίς το ύφος του κατόχου.' };
}
