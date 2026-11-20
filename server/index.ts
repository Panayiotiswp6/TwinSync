import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { aiModel, aiProvider, embeddingsEnabled } from './ai';
import { evaluationReport, holdoutLive } from './evaluation';
import { getJob, startJob } from './jobs';
import { onboard } from './onboarding';
import { privateChat } from './privateChat';
import { addWish, analyzeAndStore, approveMessage, createRequest, groupMessages, importPackage, learnFromDecision, refreshStyle, relaxLimit, removeItemAndRerun, runDecision, setLimit } from './pipeline';
import { hasTeamSeed, parseFrontMatter } from './seed';
import { DATA_DIR, store } from './store';

const app = express();
app.use(express.json({ limit: '4mb' }));

const status = () => ({
  aiMode: aiProvider() === 'demo' ? ('demo' as const) : ('live' as const),
  provider: aiProvider(),
  model: aiModel(),
  embeddings: embeddingsEnabled(),
  dataset: 'synthetic' as const,
  usage: store.usage,
  teamSeed: hasTeamSeed(),
});

const snapshot = () => ({
  status: status(),
  personas: store.personas,
  sources: store.sources,
  memory: store.memory.filter((m) => m.status !== 'rejected'),
  requests: store.requests,
  decisions: store.decisions,
});

const wrap =
  (fn: (req: Request, res: Response) => unknown | Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

app.get('/api/health', (_req, res) => res.json({ ok: true, ...status() }));
app.get('/api/state', (_req, res) => res.json(snapshot()));

// ---- Personas & permanent memory ----
app.post(
  '/api/personas',
  wrap((req, res) => {
    const b = z.object({ name: z.string().trim().min(2).max(40), bio: z.string().max(200).default(''), emoji: z.string().max(4).optional() }).parse(req.body);
    const p = store.addPersona(b.name, b.bio, b.emoji);
    res.json({ persona: p, state: snapshot() });
  }),
);

const SourceBody = z.object({
  title: z.string().trim().max(120).default(''),
  text: z.string().trim().min(5).max(200_000),
  kind: z.enum(['document', 'note', 'chat', 'email', 'past_decision']).default('document'),
  fileName: z.string().max(200).optional(),
});
app.post(
  '/api/personas/:id/sources',
  wrap(async (req, res) => {
    if (!store.persona(req.params.id)) return res.status(404).json({ error: 'Άγνωστο Twin' });
    const b = SourceBody.parse(req.body);
    // Files from the onboarding interview carry front-matter (title / kind / date): honour it.
    const { meta, body } = parseFrontMatter(b.text.replace(/\r\n/g, '\n'));
    const kind = SourceBody.shape.kind.safeParse(meta.kind).success ? (meta.kind as typeof b.kind) : b.kind;
    if (body.length < 5) return res.status(400).json({ error: 'Το αρχείο δεν έχει κείμενο.' });
    const src = store.addSource(req.params.id, kind, meta.title || b.title || b.fileName || 'Νέα πηγή', body, b.fileName, meta.date);
    const r = await analyzeAndStore(src.id);
    res.json({ ...r, state: snapshot() });
  }),
);
app.post(
  '/api/sources/:id/analyze',
  wrap(async (req, res) => {
    const r = await analyzeAndStore(req.params.id);
    res.json({ ...r, state: snapshot() });
  }),
);
app.delete(
  '/api/personas/:id',
  wrap((req, res) => {
    if (store.persona(req.params.id)?.locked) return res.status(403).json({ error: `Το Twin «${store.persona(req.params.id)!.name}» είναι μέλος της ομάδας του demo και δεν διαγράφεται.` });
    const removed = store.deletePersona(req.params.id);
    res.json({ removed, state: snapshot() });
  }),
);
app.delete('/api/sources/:id', (req, res) => {
  store.deleteSource(req.params.id);
  res.json(snapshot());
});

app.post(
  '/api/memory/:id',
  wrap((req, res) => {
    const b = z
      .object({ statement: z.string().trim().min(2).max(200).optional(), status: z.enum(['confirmed', 'rejected', 'candidate']).optional(), hard: z.boolean().optional(), strength: z.number().min(0).max(1).optional() })
      .parse(req.body);
    store.updateMemory(req.params.id, b);
    res.json(snapshot());
  }),
);
app.post('/api/personas/:id/confirm-all', (req, res) => {
  store.confirmAll(req.params.id);
  res.json(snapshot());
});
app.post(
  '/api/personas/:id/style',
  wrap(async (req, res) => {
    const r = await refreshStyle(req.params.id);
    res.json({ ...r, state: snapshot() });
  }),
);

// ---- Questionnaire ZIP import (unzipped in the browser) ----
const num = z.preprocess((v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(',', '.').replace(/[^\d.]/g, ''));
    return v.trim() && Number.isFinite(n) ? n : null;
  }
  return null;
}, z.number().nullable());
const HoldoutCase = z.object({
  question: z.coerce.string().max(300),
  category: z.coerce.string().max(30).catch('other'),
  options: z
    .array(
      z.object({
        id: z.coerce.string().max(20),
        title: z.coerce.string().max(200),
        costPerPerson: num.catch(null),
        features: z.array(z.coerce.string().max(120)).max(10).catch([]),
        endsAt: z.string().nullable().catch(null),
      }),
    )
    .max(5),
  actualOptionId: z.coerce.string().max(20),
  note: z.coerce.string().max(500).catch(''),
});
const ImportBody = z.object({
  persona: z.object({ name: z.string().trim().min(2).max(60), handle: z.string().trim().min(2).max(40), emoji: z.string().max(8).optional().catch(undefined), bio: z.string().max(300).optional().catch(undefined) }),
  files: z.array(z.object({ name: z.string().max(200), text: z.string().max(200_000) })).min(1).max(30),
  holdout: z.unknown().optional(),
});
/** Keep only well-formed held-out cases; a malformed case is skipped, never the whole import. */
function parseHoldout(raw: unknown): { cases: z.infer<typeof HoldoutCase>[] } | undefined {
  const cases = (raw as { cases?: unknown })?.cases;
  if (!Array.isArray(cases)) return undefined;
  return { cases: cases.slice(0, 10).flatMap((c) => { const r = HoldoutCase.safeParse(c); return r.success ? [r.data] : []; }) };
}
app.post(
  '/api/import',
  wrap(async (req, res) => {
    const body = ImportBody.parse(req.body);
    const r = await importPackage({ ...body, holdout: parseHoldout(body.holdout) });
    res.json({ ...r, state: snapshot() });
  }),
);

