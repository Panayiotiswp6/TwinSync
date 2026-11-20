// Live AI tasks for TwinSync. Every task uses structured JSON output and every result is
// validated before use: quotes must be exact spans of the source, cited memory ids must
// exist, numbers are coerced. Hard numeric constraints are never decided by the model.
//
// Provider (server-side keys only, never sent to the browser):
//   OPENAI_API_KEY    -> OpenAI gpt-6-luna (+ text-embedding-3-large for retrieval)
//   ANTHROPIC_API_KEY -> Anthropic Claude (claude-opus-5-5); retrieval falls back to keywords
//   neither           -> demo mode (shared/heuristics.ts)

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { z } from 'zod';
import type { MemoryDraft } from '../shared/heuristics';
import { swapsNote } from '../shared/dialect';
import { CATEGORIES, DOMAINS, type CandidateOption, type Category, type Evaluation, type Itinerary, type MemoryItem, type Persona, type RequestKind, type StyleCard, type Venue } from '../shared/types';
import { contextHint, type RequestContext, WHERE_LABEL } from '../shared/context';
import { KIND_CATEGORY, KIND_LABEL, LOCAL_KINDS } from '../shared/plan';
import { containsQuote, clamp, normalizeGreek } from '../shared/text';
import { athensIso, localParts, parseIso } from '../shared/time';

const KINDS: RequestKind[] = ['coffee', 'drinks', 'club', 'live', 'dinner', 'trip', 'activity', 'gift', 'other'];
const WEEKDAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** "2026-11-20T14:05:00+02:00" in Athens local time (correct offset, DST included). */
function athensNow(now: Date): string {
  const p = localParts(now);
  return athensIso(p.y, p.m, p.d, p.hh, p.mm);
}
import { store } from './store';

export type Provider = 'openai' | 'anthropic' | 'demo';

export function aiProvider(): Provider {
  const forced = process.env.AI_PROVIDER?.toLowerCase();
  if (forced === 'demo') return 'demo';
  if (forced === 'openai' && process.env.OPENAI_API_KEY) return 'openai';
  if (forced === 'anthropic' && process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return 'demo';
}
export function aiModel(): string | null {
  const p = aiProvider();
  if (p === 'openai') return process.env.OPENAI_MODEL || 'gpt-6-luna';
  if (p === 'anthropic') return process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
  return null;
}
export const liveAi = () => aiProvider() !== 'demo';
export const embeddingsEnabled = () => aiProvider() === 'openai' && process.env.EMBEDDINGS !== 'off';

const MAX_CALLS = Number(process.env.AI_MAX_CALLS || 600);

let openai: OpenAI | null = null;
let anthropic: Anthropic | null = null;

export class AiError extends Error {}

export function aiErrorReason(err: unknown): string {
  if (err instanceof AiError) return err.message;
  if (err instanceof SyntaxError || err instanceof z.ZodError) return 'μη έγκυρο JSON από το μοντέλο';
  return err instanceof Error ? err.message : 'άγνωστο σφάλμα';
}

type Effort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';
const EFFORT = (process.env.AI_REASONING_EFFORT || 'low') as Effort | 'default';

async function completeJSON(opts: { name: string; system: string; user: string; schema: Record<string, unknown>; maxTokens: number }): Promise<unknown> {
  if (store.usage.calls >= MAX_CALLS) throw new AiError(`έφτασε το όριο κλήσεων AI_MAX_CALLS=${MAX_CALLS}`);
  const provider = aiProvider();
  if (provider === 'openai') {
    openai ??= new OpenAI();
    try {
      const res = await openai.chat.completions.create({
        model: aiModel()!,
        max_completion_tokens: opts.maxTokens,
        ...(EFFORT !== 'default' ? { reasoning_effort: EFFORT } : {}),
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
        response_format: { type: 'json_schema', json_schema: { name: opts.name, strict: true, schema: opts.schema } },
      });
      store.addUsage({ calls: 1, inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 });
      const choice = res.choices[0];
      if (choice?.message.refusal) throw new AiError('το μοντέλο αρνήθηκε το αίτημα');
      if (choice?.finish_reason === 'length') throw new AiError('η απάντηση κόπηκε (όριο tokens)');
      return JSON.parse(choice?.message.content ?? '');
    } catch (err) {
      if (err instanceof OpenAI.AuthenticationError) throw new AiError('μη έγκυρο API key');
      if (err instanceof OpenAI.RateLimitError) throw new AiError('rate limit ή εξαντλήθηκε το budget');
      if (err instanceof OpenAI.APIConnectionError) throw new AiError('δεν υπάρχει σύνδεση με το AI API');
      if (err instanceof OpenAI.APIError) throw new AiError(`σφάλμα API ${err.status ?? ''}`.trim());
      throw err;
    }
  }
  if (provider === 'anthropic') {
    anthropic ??= new Anthropic();
    try {
      const res = await anthropic.beta.messages.create({
        model: aiModel()!,
        max_tokens: Math.max(opts.maxTokens, 4000),
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema: opts.schema } },
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
      });
      store.addUsage({ calls: 1, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens });
      if (res.stop_reason === 'refusal') throw new AiError('το μοντέλο αρνήθηκε το αίτημα');
      return JSON.parse(res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''));
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new AiError('μη έγκυρο API key');
      if (err instanceof Anthropic.RateLimitError) throw new AiError('rate limit');
      if (err instanceof Anthropic.APIConnectionError) throw new AiError('δεν υπάρχει σύνδεση με το AI API');
      if (err instanceof Anthropic.APIError) throw new AiError(`σφάλμα API ${err.status}`);
      throw err;
    }
  }
  throw new AiError('δεν έχει ρυθμιστεί πάροχος AI');
}

