// Live AI extraction (Claude) of candidate preferences/constraints from an owner's text.
// The API key stays server-side (ANTHROPIC_API_KEY). Without a key the app runs in
// clearly-labelled demo mode and uses the deterministic rule extractor instead.
// The model only proposes candidates; the owner confirms them and the decision
// itself is always computed in code (shared/engine.ts).

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { extractWithRules } from '../shared/extractRules';
import { PREF_KEYS, PREF_META, coerceValue, isPrefKey } from '../shared/prefs';
import type { ExtractionCandidate } from '../shared/types';

export const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
export const liveAiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client: Anthropic | null = null;
function getClient() {
  client ??= new Anthropic();
  return client;
}

const ItemSchema = z.object({
  key: z.string(),
  value: z.string(),
  importance: z.enum(['low', 'medium', 'high']),
  quote: z.string(),
  confidence: z.number(),
});
const OutputSchema = z.object({ items: z.array(ItemSchema) });

const JSON_SCHEMA = {
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
} as const;

const KEY_GUIDE = PREF_KEYS.map((k) => `- ${k} (${PREF_META[k].kind}): ${PREF_META[k].label}`).join('\n');

const SYSTEM = `You build the profile of a person's digital twin for weekend-trip planning with friends.
From the owner's own Greek text, extract only preferences and hard constraints that the text clearly supports.

Allowed keys:
${KEY_GUIDE}

Rules:
- A constraint is something the person says they cannot or will not accept (a money limit, a time they must be back, never sleeping in a tent, must have a private bathroom). Everything else is a preference.
- likes_hiking / likes_sea: "true" if they seek it, "false" if they avoid it.
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
    const response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: JSON_SCHEMA as unknown as Record<string, unknown> } },
      system: SYSTEM,
      messages: [{ role: 'user', content: `Owner text:\n"""\n${text}\n"""` }],
    });
    if (response.stop_reason === 'refusal') throw new Error('model declined the request');
    const raw = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    const parsed = OutputSchema.parse(JSON.parse(raw));
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
    return { mode: 'live', model: response.model, candidates };
  } catch (err) {
    const reason =
      err instanceof Anthropic.AuthenticationError
        ? 'invalid API key'
        : err instanceof Anthropic.RateLimitError
          ? 'rate limited'
          : err instanceof Anthropic.APIError
            ? `API error ${err.status}`
            : err instanceof Error
              ? err.message
              : 'unknown error';
    console.warn(`[ai] live extraction failed (${reason}); using rule extractor`);
    return { mode: 'demo-fallback', candidates: extractWithRules(text), note: `Live AI απέτυχε (${reason}) — χρησιμοποιήθηκαν κανόνες.` };
  }
}
