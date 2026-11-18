// Live AI for TwinSync. Two jobs only:
//   1. extract candidate preferences/constraints from an owner's text (owner confirms them);
//   2. draft each twin's group message in its owner's writing style (owner approves it).
// The group decision itself is never made by a model — it is computed in shared/engine.ts.
//
// Provider is chosen from the environment (server-side only, never sent to the browser):
//   OPENAI_API_KEY    -> OpenAI (default model gpt-6-luna, the hackathon-provided key)
//   ANTHROPIC_API_KEY -> Anthropic Claude (default model claude-opus-5-5)
//   neither           -> demo mode: deterministic rules/templates, clearly labelled in the UI
// AI_PROVIDER=openai|anthropic|demo forces a choice.

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { z } from 'zod';
import { extractWithRules } from '../shared/extractRules';
import { PREF_KEYS, PREF_META, coerceValue, isPrefKey } from '../shared/prefs';
import type { ExtractionCandidate } from '../shared/types';

export type Provider = 'openai' | 'anthropic' | 'demo';

export function aiProvider(): Provider {
  const forced = process.env.AI_PROVIDER?.toLowerCase();
  if (forced === 'openai' && process.env.OPENAI_API_KEY) return 'openai';
  if (forced === 'anthropic' && process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (forced === 'demo') return 'demo';
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

export const liveAiEnabled = () => aiProvider() !== 'demo';

let openai: OpenAI | null = null;
let anthropic: Anthropic | null = null;

export class AiError extends Error {}

/** One structured-JSON completion on the configured provider. */
async function completeJSON(opts: { name: string; system: string; user: string; schema: Record<string, unknown>; maxTokens: number }): Promise<{ data: unknown; model: string }> {
  const provider = aiProvider();
  if (provider === 'openai') {
    openai ??= new OpenAI();
    try {
      const res = await openai.chat.completions.create({
        model: aiModel()!,
        max_completion_tokens: opts.maxTokens,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
        response_format: { type: 'json_schema', json_schema: { name: opts.name, strict: true, schema: opts.schema } },
      });
      const choice = res.choices[0];
      if (choice?.message.refusal) throw new AiError('model declined the request');
      if (choice?.finish_reason === 'length') throw new AiError('response cut off (token limit)');
      return { data: JSON.parse(choice?.message.content ?? ''), model: res.model };
    } catch (err) {
      if (err instanceof OpenAI.AuthenticationError) throw new AiError('invalid API key');
      if (err instanceof OpenAI.RateLimitError) throw new AiError('rate limited or budget exhausted');
      if (err instanceof OpenAI.APIConnectionError) throw new AiError('cannot reach the AI API (network)');
      if (err instanceof OpenAI.APIError) throw new AiError(`API error ${err.status ?? ''}`.trim());
      throw err;
    }
  }
  if (provider === 'anthropic') {
    anthropic ??= new Anthropic();
    try {
      const res = await anthropic.beta.messages.create({
        model: aiModel()!,
        max_tokens: Math.max(opts.maxTokens, 2000),
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema: opts.schema } },
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
      });
      if (res.stop_reason === 'refusal') throw new AiError('model declined the request');
      const raw = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      return { data: JSON.parse(raw), model: res.model };
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new AiError('invalid API key');
      if (err instanceof Anthropic.RateLimitError) throw new AiError('rate limited');
      if (err instanceof Anthropic.APIConnectionError) throw new AiError('cannot reach the AI API (network)');
      if (err instanceof Anthropic.APIError) throw new AiError(`API error ${err.status}`);
      throw err;
    }
  }
  throw new AiError('no AI provider configured');
}

function reasonOf(err: unknown): string {
  if (err instanceof AiError) return err.message;
  if (err instanceof SyntaxError || err instanceof z.ZodError) return 'invalid JSON from model';
  return err instanceof Error ? err.message : 'unknown error';
}

// ---------------------------------------------------------------------------
// 1. Extraction
// ---------------------------------------------------------------------------

const ItemSchema = z.object({
  key: z.string(),
  value: z.string(),
  importance: z.enum(['low', 'medium', 'high']),
  quote: z.string(),
  confidence: z.number(),
});
const ExtractionOutput = z.object({ items: z.array(ItemSchema) });

const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value', 'importance', 'quote', 'confidence'],
        properties: {
          key: { type: 'string', enum: PREF_KEYS },
          value: { type: 'string', description: 'number for budget_max / max_hike_hours, HH:MM for return_by, "true"/"false" otherwise' },
          importance: { type: 'string', enum: ['low', 'medium', 'high'] },
          quote: { type: 'string', description: 'exact, verbatim span copied from the owner text that supports the item' },
          confidence: { type: 'number', description: '0..1' },
        },
      },
    },
  },
};

const KEY_GUIDE = PREF_KEYS.map((k) => `- ${k} (${PREF_META[k].kind}): ${PREF_META[k].label}`).join('\n');