/** OpenAI embeddings (text-embedding-3-large, shortened to 256 dims to keep the store small). */
export async function embed(texts: string[]): Promise<number[][]> {
  openai ??= new OpenAI();
  const res = await openai.embeddings.create({ model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-large', input: texts, dimensions: 256 });
  store.addUsage({ embeddingTokens: res.usage?.total_tokens ?? 0 });
  return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// ---------------------------------------------------------------------------
// Shared schema pieces
// ---------------------------------------------------------------------------

const STRENGTH = { low: 0.3, medium: 0.6, high: 0.9 } as const;

/** Drop stray characters from scripts we never expect in Greek/English output (models occasionally leak e.g. Hebrew). */
export function clean(s: string): string {
  const stripped = s.replace(/[\u0590-\u08FF\u0900-\u0DFF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]+/g, '');
  // Where a stray foreign-script word was removed, do not leave "προσθέτει ." behind.
  return (stripped === s ? s : stripped.replace(/\s+([.,;!?…])/g, '$1')).replace(/\s{2,}/g, ' ').trim();
}

const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'statement', 'domain', 'polarity', 'strength', 'hard', 'metric', 'value', 'where', 'days', 'categories', 'keywords', 'quote', 'confidence'],
  properties: {
    kind: { type: 'string', enum: ['preference', 'constraint', 'fact', 'decision_pattern', 'style'] },
    statement: { type: 'string', description: 'short Greek statement about the person, third person' },
    domain: { type: 'string', enum: DOMAINS },
    polarity: { type: 'string', enum: ['likes', 'avoids', 'neutral'] },
    strength: { type: 'string', enum: ['low', 'medium', 'high'] },
    hard: { type: 'boolean', description: 'true ONLY for explicit absolutes (never / cannot / must / allergy / fixed obligation). Habits ("συνήθως", "περίπου", "μέχρι" said casually) are false.' },
    metric: { type: 'string', enum: ['none', 'max_cost', 'latest_end'], description: 'machine-checkable part of a hard constraint' },
    value: { type: 'string', description: 'max_cost: euros per person as a number. latest_end: "weekly:<0-6, Sunday=0>:HH:MM" for a recurring limit, or an ISO datetime with +02:00 for a one-off. "" if metric is none.' },
    where: { type: 'string', enum: ['any', 'local', 'domestic', 'abroad'], description: 'situation the statement was said for: local = evenings/outings in the home city, domestic = trips in Greece, abroad = trips abroad, any = general' },
    days: { type: 'integer', description: 'duration in days the statement refers to ("διήμερο" = 2, "τριήμερο" = 3, "βράδυ" = 1); 0 if not said' },
    categories: { type: 'array', items: { type: 'string', enum: CATEGORIES }, description: 'request types this applies to; empty = all' },
    keywords: { type: 'array', items: { type: 'string' }, description: '1-5 short Greek keywords an option description would contain' },
    quote: { type: 'string', description: 'exact verbatim span copied from the text that supports the statement' },
    confidence: { type: 'number' },
  },
};

const RawDraft = z.object({
  kind: z.enum(['preference', 'constraint', 'fact', 'decision_pattern', 'style']),
  statement: z.string(),
  domain: z.enum(DOMAINS as [string, ...string[]]),
  polarity: z.enum(['likes', 'avoids', 'neutral']),
  strength: z.enum(['low', 'medium', 'high']),
  hard: z.boolean(),
  metric: z.enum(['none', 'max_cost', 'latest_end']),
  value: z.string(),
  where: z.enum(['any', 'local', 'domestic', 'abroad']).catch('any'),
  days: z.number().catch(0),
  categories: z.array(z.string()),
  keywords: z.array(z.string()),
  quote: z.string(),
  confidence: z.number(),
});

function toDraft(r: z.infer<typeof RawDraft>): MemoryDraft | null {
  if (!r.statement.trim() || !r.quote.trim()) return null;
  let rule: MemoryDraft['rule'];
  if (r.metric === 'max_cost') {
    const n = Number(r.value.replace(',', '.').replace(/[^\d.]/g, ''));
    if (Number.isFinite(n) && n > 0) rule = { metric: 'max_cost', value: String(Math.round(n)) };
  } else if (r.metric === 'latest_end') {
    const v = r.value.trim();
    if (/^weekly:[0-6]:\d{1,2}:\d{2}$/.test(v) || parseIso(v)) rule = { metric: 'latest_end', value: v };
  }
  return {
    kind: r.kind,
    statement: clean(r.statement).slice(0, 200),
    domain: r.domain as MemoryDraft['domain'],
    polarity: r.polarity,
    strength: r.hard ? 1 : STRENGTH[r.strength],
    hard: r.hard,
    rule,
    context: { where: r.where, days: Math.max(0, Math.min(60, Math.round(r.days || 0))) },
    categories: r.categories.filter((c): c is Category => (CATEGORIES as string[]).includes(c)),
    keywords: r.keywords.map((k) => k.trim()).filter(Boolean).slice(0, 6),
    quote: r.quote.trim(),
    confidence: clamp(r.confidence, 0, 1),
  };
}

const MEMORY_RULES = `Memory item rules:
- kind: preference (likes/avoids), constraint (cannot / will not accept, or must have), fact (about the person), decision_pattern (how they tend to choose, from past decisions), style (how they write).
- hard=true ONLY for explicit absolutes: "ποτέ", "σε καμία περίπτωση", "δεν μπορώ", "οπωσδήποτε", allergies/diet, or an answer to "what do you never compromise on". Routines and obligations (works on Saturdays, has classes) are facts (hard=false) unless the person says they cannot miss them. Habits and typical amounts ("συνήθως δίνω μέχρι 200€", "περίπου", "κατά κανόνα") are SOFT (hard=false) — keep the number in metric/value as a reference only.
- Every statement is said in a context. Record it in where/days (e.g. "συνήθως δίνω μέχρι 200€ για ένα διήμερο" → where=domestic, days=2, hard=false). Write the context into the statement too ("Για διήμερο στην Ελλάδα δίνει συνήθως έως ~200€"). Do not generalise a statement beyond the situation it was said for.
- For money use metric max_cost (euros per person for the whole stated duration); for "must be back by …" use metric latest_end. Never invent numbers or times.
- categories: the request types the item applies to (trip, food, entertainment, activity, gift, other); empty if general.
- quote: copy the exact words from the text (same accents), as short as possible while still supporting the statement.
- Statements in Greek, third person, short. Do not repeat the same idea twice.`;

// ---------------------------------------------------------------------------
// 1. Source analysis -> memory items
// ---------------------------------------------------------------------------

function chunks(text: string, size = 6000): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let cur = '';
  for (const para of text.split(/\n{2,}/)) {
    if ((cur + '\n\n' + para).length > size && cur) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n\n${para}` : para;
    while (cur.length > size) {
      out.push(cur.slice(0, size));
      cur = cur.slice(size);
    }
  }
  if (cur) out.push(cur);
  return out;
}

export const MAX_CHUNKS = Number(process.env.AI_MAX_CHUNKS || 6);

export async function analyzeSource(persona: Persona, title: string, text: string): Promise<{ drafts: MemoryDraft[]; truncated: boolean }> {
  const parts = chunks(text);
  const drafts: MemoryDraft[] = [];
  for (const part of parts.slice(0, MAX_CHUNKS)) {
    const data = await completeJSON({
      name: 'memory_items',
      system: `You build the long-term memory of ${persona.name}'s digital twin from their own documents, notes, chats, emails and past decisions.
Extract what would help the twin answer, write and decide like ${persona.name} in ANY situation (trips, food, going out, gifts, money, schedule, social life).
${MEMORY_RULES}
- Extract only what the text supports. 0-12 items. If nothing useful, return an empty list.
- Interview transcripts: lines starting with "Ε:" are the interviewer's questions (context only) and lines "(Σύνοψη ChatGPT: …)" are someone else's summary. Quote ONLY the person's own answers ("Α:" lines) or their own messages.`,
      user: `Source title: ${title}\nText:\n"""\n${part}\n"""`,
      schema: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: DRAFT_SCHEMA } } },
      maxTokens: 5000,
    });
    const parsed = z.object({ items: z.array(RawDraft) }).parse(data);
    for (const r of parsed.items) {
      const d = toDraft(r);
      if (d && containsQuote(part, d.quote)) drafts.push(d);
    }
  }
  return { drafts, truncated: parts.length > MAX_CHUNKS };
}

// ---------------------------------------------------------------------------
// 2. Writing style card
// ---------------------------------------------------------------------------

export async function buildStyle(persona: Persona, samples: { id: string; text: string }[]): Promise<StyleCard> {
  const data = await completeJSON({
    name: 'style_card',
    system: `Describe how ${persona.name} writes, from their own messages. Greek output. Be concrete (length, punctuation, accents, emoji, typical openings/words, tone).`,
    user: samples.map((s) => `[${s.id}] ${s.text}`).join('\n\n'),
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'traits', 'phrases', 'usesEmoji'],
      properties: {
        summary: { type: 'string' },
        traits: { type: 'array', items: { type: 'string' } },
        phrases: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['sourceId', 'quote'], properties: { sourceId: { type: 'string' }, quote: { type: 'string', description: 'exact typical phrase, 2-8 words' } } },
        },
        usesEmoji: { type: 'boolean' },
      },
    },
    maxTokens: 2500,
  });
  const p = z.object({ summary: z.string(), traits: z.array(z.string()), phrases: z.array(z.object({ sourceId: z.string(), quote: z.string() })), usesEmoji: z.boolean() }).parse(data);
  return {
    summary: p.summary.slice(0, 300),
    traits: p.traits.slice(0, 6),
    phrases: p.phrases.filter((ph) => samples.some((s) => s.id === ph.sourceId && containsQuote(s.text, ph.quote))).slice(0, 5),
    usesEmoji: p.usesEmoji,
  };
}

