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
import { CATEGORIES, DOMAINS, type CandidateOption, type Category, type Evaluation, type MemoryItem, type Persona, type StyleCard } from '../shared/types';
import { containsQuote, clamp } from '../shared/text';
import { parseIso } from '../shared/time';
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
  return s
    .replace(/[\u0590-\u08FF\u0900-\u0DFF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'statement', 'domain', 'polarity', 'strength', 'hard', 'metric', 'value', 'categories', 'keywords', 'quote', 'confidence'],
  properties: {
    kind: { type: 'string', enum: ['preference', 'constraint', 'fact', 'decision_pattern', 'style'] },
    statement: { type: 'string', description: 'short Greek statement about the person, third person' },
    domain: { type: 'string', enum: DOMAINS },
    polarity: { type: 'string', enum: ['likes', 'avoids', 'neutral'] },
    strength: { type: 'string', enum: ['low', 'medium', 'high'] },
    hard: { type: 'boolean', description: 'true only for things the person will not accept / must have' },
    metric: { type: 'string', enum: ['none', 'max_cost', 'latest_end'], description: 'machine-checkable part of a hard constraint' },
    value: { type: 'string', description: 'max_cost: euros per person as a number. latest_end: "weekly:<0-6, Sunday=0>:HH:MM" for a recurring limit, or an ISO datetime with +02:00 for a one-off. "" if metric is none.' },
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
    categories: r.categories.filter((c): c is Category => (CATEGORIES as string[]).includes(c)),
    keywords: r.keywords.map((k) => k.trim()).filter(Boolean).slice(0, 6),
    quote: r.quote.trim(),
    confidence: clamp(r.confidence, 0, 1),
  };
}

const MEMORY_RULES = `Memory item rules:
- kind: preference (likes/avoids), constraint (cannot / will not accept, or must have), fact (about the person), decision_pattern (how they tend to choose, from past decisions), style (how they write).
- hard=true only when the person clearly states a limit or a must. Everything else is soft.
- For money limits use metric max_cost with the number; for "must be back by …" use metric latest_end. Never invent numbers or times.
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
  groupDrafts: MemoryDraft[];
  wishDrafts: Record<string, MemoryDraft[]>;
}

export async function parseRequest(text: string, now: Date, wishes: { personaId: string; name: string; text: string }[]): Promise<ParsedRequest> {
  const data = await completeJSON({
    name: 'group_request',
    system: `You read a Greek group request from friends in Athens, plus each person's one-off wishes for THIS request only.
Today is ${now.toISOString()} (Europe/Athens, UTC+02:00).
- category: trip, food, entertainment, activity, gift or other.
- period: the concrete start and end (ISO with +02:00) the request implies; if vague, choose the nearest sensible window (e.g. "αυτό το ΣΚ" = coming Saturday 09:00 to Sunday 21:00, "τριήμερο" = Friday evening to Sunday night unless a day is named).
- groupItems: limits stated in the request text itself that apply to everyone (e.g. "μέχρι 100€").
- wishes: for each person, turn their one-off wish text into memory items (scope: this request). Quotes must come from THAT person's wish text.
${MEMORY_RULES}
- For one-off deadlines use latest_end with an ISO datetime inside or right after the period.`,
    user: `Request: """${text}"""\n\n${wishes.map((w) => `Wish of ${w.name} (personaId ${w.personaId}): """${w.text}"""`).join('\n') || 'No one-off wishes.'}`,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'category', 'periodStart', 'periodEnd', 'groupItems', 'wishes'],
      properties: {
        title: { type: 'string', description: 'short Greek title, max 60 chars' },
        category: { type: 'string', enum: CATEGORIES },
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
    category: (CATEGORIES as string[]).includes(p.category) ? (p.category as Category) : 'other',
    periodStart: parseIso(p.periodStart) ? p.periodStart : null,
    periodEnd: parseIso(p.periodEnd) ? p.periodEnd : null,
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
}

function describeItems(items: MemoryItem[]): string {
  return items
    .map((m) => `  - ${m.id} [${m.scope === 'request' ? 'ΜΟΝΟ ΓΙΑ ΑΥΤΟ' : m.kind}${m.hard ? ', HARD' : ''}${m.rule ? `, ${m.rule.metric}=${m.rule.value}` : ''}] ${m.statement}`)
    .join('\n');
}

export async function generateOptions(req: { title: string; text: string; category: Category; periodStart: string | null; periodEnd: string | null }, twins: TwinContext[]): Promise<CandidateOption[]> {
  const data = await completeJSON({
    name: 'candidate_options',
    system: `You propose concrete options for a group of friends based in Athens, Greece.
