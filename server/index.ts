import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { aiModel, aiProvider, extractCandidates } from './ai';
import { approveGroupMessage, generateGroupMessages } from './groupMessages';
import { runEvaluation } from './evaluation';
import { store } from './store';
import { PREF_KEYS, coerceValue, isPrefKey } from '../shared/prefs';

const app = express();
app.use(express.json({ limit: '64kb' }));

const status = () => ({
  aiMode: aiProvider() === 'demo' ? 'demo' : 'live',
  provider: aiProvider(),
  model: aiModel(),
  dataset: 'synthetic',
});

const snapshot = () => ({
  status: status(),
  owners: store.owners,
  sources: store.sources,
  preferences: store.preferences,
  trips: store.trips,
  request: store.request,
  decisions: store.decisions.slice(-6),
  samples: store.samples,
});

const wrap =
  (fn: (req: Request, res: Response) => unknown | Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

app.get('/api/health', (_req, res) => res.json({ ok: true, ...status() }));
app.get('/api/state', (_req, res) => res.json(snapshot()));

// 1. Create / extend a twin from plain text.
const IngestBody = z.object({ text: z.string().trim().min(5).max(4000), title: z.string().trim().max(120).optional() });
app.post(
  '/api/twins/:ownerId/ingest',
  wrap(async (req, res) => {
    const owner = store.owner(req.params.ownerId);
    if (!owner) return res.status(404).json({ error: 'Άγνωστος κάτοχος' });
    const body = IngestBody.parse(req.body);
    const source = store.addSource(owner.id, 'owner_input', body.title || 'Νέα σημείωση κατόχου', body.text);
    const result = await extractCandidates(body.text);
    const created = store.addCandidates(owner.id, source, result.candidates, result.mode === 'live' ? 'ai' : 'rules');
    res.json({ source, candidates: created, unmapped: result.unmapped ?? [], mode: result.mode, model: result.model, note: result.note, dropped: result.candidates.length - created.length, state: snapshot() });
  }),
);

const ConfirmBody = z.object({ value: z.union([z.string(), z.number(), z.boolean()]).optional(), weight: z.number().min(0).max(1).optional() });
app.post(
  '/api/preferences/:id/confirm',
  wrap((req, res) => {
    const p = store.pref(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const body = ConfirmBody.parse(req.body ?? {});
    const value = body.value === undefined ? undefined : coerceValue(p.key, body.value);
    if (value === null) return res.status(400).json({ error: 'Μη έγκυρη τιμή' });
    store.confirm(p.id, value, body.weight);
    res.json(snapshot());
  }),
);
app.post(
  '/api/preferences/:id/reject',
  wrap((req, res) => {
    if (!store.pref(req.params.id)) return res.status(404).json({ error: 'not found' });
    store.reject(req.params.id);
    res.json(snapshot());
  }),
);

// 2–3. Run the plan: positions -> constraints -> shared proposal.
const PlanBody = z.object({ text: z.string().trim().min(3).max(1000), participants: z.array(z.string()).min(2) });
app.post(
  '/api/plan',
  wrap((req, res) => {
    const body = PlanBody.parse(req.body);
    const participants = body.participants.filter((id) => store.owner(id));
    if (participants.length < 2) return res.status(400).json({ error: 'Χρειάζονται τουλάχιστον δύο συμμετέχοντες' });
    store.applyRequest({ ...store.request, text: body.text, participants });
    const decision = store.plan();
    res.json({ decision, state: snapshot() });
  }),
);

// 4. Owner correction: trip-only or saved to profile, then re-run.
const CorrectionBody = z.object({
  ownerId: z.string(),
  key: z.enum(PREF_KEYS as [string, ...string[]]),
  value: z.union([z.string(), z.number(), z.boolean()]),
  scope: z.enum(['trip', 'profile']),
  weight: z.number().min(0).max(1).optional(),
});
app.post(
  '/api/corrections',
  wrap((req, res) => {
    const body = CorrectionBody.parse(req.body);
    if (!store.owner(body.ownerId) || !isPrefKey(body.key)) return res.status(400).json({ error: 'Μη έγκυρη διόρθωση' });
    const value = coerceValue(body.key, body.value);
    if (value === null) return res.status(400).json({ error: 'Μη έγκυρη τιμή' });
    const pref = store.correct(body.ownerId, body.key, value, body.scope, body.weight);
    const decision = store.plan();
    res.json({ pref, decision, state: snapshot() });
  }),
);
app.delete(
  '/api/overrides/:id',
  wrap((req, res) => {
    store.removeOverride(req.params.id);
    const decision = store.plan();
    res.json({ decision, state: snapshot() });
  }),
);

const ApproveBody = z.object({ ownerId: z.string(), approve: z.boolean() });
app.post(
  '/api/decisions/:id/approval',
  wrap((req, res) => {
    const body = ApproveBody.parse(req.body);
    store.approve(req.params.id, body.ownerId, body.approve);
    res.json(snapshot());
  }),
);

// Twins draft a group-chat message in their owner's style (cached per decision).
app.post(
  '/api/decisions/:id/messages',
  wrap(async (req, res) => {
    if (!store.decisions.some((d) => d.id === req.params.id)) return res.status(404).json({ error: 'not found' });
    await generateGroupMessages(req.params.id, req.query.regenerate === '1');
    res.json(snapshot());
  }),
);
const MessageApproveBody = z.object({ text: z.string().max(300).optional() });
app.post(
  '/api/decisions/:id/messages/:ownerId/approve',
  wrap((req, res) => {
    approveGroupMessage(req.params.id, req.params.ownerId, MessageApproveBody.parse(req.body ?? {}).text);
    res.json(snapshot());
  }),
);

app.post('/api/reset', (_req, res) => {
  store.reset();
  res.json(snapshot());
});

app.get('/api/eval', (_req, res) => {
  const profile = store.preferences.filter((p) => p.status === 'confirmed' && p.scope === 'profile');
  res.json(runEvaluation(profile));
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) return res.status(400).json({ error: 'Μη έγκυρο αίτημα', details: err.issues });
  const msg = err instanceof Error ? err.message : 'Σφάλμα';
  console.error('[api]', msg);
  res.status(500).json({ error: msg });
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
  console.log(`TwinSync on http://localhost:${port} — AI: ${s.aiMode === 'live' ? `${s.provider} (${s.model})` : 'demo mode (no OPENAI_API_KEY / ANTHROPIC_API_KEY set: rules and templates)'}`);
});