// ---------------------------------------------------------------------------
// 3. Request + per-person one-off wishes
// ---------------------------------------------------------------------------

export interface ParsedRequest {
  title: string;
  category: Category;
  periodStart: string | null;
  periodEnd: string | null;
  where: 'local' | 'domestic' | 'abroad' | null;
  place: string;
  kind: RequestKind;
  /** City the group is in, if the text says so ('' otherwise). */
  city: string;
  area: string;
  groupDrafts: MemoryDraft[];
  wishDrafts: Record<string, MemoryDraft[]>;
}

export async function parseRequest(text: string, now: Date, wishes: { personaId: string; name: string; text: string }[], groupCity = 'Αθήνα', participants = 2): Promise<ParsedRequest> {
  const data = await completeJSON({
    name: 'group_request',
    system: `You read a Greek group request from ${participants} friends, plus each person's one-off wishes for THIS request only.
Unless the text says otherwise the group is in ${groupCity}. Today is ${athensNow(now)} (Europe/Athens local time; use the real Athens UTC offset for every datetime: +02:00 in winter, +03:00 in summer).
- kind: what exactly is asked — coffee (καφές, also studying at a café), drinks (ποτό, cocktail, wine, beer bar), club, live (συναυλία, μπουζούκια, live μουσική), dinner (φαγητό), trip (ταξίδι/εκδρομή of one or more nights), activity, gift, other. A night out ("πού να βγούμε", "έξοδος το βράδυ") is drinks, or live if music is the point, or club if dancing; use other only if nothing fits.
- category: trip, food (dinner), entertainment (coffee, drinks, club, live), activity, gift or other.
- city: the city where the group IS / starts from if the text states it (e.g. "είμαστε στη Θεσσαλονίκη" → Θεσσαλονίκη), else "". A local plan in Thessaloniki is local, not a trip.
- area: the requested neighbourhood(s) for a local plan exactly as asked (e.g. "Ζωγράφου ή Ιλίσια", "Καμάρα ή Ναυαρίνου", "κέντρο"), else "".
- where: local (in the group's city), domestic (elsewhere in Greece) or abroad; place: the trip destination if named, else "".
- One evening that runs past midnight is ONE outing.
- period: the concrete start and end (ISO with +02:00) the request implies; if vague, choose the nearest sensible window (e.g. "αυτό το ΣΚ" = coming Saturday 09:00 to Sunday 21:00, "τριήμερο" = Friday evening to Sunday night unless a day is named).
- groupItems: limits stated in the request text itself that apply to everyone (e.g. "μέχρι 100€").
- wishes: for each person, turn their one-off wish text into memory items (scope: this request). Quotes must come from THAT person's wish text.
${MEMORY_RULES}
- For one-off deadlines use latest_end with an ISO datetime inside or right after the period.
- Wishes are what the person wants for THIS plan: a budget written in a wish is the person's limit for the whole plan (hard=true if stated as a limit: "≤", "μέχρι", "όχι πάνω από"; soft if a target: "γύρω στα", "περίπου").
- max_cost is EUR PER PERSON. If an amount is clearly for the whole group ("όλοι μαζί", "συνολικά για την παρέα"), divide by ${participants}.`,
    user: `Request: """${text}"""\n\n${wishes.map((w) => `Wish of ${w.name} (personaId ${w.personaId}): """${w.text}"""`).join('\n') || 'No one-off wishes.'}`,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'kind', 'category', 'city', 'area', 'where', 'place', 'periodStart', 'periodEnd', 'groupItems', 'wishes'],
      properties: {
        title: { type: 'string', description: 'short Greek title, max 60 chars' },
        kind: { type: 'string', enum: KINDS },
        category: { type: 'string', enum: CATEGORIES },
        city: { type: 'string' },
        area: { type: 'string' },
        where: { type: 'string', enum: ['local', 'domestic', 'abroad'] },
        place: { type: 'string' },
        periodStart: { type: 'string' },
        periodEnd: { type: 'string' },
        groupItems: { type: 'array', items: DRAFT_SCHEMA },
        wishes: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['personaId', 'items'], properties: { personaId: { type: 'string' }, items: { type: 'array', items: DRAFT_SCHEMA } } },
        },
      },
    },
    maxTokens: 5000,
  });
  const p = z
    .object({
      title: z.string(),
      category: z.string(),
      kind: z.enum(KINDS as [RequestKind, ...RequestKind[]]).catch('other'),
      city: z.string().catch(''),
      area: z.string().catch(''),
      where: z.enum(['local', 'domestic', 'abroad']).catch('local'),
      place: z.string().catch(''),
      periodStart: z.string(),
      periodEnd: z.string(),
      groupItems: z.array(RawDraft),
      wishes: z.array(z.object({ personaId: z.string(), items: z.array(RawDraft) })),
    })
    .parse(data);
  const wishDrafts: Record<string, MemoryDraft[]> = {};
  for (const w of wishes) {
    const got = p.wishes.find((x) => x.personaId === w.personaId)?.items ?? [];
    wishDrafts[w.personaId] = got.map(toDraft).filter((d): d is MemoryDraft => !!d && containsQuote(w.text, d.quote));
  }
  return {
    title: p.title.trim().slice(0, 70) || text.slice(0, 60),
    category: p.kind !== 'other' ? KIND_CATEGORY[p.kind] : (CATEGORIES as string[]).includes(p.category) ? (p.category as Category) : 'other',
    periodStart: parseIso(p.periodStart) ? p.periodStart : null,
    periodEnd: parseIso(p.periodEnd) ? p.periodEnd : null,
    where: p.where,
    place: clean(p.place).slice(0, 60),
    kind: p.kind,
    city: clean(p.city).slice(0, 40),
    area: clean(p.area).slice(0, 80),
    groupDrafts: p.groupItems.map(toDraft).filter((d): d is MemoryDraft => !!d && containsQuote(text, d.quote)),
    wishDrafts,
  };
}

// ---------------------------------------------------------------------------
// 4. Candidate options
// ---------------------------------------------------------------------------

export interface TwinContext {
  persona: Persona;
  items: MemoryItem[];
  /** Memory ids learned from the person's earlier decisions. */
  learned?: Set<string>;
}

function describeItems(items: MemoryItem[], ctx?: RequestContext | null, learned?: Set<string>): string {
  // Request-only wishes first: they are what the person asked for THIS plan.
  const order = [...items].sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'request' ? -1 : 1));
  return order
    .map((m) => {
      const hint = contextHint(m, ctx);
      const from = learned?.has(m.id) ? ', από προηγούμενη απόφαση' : '';
      return `  - ${m.id} [${m.scope === 'request' ? 'ΑΙΤΗΜΑ' : m.kind}${m.hard ? ', HARD' : ''}${m.rule ? `, ${m.rule.metric}=${m.rule.value}` : ''}${from}] ${m.statement}${hint ? ` (${hint})` : ''}`;
    })
    .join('\n');
}

function describeContext(ctx?: RequestContext | null): string {
  return ctx ? `${ctx.days} ${ctx.days === 1 ? 'μέρα' : 'μέρες'}, ${ctx.where ? WHERE_LABEL[ctx.where] : '?'}` : '?';
}