Use what each person's twin memory says; make the options DIFFERENT from each other so the group has a real choice, and try to include at least one option that satisfies every HARD item.
- 5 options, realistic for Greece (real places are fine), with an honest estimated cost per person in euros (include transport/stay/food for trips; use -1 if you cannot estimate).
- startsAt / endsAt: ISO datetimes with +02:00 inside the requested period; endsAt = when they are back / the plan ends.
- features: 3-6 short Greek phrases that let each twin judge the option (e.g. accommodation type, private bathroom, vegetarian dishes, sea, hiking hours, music volume, crowd).
- These are suggestions with estimated prices, not bookings. Write every text field in Greek only (place names may be in Latin script).`,
    user: `Request (${req.category}): ${req.title}\nOriginal text: """${req.text}"""\nPeriod: ${req.periodStart ?? '?'} → ${req.periodEnd ?? '?'}\n\n${twins.map((t) => `${t.persona.name} (${t.persona.id}):\n${describeItems(t.items) || '  (no memory)'}`).join('\n\n')}`,
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
            required: ['title', 'emoji', 'summary', 'location', 'costPerPerson', 'costNote', 'startsAt', 'endsAt', 'features'],
            properties: {
              title: { type: 'string' },
              emoji: { type: 'string' },
              summary: { type: 'string' },
              location: { type: 'string' },
              costPerPerson: { type: 'number' },
              costNote: { type: 'string' },
              startsAt: { type: 'string' },
              endsAt: { type: 'string' },
              features: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    maxTokens: 7000,
  });
  const p = z.object({ options: z.array(z.object({ title: z.string(), emoji: z.string(), summary: z.string(), location: z.string(), costPerPerson: z.number(), costNote: z.string(), startsAt: z.string(), endsAt: z.string(), features: z.array(z.string()) })) }).parse(data);
  return p.options.slice(0, 6).map((o, i) => ({
    id: `opt-${i + 1}`,
    title: clean(o.title).slice(0, 80),
    emoji: [...o.emoji].slice(0, 2).join('') || '✨',
    summary: clean(o.summary).slice(0, 300),
    location: clean(o.location).slice(0, 80),
    costPerPerson: o.costPerPerson >= 0 ? Math.round(o.costPerPerson) : null,
    costNote: clean(o.costNote).slice(0, 160),
    startsAt: parseIso(o.startsAt) ? o.startsAt : null,
    endsAt: parseIso(o.endsAt) ? o.endsAt : null,
    features: o.features.slice(0, 7).map((f) => clean(f).slice(0, 80)),
    origin: 'ai',
  }));
}

// ---------------------------------------------------------------------------
// 5. Each twin evaluates each option
// ---------------------------------------------------------------------------

export async function evaluateOptions(options: CandidateOption[], twins: TwinContext[]): Promise<Evaluation[]> {
  // One call per twin, in parallel: lower latency, and each twin only sees its own memory.
  if (twins.length > 1) return (await Promise.all(twins.map((t) => evaluateOptions(options, [t])))).flat();
  const data = await completeJSON({
    name: 'twin_evaluations',
    system: `You are the digital twin of a person (or of several friends). For EACH person and EACH option, judge the option the way that person would, using ONLY their memory items below.
- score 0-100 (50 = neutral / no relevant memory). Be decisive where the memory is clear.
- reasons: 1-3 short Greek reasons, each citing the memoryId it comes from, with effect for/against.
- violations: ONLY for HARD items without a numeric rule (e.g. vegetarian, no tent) that the option clearly breaks; cite the memoryId. Numeric limits (cost, time) are checked by code — do not list them.
- unknowns: what you cannot judge because the memory or the option lacks information. Never invent facts about the person.
- verdict: a few Greek words in the person's voice.`,
    user: `OPTIONS:\n${options
      .map((o) => `- ${o.id}: ${o.title} | ${o.location} | ${o.costPerPerson ?? '?'}€/άτομο | ${o.startsAt ?? '?'} → ${o.endsAt ?? '?'} | ${o.features.join('; ')} | ${o.summary}`)
      .join('\n')}\n\nPEOPLE:\n${twins.map((t) => `${t.persona.name} (personaId ${t.persona.id}):\n${describeItems(t.items) || '  (no memory)'}`).join('\n\n')}`,
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
      .map((b) => `## personaId: ${b.personaId} (${b.name})\nSTYLE: ${b.style ? `${b.style.summary} | ${b.style.traits.join('; ')}` : 'unknown'}\nWRITING SAMPLES:\n${b.samples.map((s) => `- ${s}`).join('\n')}\nFACTS:\n${b.facts.map((f) => `- ${f}`).join('\n')}`)
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
