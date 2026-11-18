// Drafts each twin's group-chat message for a decision, in its owner's style.
// Live model output is kept only if it passes the grounding guard; otherwise the
// owner sees a template plus the reason. Drafts are cached on the decision (cost)
// and are never "sent": each owner approves their own draft.

import { draftGroupMessages, aiModel, liveAiEnabled } from './ai';
import { store } from './store';
import { messageFacts, styleSamples, templateMessage, ungroundedReason } from '../shared/messages';
import type { Decision, TwinMessage } from '../shared/types';

export async function generateGroupMessages(decisionId: string, regenerate = false): Promise<Decision> {
  const d = store.decisions.find((x) => x.id === decisionId);
  if (!d) throw new Error('not found');
  if (d.messages && !regenerate) return d;

  const owners = store.owners.filter((o) => d.request.participants.includes(o.id));
  const briefs = owners.map((o) => ({
    ownerId: o.id,
    name: o.name,
    samples: styleSamples(store.sources, o.id).map((s) => ({ sourceId: s.id, text: s.text })),
    facts: messageFacts(d, o.id, store.trips, store.owners),
  }));

  let texts: Record<string, string> = {};
  let model: string | undefined;
  let note: string | undefined;
  if (liveAiEnabled()) {
    const r = await draftGroupMessages(briefs);
    texts = r.texts;
    model = r.model ?? aiModel() ?? undefined;
    note = r.note;
  } else {
    note = 'Demo mode: τα μηνύματα βγαίνουν από πρότυπα, χωρίς μίμηση ύφους. Με OPENAI_API_KEY τα γράφει το AI με το ύφος κάθε κατόχου.';
  }

  d.messages = briefs.map((b): TwinMessage => {
    const base = { ownerId: b.ownerId, styleSourceIds: b.samples.map((s) => s.sourceId), facts: b.facts, status: 'draft' as const };
    const live = texts[b.ownerId];
    if (live) {
      const problem = ungroundedReason(live, b.facts, store.trips);
      if (!problem) return { ...base, text: live, mode: 'live', model };
      return { ...base, text: templateMessage(d, b.ownerId, store.trips), mode: 'template', guardNote: `Το AI ${problem} — απορρίφθηκε και μπήκε πρότυπο.` };
    }
    return { ...base, text: templateMessage(d, b.ownerId, store.trips), mode: 'template' };
  });
  d.messagesNote = note;
  return d;
}

export function approveGroupMessage(decisionId: string, ownerId: string, text?: string): Decision {
  const d = store.decisions.find((x) => x.id === decisionId);
  const m = d?.messages?.find((x) => x.ownerId === ownerId);
  if (!d || !m) throw new Error('not found');
  if (text !== undefined && text.trim() && text.trim() !== m.text) m.text = text.trim().slice(0, 300);
  m.status = 'approved';
  return d;
}