/** How a twin should read its memory. Shared by option generation and evaluation. */
/** Plans read as finished proposals: no hedging in what the group sees (the checks run in code). */
const TONE = `- Write every user-facing text (summary, features, modes, stay note, slot titles) as a confident, finished plan. Never write "επιβεβαιώστε", "ελέγξτε", "προς έλεγχο", "ενδεικτικό", "αν είναι ανοικτό", "εφόσον" or similar hedging.`;

// A sentence that only hedges ("Οι ώρες χρειάζονται επιβεβαίωση") is dropped from what the group sees.
const HEDGE = /(επιβεβαι|ελεγξτε|ελεγχθ|προσ ελεγχο|ενδεικτικ|δεν ειναι βεβαι|ενδεχομεν|to verify|to check)/;
export function confident(text: string): string {
  const parts = text.split(/(?<=[.;!])\s+|\s*·\s*/);
  const kept = parts.filter((x) => !HEDGE.test(normalizeGreek(x)));
  return (kept.length ? kept : parts.slice(0, 1)).join(' ').replace(/\s{2,}/g, ' ').trim();
}

const READING_RULES = `How to read each person's memory:
- Items marked ΑΙΤΗΜΑ are what the person asked for THIS plan. They override any profile item on the same topic.
- Profile items are general tendencies from what the person told us, each said in a specific context (duration, Greece vs abroad, evening vs trip). Apply an item only as far as its context matches this plan. Typical amounts are references, not limits: scale them to the plan (e.g. "~200€ for 2 days in Greece" says little about 4 days abroad; extrapolate per day and allow for higher prices abroad, flights included).
- Items "από προηγούμενη απόφαση" come from how the person actually decided before — they are better evidence than general statements.
- Ranked places someone has visited ("#1 … — why") show the TYPE of trip they love: prefer destinations with the same qualities. A place they never want to visit again is a strict "avoid".
- Routine obligations (e.g. "back by Sunday 21:00, work on Monday") do not override dates the group explicitly asked for: whoever joins a Friday–Monday trip has arranged it.
- Weekly routines (classes, gym, work, practice) matter for everyday local plans: an option that clashes with or is tight against one at that hour scores lower and says so in reasons; one that fits around it is better. For trips and special occasions they are flexible.
- For big trips outside Europe (once-in-a-while experiences), everyday money amounts are only a loose reference; the request's own budget, if any, is what counts.
- Money is a guard-rail, not the goal. What the group will DO — the activities, places, food, nightlife and nature each person likes — decides. A price around someone's usual amount, or up to ~25% above it, costs at most a few points; only a clear overshoot of a stated strict limit, or something far above what they usually spend (over ~30%), is a real minus. Never prefer an option just because it is cheaper, and never rank a cheaper option above one with clearly better activities for the person.
- If nothing in the memory covers an aspect, do not penalise it: infer cautiously from similar items, or stay neutral and mention it in unknowns.`;

/** A catalogue venue as given to the model (public listing; hours/programme never verified). */
export interface CatalogueVenue {
  name: string;
  subtype: string;
  area: string;
  address?: string;
  quiet?: boolean;
  priceHint?: number;
}

export interface PlanRequest {
  title: string;
  text: string;
  category: Category;
  periodStart: string | null;
  periodEnd: string | null;
  place?: string;
  kind?: RequestKind;
  city?: string;
  area?: string;
}

const LINKS = {
  type: 'array',
  items: { type: 'object', additionalProperties: false, required: ['personaId', 'memoryId', 'text'], properties: { personaId: { type: 'string' }, memoryId: { type: 'string' }, text: { type: 'string', description: 'short Greek: which wish this serves and how' } } },
};
const RawLink = z.object({ personaId: z.string(), memoryId: z.string(), text: z.string() });

function memoryBlock(twins: TwinContext[], ctx?: RequestContext | null) {
  return twins.map((t) => `${t.persona.name} (personaId ${t.persona.id}):\n${describeItems(t.items, ctx, t.learned) || '  (no memory)'}`).join('\n\n');
}

/** Candidate plans. Local kinds: one named venue each. Trips: full itineraries. */
export async function generateOptions(req: PlanRequest, twins: TwinContext[], ctx?: RequestContext | null, catalogue: CatalogueVenue[] = [], feedback: string[] = []): Promise<CandidateOption[]> {
  const city = req.city || 'Αθήνα';
  const retry = feedback.length ? `\n\nA previous attempt was REJECTED by the validator for: ${feedback.slice(0, 6).join('; ')}. Fix these.` : '';
  if (req.kind === 'trip') return generateTrips(req, twins, ctx, city, retry);
  const local = !!req.kind && LOCAL_KINDS.includes(req.kind);
  const data = await completeJSON({
    name: 'candidate_options',
    system: `You propose concrete, followable plans for a group of friends who are in ${city}. Request kind: ${req.kind ? KIND_LABEL[req.kind] : 'other'}.
${READING_RULES}
${TONE}
- 5 options, DIFFERENT from each other, each answering the request as asked. Include at least one option that satisfies every strict item that applies, and as close as possible to everyone's wishes. Do not add things nobody asked for (no extra walk or snack).
${
  local
    ? `- Each option is ONE specific, NAMED place (its real name) of the requested kind, in ${city}${req.area ? ` and inside the requested area: ${req.area}` : ''}. Never "κάπου στα …", "ένα καφέ κοντά στο …", "ένα από τα μπαρ της οδού …".
- Prefer the CATALOGUE venues below (real places with a public listing). You may name another real place you know well. Name only places you are sure exist in that area; never invent or guess a name to fit a budget or a theme — a real place that fits a little less is better than an invented one. Each option a DIFFERENT place.
- coffee: cafés only. drinks: follow the asked type (cocktail bar, quiet bar, wine bar, beer). club: a club. live: a venue for live music — do NOT state an artist, programme, start time or ticket price as fact; describe the venue and its kind of music.
- Use what people listen to: their genres decide the TYPE of place (λαϊκά → μπουζούκια/πίστα, house/pop → club, jazz → jazz club, rock → rock bar/live). If someone's favourite artist usually plays at a kind of venue, propose such a venue and put that artist in artistHint (it will be shown as "δείτε αν εμφανίζεται", never as a confirmed date). artistHint "" otherwise.
- startsAt/endsAt: the proposed time window inside the requested period (ISO with the Athens offset). One evening past midnight is one outing.
- costPerPerson: honest estimate per person for what they will typically order/pay AT THAT PLACE (its own price level: e.g. one or two drinks in a cocktail bar, one coffee in a café); -1 if unknown. A catalogue "~€" hint is the team's estimate for that place: use it. Never copy the group's budget or the same number into every option — different places have different prices. costNote: what it includes.
- features: 3-5 short Greek facts that help judging (quiet or loud, comfortable tables, music, distance to metro…).`
    : `- Concrete options with real place names where relevant; startsAt/endsAt inside the requested period (ISO with the Athens offset); honest cost per person (-1 if unknown); 3-5 features. venueName: the main place ("" if none), area/city where it is.`
}
- why: 1-3 links per option to memory item ids WITH the personaId of the twin that owns the item — only wishes the option really serves (say so in the text; a wish it does NOT serve is not a why-link).
- Greek text only (place names may be in Latin script).`,
    user: `Request: ${req.title}\nOriginal text: """${req.text}"""\nPeriod: ${req.periodStart ?? '?'} → ${req.periodEnd ?? '?'} (${describeContext(ctx)})\nCity: ${city}${req.area ? ` · area: ${req.area}` : ''}\n\nCATALOGUE (${city}):\n${catalogue.map((v) => `- ${v.name} · ${v.subtype} · ${v.area}${v.address ? `, ${v.address}` : ''}${v.quiet ? ' · ήσυχο' : ''}${v.priceHint ? ` · ~${v.priceHint}€` : ''}`).join('\n') || '(none for this city/kind)'}\n\n${memoryBlock(twins, ctx)}${retry}`,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['options'],
      properties: {
        options: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'emoji', 'summary', 'venueName', 'venueKind', 'area', 'city', 'address', 'costPerPerson', 'costNote', 'startsAt', 'endsAt', 'features', 'why', 'artistHint'],
            properties: {
              title: { type: 'string' },
              emoji: { type: 'string' },
              summary: { type: 'string' },
              venueName: { type: 'string' },
              venueKind: { type: 'string', description: 'e.g. specialty café, cocktail bar, wine bar, club, live venue, taverna' },
              area: { type: 'string' },
              city: { type: 'string' },
              address: { type: 'string', description: 'street address only if you are sure, else ""' },
              costPerPerson: { type: 'number' },
              costNote: { type: 'string' },
              startsAt: { type: 'string' },
              endsAt: { type: 'string' },
              features: { type: 'array', items: { type: 'string' } },
              why: LINKS,
              artistHint: { type: 'string' },
            },
          },
        },
      },
    },
    maxTokens: 7000,
  });
  const p = z
    .object({
      options: z.array(
        z.object({
          title: z.string(),
          emoji: z.string(),
          summary: z.string(),
          venueName: z.string(),
          venueKind: z.string(),
          area: z.string(),
          city: z.string(),
          address: z.string(),
          costPerPerson: z.number(),
          costNote: z.string(),
          startsAt: z.string(),
          endsAt: z.string(),
          features: z.array(z.string()),
          why: z.array(RawLink),
          artistHint: z.string().catch(''),
        }),
      ),
    })
    .parse(data);
  return p.options.slice(0, 6).map((o, i) => ({
    id: `opt-${i + 1}`,
    title: clean(o.title).slice(0, 90),
    emoji: [...o.emoji].slice(0, 2).join('') || '✨',
    summary: confident(clean(o.summary)).slice(0, 400),
    location: clean([o.area, o.city].filter(Boolean).join(', ')).slice(0, 80),
    costPerPerson: o.costPerPerson >= 0 ? Math.round(o.costPerPerson) : null,
    costNote: clean(o.costNote).slice(0, 160),
    startsAt: parseIso(o.startsAt) ? o.startsAt : null,
    endsAt: parseIso(o.endsAt) ? o.endsAt : null,
    features: o.features.slice(0, 7).map((f) => clean(f).slice(0, 80)).filter((f) => !HEDGE.test(normalizeGreek(f))),
    origin: 'ai' as const,
    ...(o.venueName.trim()
      ? { venue: { name: clean(o.venueName).slice(0, 80), kind: clean(o.venueKind).slice(0, 40), area: clean(o.area).slice(0, 60), city: clean(o.city).slice(0, 40) || city, ...(o.address.trim() ? { address: clean(o.address).slice(0, 80) } : {}) } satisfies Venue }
      : {}),
    why: o.why.map((w) => ({ ...w, text: clean(w.text).slice(0, 160) })),
    ...(o.artistHint.trim() ? { artistHint: clean(o.artistHint).slice(0, 60) } : {}),
  }));
}

