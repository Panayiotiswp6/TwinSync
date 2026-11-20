// Builds a twin from the in-app interview (shared/onboarding.ts):
//   1. each section's questions + answers are stored verbatim as a source (provenance),
//   2. clear-cut answers (amounts with context, deadlines, chips) become memory in code,
//   3. free-text answers are analysed by the AI (rules in demo mode) — quotes must be exact,
//   4. DM replies (+ pasted real messages) become the style reference,
//   5. optional real past choices become held-out tests (never shown to the twin).
// Everything comes from the owner's own answers, so it is stored as confirmed and stays editable.

import { extractWithRules, type MemoryDraft } from '../shared/heuristics';
import { answerText, freeText, sectionText, SECTIONS, structuredDrafts, type OnboardBody } from '../shared/onboarding';
import { containsQuote } from '../shared/text';
import type { HeldOutCase } from '../shared/types';
import { aiErrorReason, analyzeSource, liveAi } from './ai';
import type { Emit } from './jobs';
import { refreshStyle } from './pipeline';
import { store } from './store';

export async function onboard(body: OnboardBody, emit: Emit) {
  const a = body.answers;
  const bio = answerText(SECTIONS[0].questions.find((q) => q.id === 'me_friend')!, a.me_friend).slice(0, 200);
  const persona = store.addPersona(body.name.trim(), bio, body.emoji || '✨');
  const age = Number(String(a.me_age ?? '').match(/\d{1,3}/)?.[0]);
  if (age >= 10 && age <= 110) store.updatePersona(persona.id, { age });
  emit({ who: persona.id, kind: 'join', text: `Γεια! Είμαι το Twin ${persona.name} — μαθαίνω από τις απαντήσεις σου.` });

  // 1. Sources, one per section, with the exact Q/A lines.
  const structured = structuredDrafts(a);
  const jobs: { title: string; sourceId: string; free: string }[] = [];
  let created = 0;
  for (const s of SECTIONS) {
    const text = sectionText(s, a);
    if (!text) continue;
    const src = store.addSource(persona.id, 'note', `Συνέντευξη · ${s.title}`, text);
    src.analyzed = true;
    // 2. Clear-cut answers: memory in code, with context and strictness.
    const mine = structured.filter((d) => containsQuote(text, d.quote));
    if (mine.length) {
      created += store.addMemory(persona.id, src, mine, { origin: 'owner', status: 'confirmed', scope: 'profile' }).created.length;
    }
    const free = freeText(s, a);
    if (free) jobs.push({ title: `${s.title}`, sourceId: src.id, free });
  }
  emit({ who: persona.id, kind: 'think', text: `Κράτησα ${created} ξεκάθαρες απαντήσεις (ποσά με το πλαίσιό τους, όρια, προτιμήσεις).` });

  // 4. Style reference: only the owner's own messages.
  const replies = SECTIONS.find((s) => s.id === 'voice')!.questions.filter((q) => q.type === 'dm').map((q) => answerText(q, a[q.id])).filter(Boolean);
  const pasted = answerText(SECTIONS.find((s) => s.id === 'voice')!.questions.find((q) => q.id === 'voice_paste')!, a.voice_paste);
  if (replies.length) store.addSource(persona.id, 'chat', 'Απαντήσεις στο chat της παρέας', replies.join('\n')).analyzed = true;
  if (pasted) {
    const src = store.addSource(persona.id, 'chat', 'Πραγματικά μηνύματα (επικόλληση)', pasted);
    jobs.push({ title: 'Πραγματικά μηνύματα', sourceId: src.id, free: pasted });
  }

  // 3. Free text -> AI (three sections at a time).
  const notes: string[] = [];
  const live = liveAi();
  for (let i = 0; i < jobs.length; i += 3) {
    await Promise.all(
      jobs.slice(i, i + 3).map(async (j) => {
        const src = store.source(j.sourceId)!;
        let drafts: MemoryDraft[] = [];
        if (live) {
          try {
            drafts = (await analyzeSource(persona, `Συνέντευξη: ${j.title}`, j.free)).drafts;
          } catch (e) {
            notes.push(`${j.title}: ${aiErrorReason(e)} — κανόνες`);
            drafts = extractWithRules(j.free);
          }
        } else {
          drafts = extractWithRules(j.free);
        }
        const r = store.addMemory(persona.id, src, drafts, { origin: live ? 'ai' : 'rules', status: 'confirmed', scope: 'profile' });
        src.analyzed = true;
        created += r.created.length;
        const sample = r.created.find((m) => m.domain !== 'style');
        emit({ who: persona.id, kind: 'think', text: `${j.title}: ${r.created.length} αναμνήσεις${sample ? ` — π.χ. «${sample.statement}»` : ''}` });
      }),
    );
  }

  let styleNote: string | undefined;
  try {
    const st = await refreshStyle(persona.id);
    emit({ who: persona.id, kind: 'think', text: `Το ύφος μου: ${st.style.summary}` });
  } catch (e) {
    styleNote = `Ύφος: ${aiErrorReason(e)}`;
  }

  // 5. Held-out tests.
  const cases: HeldOutCase[] = body.holdouts
    .filter((h) => h.question.trim() && h.options.filter((o) => o.title.trim()).length >= 2 && h.options[h.chosen]?.title.trim())
    .slice(0, 3)
    .map((h, i) => {
      const opts = h.options.filter((o) => o.title.trim());
      const chosenTitle = h.options[h.chosen].title.trim();
      return {
        id: `imp-${persona.id}-${i + 1}`,
        personaId: persona.id,
        question: h.question.trim().slice(0, 200),
        category: 'other',
        actualOptionId: `o${opts.findIndex((o) => o.title.trim() === chosenTitle) + 1}`,
        note: h.why.trim().slice(0, 300),
        origin: 'imported',
        options: opts.map((o, k) => ({
          id: `o${k + 1}`,
          title: o.title.trim().slice(0, 100),
          emoji: '',
          summary: '',
          location: '',
          costPerPerson: typeof o.cost === 'number' && o.cost >= 0 ? o.cost : null,
          costNote: '',
          startsAt: null,
          endsAt: null,
          features: o.title.trim().split(/[,·]/).map((f) => f.trim()).filter(Boolean).slice(0, 6),
          origin: 'catalog',
        })),
      };
    });
  if (cases.length) store.setHoldouts(persona.id, cases);

  store.save();
  emit({ who: persona.id, kind: 'say', text: `Έτοιμος/η! ${created} αναμνήσεις από τις απαντήσεις σου${cases.length ? ` και ${cases.length} κρυφά τεστ` : ''}. Δες το προφίλ μου και διόρθωσέ με όπου χρειάζεται.` });
  return { personaId: persona.id, memories: String(created), notes: [...notes, ...(styleNote ? [styleNote] : [])].join(' · ') };
}