// ---- Group requests ----
app.post(
  '/api/requests',
  wrap(async (req, res) => {
    const b = z
      .object({
        text: z.string().trim().min(3).max(1000),
        participants: z.array(z.string()).min(2),
        wishes: z.record(z.string(), z.string().max(1000)).default({}),
        city: z.string().trim().max(40).optional(),
        cityAssumed: z.boolean().optional(),
      })
      .parse(req.body);
    const form = { city: b.city, cityAssumed: b.cityAssumed };
    const participants = b.participants.filter((id) => store.persona(id));
    if (participants.length < 2) return res.status(400).json({ error: 'Χρειάζονται τουλάχιστον δύο Twins' });
    if (req.query.async === '1') {
      // Long AI run: return a job id at once; the browser shows the twins' chat while it works.
      const job = startJob('request', async (emit) => {
        const r = await createRequest(b.text, participants, b.wishes, emit, form);
        return { requestId: r.request.id, decisionId: r.decision.id };
      });
      return res.json({ jobId: job.id });
    }
    const r = await createRequest(b.text, participants, b.wishes, undefined, form);
    res.json({ requestId: r.request.id, decisionId: r.decision.id, state: snapshot() });
  }),
);
app.get('/api/jobs/:id', (req, res) => {
  const j = getJob(req.params.id, Number(req.query.since) || 0);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json(j.status === 'done' ? { ...j, state: snapshot() } : j);
});

// ---- Private chat with one twin (nothing is stored) ----
app.post(
  '/api/personas/:id/chat',
  wrap(async (req, res) => {
    const b = z.object({ turns: z.array(z.object({ role: z.enum(['user', 'twin']), text: z.string().trim().min(1).max(500) })).min(1).max(30) }).parse(req.body);
    if (b.turns.at(-1)!.role !== 'user') return res.status(400).json({ error: 'Το τελευταίο μήνυμα πρέπει να είναι του χρήστη.' });
    res.json(await privateChat(req.params.id, b.turns));
  }),
);