const SLOT = {
  type: 'object',
  additionalProperties: false,
  required: ['start', 'end', 'part', 'title', 'place', 'serves', 'alternative', 'conditional'],
  properties: {
    start: { type: 'string', description: 'HH:MM local time' },
    end: { type: 'string', description: 'HH:MM local time' },
    part: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'night'] },
    title: { type: 'string', description: 'specific stop, e.g. a named trail, museum, club, restaurant street' },
    place: { type: 'string' },
    serves: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['personaId', 'memoryId'], properties: { personaId: { type: 'string' }, memoryId: { type: 'string' } } } },
    alternative: { type: 'string', description: 'fallback if it does not run (weather, season, closed) or ""' },
    conditional: { type: 'string', description: 'what it depends on (booking, weather) or ""' },
  },
};
const RawSlot = z.object({ start: z.string(), end: z.string(), part: z.enum(['morning', 'afternoon', 'evening', 'night']), title: z.string(), place: z.string(), serves: z.array(z.object({ personaId: z.string(), memoryId: z.string() })), alternative: z.string(), conditional: z.string() });

async function generateTrips(req: PlanRequest, twins: TwinContext[], ctx: RequestContext | null | undefined, origin: string, retry: string): Promise<CandidateOption[]> {
  const dates: string[] = [];
  const s = parseIso(req.periodStart);
  const e = parseIso(req.periodEnd);
  if (s && e) for (let t = s.getTime(); dates.length < 10; t += 86400000) {
    const p = localParts(new Date(t));
    const d = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    if (dates.at(-1) !== d) dates.push(d);
    const pe = localParts(e);
    if (d === `${pe.y}-${String(pe.m).padStart(2, '0')}-${String(pe.d).padStart(2, '0')}`) break;
  }
  const where = ctx?.where === 'abroad' ? 'abroad (any country that fits; it does NOT have to be in Greece)' : ctx?.where === 'domestic' ? 'in Greece' : 'anywhere that fits';
  const data = await completeJSON({
    name: 'trip_plans',
    system: `You plan complete group trips that people can actually follow. The group starts from ${origin}. Destination: ${where}${req.place ? `, the request names: ${req.place}` : ''}.
${READING_RULES}
${TONE}
- 3 DIFFERENT plans, each ONE destination city and country. Choose destinations for the activities and places the group wants, not for being cheap: do not default to the nearest or cheapest city (e.g. always Κωνσταντινούπολη) unless it is truly the best fit; the three should differ in character (e.g. mountains/nature, a city break, sea or food).
- itinerary.days: one entry for EVERY date in ${JSON.stringify(dates)} (date as YYYY-MM-DD, title like "Πέμπτη — άφιξη"), each with 2-4 slots in time order, no overlaps (HH:MM local time). First day starts with the departure transfer, last day ends with the return.
- Slots are SPECIFIC: a named trail/peak, museum, market, a named club or bar for the night, a restaurant area. Realistic transfer times and a safety buffer before the return. In winter, if a cable car / trail / beach may not run, give an "alternative".
- serves: the memory ids (with the owner's personaId) each slot really serves. Cover every person's wishes somewhere if possible; strict needs (e.g. private bathroom) go into stay.note.
- depart.at / return.at: ISO datetimes with the Athens offset; return.at = arrival back in ${origin}, respecting every return deadline in the memory.
- cost per person in EUR: transport + stay + food + activities = total (estimates, flights/bus included).
- Greek text only (place names may be in Latin script).`,
    user: `Request: ${req.title}\nOriginal text: """${req.text}"""\nPeriod: ${req.periodStart ?? '?'} → ${req.periodEnd ?? '?'} (${describeContext(ctx)})\n\n${memoryBlock(twins, ctx)}${retry}`,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['options'],
      properties: {
        options: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'emoji', 'summary', 'destination', 'country', 'features', 'why', 'itinerary'],
            properties: {
              title: { type: 'string', description: 'city, country — short hook' },
              emoji: { type: 'string' },
              summary: { type: 'string', description: 'two sentences' },
              destination: { type: 'string' },
              country: { type: 'string' },
              features: { type: 'array', items: { type: 'string' } },
              why: LINKS,
              itinerary: {
                type: 'object',
                additionalProperties: false,
                required: ['depart', 'return', 'stay', 'days', 'cost'],
                properties: {
                  depart: { type: 'object', additionalProperties: false, required: ['at', 'mode'], properties: { at: { type: 'string' }, mode: { type: 'string' } } },
                  return: { type: 'object', additionalProperties: false, required: ['at', 'mode'], properties: { at: { type: 'string' }, mode: { type: 'string' } } },
                  stay: { type: 'object', additionalProperties: false, required: ['name', 'area', 'note'], properties: { name: { type: 'string' }, area: { type: 'string' }, note: { type: 'string' } } },
                  days: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['date', 'title', 'slots'], properties: { date: { type: 'string' }, title: { type: 'string' }, slots: { type: 'array', items: SLOT } } } },
                  cost: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['transport', 'stay', 'food', 'activities', 'total'],
                    properties: { transport: { type: 'number' }, stay: { type: 'number' }, food: { type: 'number' }, activities: { type: 'number' }, total: { type: 'number' } },
                  },
                },
              },
            },
          },
        },
      },
    },
    maxTokens: 16000,
  });
  const p = z
    .object({
      options: z.array(
        z.object({
          title: z.string(),
          emoji: z.string(),
          summary: z.string(),
          destination: z.string(),
          country: z.string(),
          features: z.array(z.string()),
          why: z.array(RawLink),
          itinerary: z.object({
            depart: z.object({ at: z.string(), mode: z.string() }),
            return: z.object({ at: z.string(), mode: z.string() }),
            stay: z.object({ name: z.string(), area: z.string(), note: z.string() }),
            days: z.array(z.object({ date: z.string(), title: z.string(), slots: z.array(RawSlot) })),
            cost: z.object({ transport: z.number(), stay: z.number(), food: z.number(), activities: z.number(), total: z.number() }),
          }),
        }),
      ),
    })
    .parse(data);
  return p.options.slice(0, 4).map((o, i): CandidateOption => {
    const it: Itinerary = {
      origin,
      destination: clean(o.destination).slice(0, 60),
      country: clean(o.country).slice(0, 40),
      depart: { at: o.itinerary.depart.at, mode: confident(clean(o.itinerary.depart.mode)).slice(0, 80) },
      return: { at: o.itinerary.return.at, mode: confident(clean(o.itinerary.return.mode)).slice(0, 80) },
      stay: { name: clean(o.itinerary.stay.name).slice(0, 80), area: clean(o.itinerary.stay.area).slice(0, 60), note: confident(clean(o.itinerary.stay.note)).slice(0, 160) },
      days: o.itinerary.days.slice(0, 10).map((d) => ({
        date: d.date.slice(0, 10),
        title: clean(d.title).slice(0, 60),
        slots: d.slots.slice(0, 6).map((x) => ({
          start: x.start,
          end: x.end,
          part: x.part,
          title: clean(x.title).slice(0, 120),
          place: clean(x.place).slice(0, 80),
          serves: x.serves,
          ...(x.alternative.trim() ? { alternative: clean(x.alternative).slice(0, 140) } : {}),
          ...(x.conditional.trim() ? { conditional: clean(x.conditional).slice(0, 120) } : {}),
        })),
      })),
      cost: { transport: Math.round(o.itinerary.cost.transport), stay: Math.round(o.itinerary.cost.stay), food: Math.round(o.itinerary.cost.food), activities: Math.round(o.itinerary.cost.activities), total: Math.round(o.itinerary.cost.total) },
    };
    return {
      id: `opt-${i + 1}`,
      title: clean(o.title).slice(0, 90),
      emoji: [...o.emoji].slice(0, 2).join('') || '🧳',
      summary: confident(clean(o.summary)).slice(0, 400),
      location: `${it.destination}, ${it.country}`,
      costPerPerson: it.cost.total,
      costNote: `μετακίνηση ${it.cost.transport}€ + διαμονή ${it.cost.stay}€ + φαγητό ${it.cost.food}€ + δραστηριότητες ${it.cost.activities}€`,
      startsAt: parseIso(it.depart.at) ? it.depart.at : null,
      endsAt: parseIso(it.return.at) ? it.return.at : null,
      features: o.features.slice(0, 6).map((f) => clean(f).slice(0, 80)).filter((f) => !HEDGE.test(normalizeGreek(f))),
      origin: 'ai',
      why: o.why.map((w) => ({ ...w, text: clean(w.text).slice(0, 160) })),
      itinerary: it,
    };
  });
}

