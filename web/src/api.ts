import type { Decision, GroupRequest, MemoryItem, Persona, Source, StyleCard, Usage } from '../../shared/types';

export interface AppStatus {
  aiMode: 'live' | 'demo';
  provider: 'openai' | 'anthropic' | 'demo';
  model: string | null;
  embeddings: boolean;
  dataset: 'synthetic';
  usage: Usage;
}

export interface AppState {
  status: AppStatus;
  personas: Persona[];
  sources: Source[];
  memory: MemoryItem[];
  requests: GroupRequest[];
  decisions: Decision[];
}

export interface AnalyzeResult {
  source: Source;
  created: MemoryItem[];
  dropped: number;
  mode: 'live' | 'demo' | 'demo-fallback';
  note?: string;
  model: string | null;
  state: AppState;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  state: () => call<AppState>('GET', '/api/state'),
  reset: () => call<AppState>('POST', '/api/reset'),
  createPersona: (name: string, bio: string, emoji?: string) => call<{ persona: Persona; state: AppState }>('POST', '/api/personas', { name, bio, emoji }),
  addSource: (personaId: string, body: { title: string; text: string; kind: string; fileName?: string }) => call<AnalyzeResult>('POST', `/api/personas/${personaId}/sources`, body),
  analyze: (sourceId: string) => call<AnalyzeResult>('POST', `/api/sources/${sourceId}/analyze`),
  deleteSource: (id: string) => call<AppState>('DELETE', `/api/sources/${id}`),
  updateMemory: (id: string, patch: Partial<Pick<MemoryItem, 'statement' | 'status' | 'hard' | 'strength'>>) => call<AppState>('POST', `/api/memory/${id}`, patch),
  confirmAll: (personaId: string) => call<AppState>('POST', `/api/personas/${personaId}/confirm-all`),
  refreshStyle: (personaId: string) => call<{ style: StyleCard; mode: string; state: AppState }>('POST', `/api/personas/${personaId}/style`),
  createRequest: (text: string, participants: string[], wishes: Record<string, string>) =>
    call<{ requestId: string; decisionId: string; state: AppState }>('POST', '/api/requests', { text, participants, wishes }),
  addWish: (requestId: string, personaId: string, text: string, scope: 'request' | 'profile') =>
    call<{ decisionId: string; created: number; state: AppState }>('POST', `/api/requests/${requestId}/wishes`, { personaId, text, scope }),
  setLimit: (requestId: string, personaId: string, value: number) => call<{ decisionId: string; state: AppState }>('POST', `/api/requests/${requestId}/limit`, { personaId, value }),
  removeItem: (requestId: string, memoryId: string) => call<{ decisionId: string; state: AppState }>('DELETE', `/api/requests/${requestId}/items/${memoryId}`),
  rerun: (requestId: string, regenerateOptions: boolean) => call<{ decisionId: string; state: AppState }>('POST', `/api/requests/${requestId}/rerun`, { regenerateOptions }),
  approve: (decisionId: string, personaId: string, approve: boolean) => call<AppState>('POST', `/api/decisions/${decisionId}/approval`, { personaId, approve }),
  messages: (decisionId: string, regenerate = false) => call<AppState>('POST', `/api/decisions/${decisionId}/messages${regenerate ? '?regenerate=1' : ''}`),
  approveMessage: (decisionId: string, personaId: string, text?: string) => call<AppState>('POST', `/api/decisions/${decisionId}/messages/${personaId}/approve`, { text }),
  evaluation: () => call<EvalReport>('GET', '/api/eval'),
  evaluationLive: () => call<EvalReport>('POST', '/api/eval/live'),
};

export interface HoldoutRow {
  id: string;
  personaId: string;
  question: string;
  predicted: string | null;
  actual: string;
  outcome: 'correct' | 'wrong' | 'uncertain';
  margin: number;
  note: string;
  why: string;
}
export interface HoldoutReport {
  method: 'heuristic' | 'live';
  model: string | null;
  ranAt: string;
  rows: HoldoutRow[];
  correct: number;
  wrong: number;
  uncertain: number;
  total: number;
  error?: string;
}
export interface EvalReport {
  dataset: 'synthetic';
  heuristic: HoldoutReport;
  live: HoldoutReport | null;
  scenarios: { name: string; pass: boolean; detail: string }[];
  integrity: { personas: number; sources: number; memoryItems: number; verifiedQuotes: number };
  measures: string[];
}