const EXTRACTION_SYSTEM = `You build the profile of a person's digital twin for weekend-trip planning with friends.
From the owner's own Greek text, extract only preferences and hard constraints that the text clearly supports.

Allowed keys:
${KEY_GUIDE}

Rules:
- A constraint is something the person says they cannot or will not accept (a money limit, a time they must be back, never sleeping in a tent, must have a private bathroom). Everything else is a preference.
- likes_hiking / likes_sea: "true" if they seek it, "false" if they avoid it.
- prefers_low_cost only if they want to spend less; willingness to pay more is NOT prefers_low_cost.
- Quote the exact words from the text (verbatim, same accents), as short as possible while still supporting the item.
- If the text does not support any allowed key, return an empty list. Never infer values the text does not state, and never invent numbers or times.
- Confidence reflects how explicit the text is (explicit statement ~0.9, implied by a past decision ~0.6).`;

const IMPORTANCE = { low: 0.3, medium: 0.6, high: 0.9 } as const;

export interface ExtractionResult {
  mode: 'live' | 'demo' | 'demo-fallback';
  model?: string;
  candidates: ExtractionCandidate[];
  note?: string;
}

export async function extractCandidates(text: string): Promise<ExtractionResult> {
  if (!liveAiEnabled()) return { mode: 'demo', candidates: extractWithRules(text) };
  try {
    const { data, model } = await completeJSON({
      name: 'twin_profile_items',
      system: EXTRACTION_SYSTEM,
      user: `Owner text:\n"""\n${text}\n"""`,
      schema: EXTRACTION_SCHEMA,
      maxTokens: 1500,
    });
    const parsed = ExtractionOutput.parse(data);
    const candidates: ExtractionCandidate[] = [];
    for (const item of parsed.items) {
      if (!isPrefKey(item.key)) continue;
      const value = coerceValue(item.key, item.value);
      if (value === null) continue;
      candidates.push({
        key: item.key,
        value,
        weight: PREF_META[item.key].kind === 'constraint' ? 1 : IMPORTANCE[item.importance],
        quote: item.quote.trim(),
        confidence: Math.max(0, Math.min(1, item.confidence)),
      });
    }
    return { mode: 'live', model, candidates };
  } catch (err) {
    const reason = reasonOf(err);
    console.warn(`[ai] live extraction failed (${reason}); using rule extractor`);
    return { mode: 'demo-fallback', candidates: extractWithRules(text), note: `Live AI απέτυχε (${reason}) — χρησιμοποιήθηκαν κανόνες.` };
  }
}

// ---------------------------------------------------------------------------
// 2. Group messages in each owner's writing style
// ---------------------------------------------------------------------------

export interface StyleBrief {
  ownerId: string;
  name: string;
  /** The owner's own past writing (synthetic sources): the style reference. */
  samples: { sourceId: string; text: string }[];
  /** Everything the message is allowed to state. */
  facts: string[];
}

const MESSAGES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['messages'],
  properties: {
    messages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ownerId', 'text'],
        properties: { ownerId: { type: 'string' }, text: { type: 'string' } },
      },
    },
  },
};
const MessagesOutput = z.object({ messages: z.array(z.object({ ownerId: z.string(), text: z.string() })) });

const MESSAGES_SYSTEM = `You write the message each friend's digital twin proposes to post in the friends' Greek group chat about this weekend's plan.
The goal is that the friends could not tell the twin from the real person. Style matters more than completeness.

How to sound like the person (learn it only from their WRITING SAMPLES):
- Same register as a casual chat between friends, never like a report or an announcement.
- Reuse their typical words, openings, rhythm, sentence length and punctuation; mirror how direct, enthusiastic or grumpy they are.
- Do not copy whole sample sentences. Do not mention "Twin", "AI", "proposal awaiting approval" or "constraints".

Content rules (hard):
- Greek, first person, 1–2 short sentences, max 200 characters. Emoji only if the samples use emoji.
- Pick only the 1–2 FACTS that matter most to this person; never list everything.
- State nothing that is not in that person's FACTS: no new prices, times, places, activities, promises or plans. Every number you write must appear in the facts.
- If there is no feasible option, say it in their way and, if a fact gives it, the one change that would unblock it (only the closest one).
- The three messages must sound clearly different from each other, because the three people write differently.`;

export interface DraftResult {
  mode: 'live' | 'demo-fallback';
  model?: string;
  texts: Record<string, string>;
  note?: string;
}

export async function draftGroupMessages(briefs: StyleBrief[]): Promise<DraftResult> {
  const user = briefs
    .map(
      (b) =>
        `## ownerId: ${b.ownerId} (${b.name})\nWRITING SAMPLES:\n${b.samples.map((s) => `- ${s.text}`).join('\n')}\nFACTS:\n${b.facts.map((f) => `- ${f}`).join('\n')}`,
    )
    .join('\n\n');
  try {
    const { data, model } = await completeJSON({
      name: 'twin_group_messages',
      system: MESSAGES_SYSTEM,
      user: `Write one draft per person.\n\n${user}`,
      schema: MESSAGES_SCHEMA,
      maxTokens: 2500,
    });
    const parsed = MessagesOutput.parse(data);
    const texts: Record<string, string> = {};
    for (const m of parsed.messages) if (briefs.some((b) => b.ownerId === m.ownerId)) texts[m.ownerId] = m.text.trim().slice(0, 300);
    return { mode: 'live', model, texts };
  } catch (err) {
    const reason = reasonOf(err);
    console.warn(`[ai] group messages failed (${reason}); using templates`);
    return { mode: 'demo-fallback', texts: {}, note: `Live AI απέτυχε (${reason}) — χρησιμοποιήθηκαν πρότυπα.` };
  }
}