/** One line per option for the evaluator: the SAME validated plan the group will see. */
export function describeOption(o: CandidateOption): string {
  const head = `- ${o.id}: ${o.title}${o.venue ? ` | ${o.venue.name} (${o.venue.kind}), ${o.venue.area}` : ` | ${o.location}`} | ${o.costPerPerson ?? '?'}€/άτομο | ${o.startsAt ?? '?'} → ${o.endsAt ?? '?'} | ${o.features.join('; ')} | ${o.summary}`;
  if (!o.itinerary) return head;
  const it = o.itinerary;
  return `${head}\n    διαμονή: ${it.stay.name}, ${it.stay.area} (${it.stay.note})\n${it.days.map((d) => `    ${d.date} ${d.title}: ${d.slots.map((x) => `${x.start}-${x.end} ${x.title}${x.alternative ? ` [εναλλακτική: ${x.alternative}]` : ''}`).join(' · ')}`).join('\n')}`;
}

/**
 * The group struck some activities out of a trip plan: return the same plan without them.
 * Minimal change only — every other slot stays as it is; costs follow what was removed.
 */
export async function reviseItinerary(it: Itinerary, removed: { date: string; title: string }[]): Promise<{ days: Itinerary['days']; cost: Itinerary['cost'] }> {
  const data = await completeJSON({
    name: 'trip_revision',
    system: `You edit a group's trip plan. The group removed some activities. Return the SAME plan without them.
- Remove exactly the listed activities. Keep every other slot exactly as it is (same start, end, part, title, place, serves, alternative, conditional). Do not add new activities and do not move other days.
- Only if a removed activity leaves a slot's neighbour without a sensible end, you may stretch that neighbour's end time — nothing else.
- cost: lower "activities" (or "food" for a removed meal) by what the removed activities would cost per person; keep transport and stay; total = transport + stay + food + activities.
${TONE}`,
    user: `PLAN (JSON):\n${JSON.stringify({ days: it.days, cost: it.cost })}\n\nREMOVED:\n${removed.map((r) => `- ${r.date}: ${r.title}`).join('\n')}`,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['days', 'cost'],
      properties: {
        days: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['date', 'title', 'slots'], properties: { date: { type: 'string' }, title: { type: 'string' }, slots: { type: 'array', items: SLOT } } } },
        cost: { type: 'object', additionalProperties: false, required: ['transport', 'stay', 'food', 'activities', 'total'], properties: { transport: { type: 'number' }, stay: { type: 'number' }, food: { type: 'number' }, activities: { type: 'number' }, total: { type: 'number' } } },
      },
    },
    maxTokens: 8000,
  });
  const p = z.object({ days: z.array(z.object({ date: z.string(), title: z.string(), slots: z.array(RawSlot) })), cost: z.object({ transport: z.number(), stay: z.number(), food: z.number(), activities: z.number(), total: z.number() }) }).parse(data);
  return {
    days: p.days.map((d) => ({
      date: d.date.slice(0, 10),
      title: clean(d.title).slice(0, 60),
      slots: d.slots.map((x) => ({
        start: x.start,
        end: x.end,
        part: x.part,
        title: clean(x.title).slice(0, 120),
        place: clean(x.place).slice(0, 80),
        serves: x.serves,
        ...(x.alternative.trim() ? { alternative: clean(x.alternative).slice(0, 140) } : {}),
        ...(x.conditional.trim() ? { conditional: clean(x.conditional).slice(0, 120) } : {}),
      })),
    })),
    cost: { transport: Math.round(p.cost.transport), stay: Math.round(p.cost.stay), food: Math.round(p.cost.food), activities: Math.round(p.cost.activities), total: Math.round(p.cost.total) },
  };
}