// ---- In-app onboarding interview -> new twin ----
const Money = z.object({ amount: z.number().nullable(), strict: z.boolean() });
const Deadline = z.object({ day: z.number().int().min(0).max(6).nullable(), time: z.string().max(5), strict: z.boolean() });
const Ranked = z.object({ items: z.array(z.object({ place: z.string().max(80), why: z.string().max(300) })).max(15) });
const OnboardBody = z.object({
  name: z.string().trim().min(2).max(40),
  emoji: z.string().max(8).default('✨'),
  answers: z.record(z.string().max(40), z.union([z.string().max(4000), z.array(z.string().max(80)).max(12), Money, Deadline, Ranked])),
  holdouts: z
    .array(z.object({ question: z.string().max(200), options: z.array(z.object({ title: z.string().max(100), cost: z.number().nullable() })).max(4), chosen: z.number().int().min(0).max(3), why: z.string().max(300).default('') }))
    .max(3)
    .default([]),
});
app.post(
  '/api/onboard',
  wrap((req, res) => {
    const body = OnboardBody.parse(req.body);
    const job = startJob('onboard', (emit) => onboard(body, emit));
    res.json({ jobId: job.id });
  }),
);
app.post(
  '/api/requests/:id/wishes',
  wrap(async (req, res) => {
    const b = z.object({ personaId: z.string(), text: z.string().trim().min(3).max(1000), scope: z.enum(['request', 'profile']), regenerate: z.boolean().default(false) }).parse(req.body);
    const r = await addWish(req.params.id, b.personaId, b.text, b.scope, b.regenerate);
    res.json({ decisionId: r.decision.id, created: r.created.length, state: snapshot() });
  }),
);
app.post(
  '/api/requests/:id/limit',
  wrap(async (req, res) => {
    const b = z.object({ personaId: z.string(), value: z.number().positive().max(100000) }).parse(req.body);
    const d = await setLimit(req.params.id, b.personaId, 'max_cost', Math.round(b.value));
    res.json({ decisionId: d.id, state: snapshot() });
  }),
);
app.post(
  '/api/requests/:id/relax',
  wrap(async (req, res) => {
    const b = z.object({ memoryId: z.string(), optionId: z.string() }).parse(req.body);
    const d = await relaxLimit(req.params.id, b.memoryId, b.optionId);
    res.json({ decisionId: d.id, state: snapshot() });
  }),
);
app.delete(
  '/api/requests/:id/items/:memoryId',
  wrap(async (req, res) => {
    const d = await removeItemAndRerun(req.params.id, req.params.memoryId);
    res.json({ decisionId: d.id, state: snapshot() });
  }),
);
app.post(
  '/api/requests/:id/rerun',
  wrap(async (req, res) => {
    const b = z.object({ regenerateOptions: z.boolean().default(false) }).parse(req.body ?? {});
    if (!store.request(req.params.id)) return res.status(404).json({ error: 'not found' });
    if (req.query.async === '1') {
      const job = startJob('request', async (emit) => {
        const d = await runDecision(req.params.id, { ...b, emit });
        return { requestId: d.requestId, decisionId: d.id };
      });
      return res.json({ jobId: job.id });
    }
    const d = await runDecision(req.params.id, b);
    res.json({ decisionId: d.id, state: snapshot() });
  }),
);

// ---- Decisions ----
app.post(
  '/api/decisions/:id/approval',
  wrap((req, res) => {
    const b = z.object({ personaId: z.string(), approve: z.boolean() }).parse(req.body);
    store.approve(req.params.id, b.personaId, b.approve ? 'approved' : 'rejected');
    // Learning loop: what the owner approved becomes one of their past decisions (in the background).
    if (b.approve) learnFromDecision(req.params.id, b.personaId).catch((e) => console.warn('[learn]', (e as Error).message));
    res.json(snapshot());
  }),
);
app.post(
  '/api/decisions/:id/messages',
  wrap(async (req, res) => {
    await groupMessages(req.params.id, req.query.regenerate === '1');
    res.json(snapshot());
  }),
);
app.post(
  '/api/decisions/:id/messages/:personaId/approve',
  wrap((req, res) => {
    approveMessage(req.params.id, req.params.personaId, z.object({ text: z.string().max(300).optional() }).parse(req.body ?? {}).text);
    res.json(snapshot());
  }),
);

// ---- Evaluation & reset ----
app.get('/api/eval', (_req, res) => res.json(evaluationReport()));
app.post(
  '/api/eval/live',
  wrap(async (_req, res) => {
    const live = await holdoutLive();
    res.json({ ...evaluationReport(), live });
  }),
);
app.post('/api/reset', (req, res) => {
  // ?empty=1: no twins · ?seed=team: the team's own group (if committed) · otherwise the synthetic group.
  store.reset(req.query.empty === '1' ? 'empty' : req.query.seed === 'team' ? 'team' : 'synthetic');
  res.json(snapshot());
});
// The twins as a file, to commit as server/data/team/group.json (the team demo group).
app.get('/api/export', (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="group.json"');
  res.json(store.exportGroup());
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) return res.status(400).json({ error: 'Μη έγκυρο αίτημα', details: err.issues });
  const msg = err instanceof Error ? err.message : 'Σφάλμα';
  console.error('[api]', msg);
  res.status(msg === 'not found' ? 404 : 500).json({ error: msg });
});

// Static frontend (production build).
const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = [path.resolve(here, '../web'), path.resolve(here, '../dist/web')].find((d) => existsSync(path.join(d, 'index.html')));
if (webDir) {
  app.use(express.static(webDir));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
}

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  const s = status();
  console.log(
    `TwinSync on http://localhost:${port} — AI: ${s.aiMode === 'live' ? `${s.provider} (${s.model})${s.embeddings ? ' + embeddings' : ''}` : 'demo mode (no OPENAI_API_KEY / ANTHROPIC_API_KEY: rules, catalog, templates)'} — data: ${DATA_DIR}`,
  );
});