// ---------------------------------------------------------------------------
// 5. Each twin evaluates each option
// ---------------------------------------------------------------------------

export async function evaluateOptions(options: CandidateOption[], twins: TwinContext[], ctx?: RequestContext | null, request?: string): Promise<Evaluation[]> {
  // One call per twin, in parallel: lower latency, and each twin only sees its own memory.
  if (twins.length > 1) return (await Promise.all(twins.map((t) => evaluateOptions(options, [t], ctx, request)))).flat();
  const data = await completeJSON({
    name: 'twin_evaluations',
    system: `You are the digital twin of a person (or of several friends). For EACH person and EACH option, judge the option the way that person would, using ONLY their memory items below.
- score 0-100 = how glad the person would be to go with their friends. These are friends who WANT to do something together, so being part of a good group plan counts by itself:
  85-95 = it is what they would pick themselves; 75-84 = they are happy to go (a sensible plan with nothing they dislike — the usual case); 65-74 = they would go gladly, though something they would prefer is missing (e.g. they would rather dance than sit at a bar) — a missing preference is NOT a conflict; 50-64 = something they actually dislike, or a clear overshoot of what they usually spend; below 50 = only when it clashes with something they strongly dislike or a firm rule.
  No relevant memory for an aspect is NOT a minus: start from ~75 for a sensible plan and move up or down only for what the memory actually says. Be decisive where the memory is clear.
${READING_RULES}
${TONE}
- reasons: 1-3 short Greek reasons, each citing the memoryId it comes from, with effect for/against.
- violations: ONLY for HARD items without a numeric rule (e.g. vegetarian, no tent) whose context applies to this plan and that the option itself clearly breaks; cite the memoryId. Something true of every option because of the requested dates (e.g. "works on Saturdays") is not a violation of an option — mention it in unknowns. Numeric limits (cost, time) are checked by code — do not list them.
- unknowns: what you cannot judge because the memory or the option lacks information. Never invent facts about the person.
- verdict: a few Greek words in the person's voice.`,
    user: `PLAN: ${request ?? ''} (${describeContext(ctx)})\n\nOPTIONS:\n${options.map(describeOption).join('\n')}\n\nPEOPLE:\n${twins.map((t) => `${t.persona.name} (personaId ${t.persona.id}):\n${describeItems(t.items, ctx, t.learned) || '  (no memory)'}`).join('\n\n')}`,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['evaluations'],
      properties: {
        evaluations: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['personaId', 'optionId', 'score', 'verdict', 'reasons', 'violations', 'unknowns'],
            properties: {
              personaId: { type: 'string' },
              optionId: { type: 'string' },
              score: { type: 'number' },
              verdict: { type: 'string' },
              reasons: {
                type: 'array',
                items: { type: 'object', additionalProperties: false, required: ['memoryId', 'effect', 'text'], properties: { memoryId: { type: 'string' }, effect: { type: 'string', enum: ['for', 'against'] }, text: { type: 'string' } } },
              },
              violations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['memoryId', 'text'], properties: { memoryId: { type: 'string' }, text: { type: 'string' } } } },
              unknowns: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    maxTokens: 12000,
  });
  const p = z
    .object({
      evaluations: z.array(
        z.object({
          personaId: z.string(),
          optionId: z.string(),
          score: z.number(),
          verdict: z.string(),
          reasons: z.array(z.object({ memoryId: z.string(), effect: z.enum(['for', 'against']), text: z.string() })),
          violations: z.array(z.object({ memoryId: z.string(), text: z.string() })),
          unknowns: z.array(z.string()),
        }),
      ),
    })
    .parse(data);
  const out: Evaluation[] = [];
  for (const t of twins) {
    const ids = new Set(t.items.map((m) => m.id));
    const hardQual = new Set(t.items.filter((m) => m.hard && !m.rule).map((m) => m.id));
    for (const o of options) {
      const e = p.evaluations.find((x) => x.personaId === t.persona.id && x.optionId === o.id);
      if (!e) {
        out.push({ personaId: t.persona.id, optionId: o.id, score: 50, verdict: '', reasons: [], violations: [], unknowns: ['Το AI δεν αξιολόγησε αυτή την επιλογή — ουδέτερη βαθμολογία.'] });
        continue;
      }
      out.push({
        personaId: t.persona.id,
        optionId: o.id,
        score: Math.round(clamp(e.score, 0, 100)),
        verdict: clean(e.verdict).slice(0, 80),
        reasons: e.reasons.filter((r) => ids.has(r.memoryId)).slice(0, 4).map((r) => ({ ...r, text: clean(r.text).slice(0, 200) })),
        violations: e.violations.filter((v) => hardQual.has(v.memoryId)).map((v) => ({ ...v, text: clean(v.text).slice(0, 200) })),
        unknowns: e.unknowns.slice(0, 3).map((u) => clean(u).slice(0, 160)),
      });
    }
  }
  return out;
}

/** Style notes for a prompt, with the person's dialect words as a strict rule. */
function styleLine(style: StyleCard | null, fallback: string): string {
  if (!style) return fallback;
  const swaps = swapsNote(style);
  return `${style.summary} | ${style.traits.join('; ')}${swaps ? ` | RULE: ${swaps}` : ''}`;
}

// ---------------------------------------------------------------------------
// 6. Group-chat drafts in each person's style
// ---------------------------------------------------------------------------

export async function draftMessages(briefs: { personaId: string; name: string; samples: string[]; style: StyleCard | null; facts: string[] }[]): Promise<Record<string, string>> {
  const data = await completeJSON({
    name: 'twin_group_messages',
    system: `You write the message each friend's digital twin proposes to post in the friends' Greek group chat about the group's plan.
The friends should not be able to tell the twin from the real person. Style matters more than completeness.
- Learn the voice only from that person's WRITING SAMPLES and style notes: register, typical words, rhythm, length, punctuation, accents, emoji.
- Casual chat, never a report. Do not mention "Twin", "AI", approvals or constraints. Do not copy whole sample sentences.
- Greek, first person, 1-2 short sentences, max 200 characters.
- Pick only the 1-2 FACTS that matter most to this person. State nothing that is not in their FACTS; every number must appear in the facts.
- The messages must sound clearly different from each other.`,
    user: briefs
      .map((b) => `## personaId: ${b.personaId} (${b.name})\nSTYLE: ${styleLine(b.style, 'unknown')}\nWRITING SAMPLES:\n${b.samples.map((s) => `- ${s}`).join('\n')}\nFACTS:\n${b.facts.map((f) => `- ${f}`).join('\n')}`)
      .join('\n\n'),
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['messages'],
      properties: { messages: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['personaId', 'text'], properties: { personaId: { type: 'string' }, text: { type: 'string' } } } } },
    },
    maxTokens: 3000,
  });
  const p = z.object({ messages: z.array(z.object({ personaId: z.string(), text: z.string() })) }).parse(data);
  const out: Record<string, string> = {};
  for (const m of p.messages) if (briefs.some((b) => b.personaId === m.personaId)) out[m.personaId] = clean(m.text).slice(0, 300);
  return out;
}

// ---------------------------------------------------------------------------
// 7. The twins' negotiation as a group DM, in each owner's voice
// ---------------------------------------------------------------------------

export interface ChatBrief {
  personaId: string;
  name: string;
  style: StyleCard | null;
  samples: string[];
  facts: string[];
}

export async function negotiationChat(briefs: ChatBrief[], shared: string[]): Promise<{ personaId: string; text: string }[]> {
  const data = await completeJSON({
    name: 'twin_negotiation_chat',
    system: `You write the Instagram group DM in which the digital twins of a group of Greek friends negotiate a plan. Each twin writes EXACTLY like its owner, so the friends would believe it is a real chat between them.
- Learn each voice only from that person's WRITING SAMPLES and style notes: length, slang, accents or not, punctuation, emoji, typical words. The voices must be clearly different.
- Show how each person thinks: what they want first (their vote), why (their facts), what bothers them, what they are willing to give up. Disagree where the votes differ, then converge to the SHARED outcome (if it is a compromise, the person who gives something up says so in their own way).
- 6-10 messages in total, each person at least once, natural order (not strictly round-robin). Each message max 160 characters, casual Greek chat, first person. No "Twin", "AI", "memory", "score" or numbers out of 100.
- Every fact, number, place or option title must come from that person's FACTS or the SHARED facts. Nothing invented.
- Talk about the plan as settled: no "να το επιβεβαιώσουμε", "να ελέγξουμε", "αν είναι ανοιχτό".
- Every message must move the decision forward: a preference, a trade-off, a disagreement, or a concrete detail of the plan that matters for THIS choice. No filler, no box-ticking. Do not bring up a need that the options already meet (an allergy, a diet, a private bathroom, no camping) unless it is a real reason for or against an option — e.g. never «έχει και φαγητό χωρίς γαλακτοκομικά» while picking a city.
- A twin NEVER accepts breaking its own strict limit on its owner's behalf. If the SHARED facts say the proposal does not cover someone's limit, the group still converges on that closest proposal; that person says plainly what is not covered and that they will decide themselves (with their own approval) — no "οκ, κάνω πίσω". If the SHARED facts do NOT say that, nobody talks about deciding "with their own approval": everyone's limits are covered.`,
    user: `SHARED:\n${shared.map((f) => `- ${f}`).join('\n')}\n\n${briefs
      .map((b) => `## personaId: ${b.personaId} (${b.name})\nSTYLE: ${styleLine(b.style, 'unknown — write plainly')}\nWRITING SAMPLES:\n${b.samples.map((s) => `- ${s}`).join('\n') || '- (none)'}\nFACTS:\n${b.facts.map((f) => `- ${f}`).join('\n')}`)
      .join('\n\n')}`,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['messages'],
      properties: { messages: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['personaId', 'text'], properties: { personaId: { type: 'string' }, text: { type: 'string' } } } } },
    },
    maxTokens: 4000,
  });
  const p = z.object({ messages: z.array(z.object({ personaId: z.string(), text: z.string() })) }).parse(data);
  return p.messages.filter((m) => briefs.some((b) => b.personaId === m.personaId)).map((m) => ({ personaId: m.personaId, text: clean(m.text).slice(0, 220) })).filter((m) => m.text);
}

// ---------------------------------------------------------------------------
// 8. Private chat: anyone talks to ONE twin; it answers as its owner would
// ---------------------------------------------------------------------------

export interface ChatTurn {
  role: 'user' | 'twin';
  text: string;
}

export async function privateReply(persona: Persona, items: MemoryItem[], samples: string[], turns: ChatTurn[], now = new Date(), redo?: string): Promise<{ reply: string; usedMemoryIds: string[] }> {
  const p0 = localParts(now);
  const data = await completeJSON({
    name: 'private_chat_reply',
    system: `You are the digital twin of ${persona.name}. Someone is chatting privately with ${persona.name} about their own topic. Reply exactly as ${persona.name} would in a private chat.
- Voice: learn it ONLY from the WRITING SAMPLES and style notes (dialect, slang, accents or not, punctuation, emoji, typical length). Sound like a real person, not an assistant.
- The samples come from OTHER conversations: they show HOW ${persona.name} writes, never WHAT to say. Never reuse a sample sentence or its content (e.g. "να το προλάβουμε" belonged to a different plan). Every reply must make sense on its own as an answer to the LAST message of THIS conversation; think about what was actually asked (a day, a time, a place) and answer that.
- Short: one chat message, 1-3 short sentences. No lists, no headings, no follow-up offers. Match the other person's energy and length: a quick "πού 'σαι ρε" gets a quick answer.
- It is a ONE-TO-ONE chat: talk to the person in the singular ("εσύ", "πού λες να πάμε;"), never "εσείς / λέτε", unless they clearly speak for a group.
- Sound human, not templated: vary how messages start and end; do NOT open every message the same way; use address words like "ρε", "φίλε", "μπρο", "μάγκα" only now and then (most real messages have none) and never the same one as in your previous message. Don't repeat the same filler, emoji or phrase across messages.
- Facts about ${persona.name} (tastes, habits, opinions, schedule, places, music) come ONLY from the MEMORY. Never invent new facts about them; if the memory does not cover it, answer the way they plausibly would without stating new facts, or say you'd have to think about it.
- Use judgement with their SCHEDULE like a real person: today is ${WEEKDAY_EN[p0.weekday]} ${athensNow(now)} (Athens). If someone proposes a day/time for an everyday plan (coffee, drinks, a call) that clashes with or is tight against a routine in the memory (classes, gym, work, practice), say so naturally and suggest another time ("λίγο δύσκολο στις 6, έχω γυμναστήριο — πάμε πιο νωρίς / μετά τις 8;"). Do not mention routines that do not touch the proposed time. Routines are flexible for special occasions: for a trip or a few days away they would happily skip a class or the gym.
- Do not mention memory, sources, the app or AI. Only if asked directly whether you are a bot/AI, say honestly that you are ${persona.name}'s digital twin.
- Be respectful; never share phone numbers, addresses or other people's private details.
- usedMemoryIds: 0-3 ids of the memory items the reply relies on.`,
    user: `${persona.age ? `AGE: ${persona.age}\n` : ''}STYLE: ${styleLine(persona.style, 'unknown — write plainly and casually')}
WRITING SAMPLES:
${samples.map((s) => `- ${s}`).join('\n') || '- (none)'}

MEMORY (${persona.name}):
${items.map((m) => `- ${m.id}: ${m.statement}`).join('\n') || '- (none)'}

CONVERSATION:
${turns.map((t) => `${t.role === 'user' ? 'Ο ΑΛΛΟΣ' : persona.name.toUpperCase()}: ${t.text}`).join('\n')}
${turns.some((t) => t.role === 'twin') ? `\nYour previous messages (do not reuse their openings or address words): ${turns.filter((t) => t.role === 'twin').slice(-3).map((t) => `«${t.text}»`).join(' ')}` : ''}

Write ${persona.name}'s reply to the last message.${redo ? `\n\nYour previous draft «${redo}» copied a sample from another conversation and did not answer the last message. Write a new reply that does.` : ''}`,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['reply', 'usedMemoryIds'],
      properties: { reply: { type: 'string' }, usedMemoryIds: { type: 'array', items: { type: 'string' } } },
    },
    maxTokens: 2500,
  });
  const p = z.object({ reply: z.string(), usedMemoryIds: z.array(z.string()) }).parse(data);
  const ids = new Set(items.map((m) => m.id));
  return { reply: clean(p.reply).slice(0, 600), usedMemoryIds: p.usedMemoryIds.filter((id) => ids.has(id)).slice(0, 3) };
}
