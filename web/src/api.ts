import type { Decision, Owner, Preference, Source, TripOption, TripRequest } from '../../shared/types';
import type { EvalReport } from '../../server/evaluation';

export interface AppState {
  status: { aiMode: 'live' | 'demo'; provider: 'openai' | 'anthropic' | 'demo'; model: string | null; dataset: 'synthetic' };
  owners: Owner[];
  sources: Source[];
  preferences: Preference[];
  trips: TripOption[];
  request: TripRequest;
  decisions: Decision[];
  samples: Record<string, string>;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  state: () => call<AppState>('GET', '/api/state'),
  reset: () => call<AppState>('POST', '/api/reset'),
  ingest: (ownerId: string, text: string, title?: string) =>
    call<{ candidates: Preference[]; unmapped: { label: string; quote: string }[]; mode: string; model?: string; note?: string; dropped: number; state: AppState }>('POST', `/api/twins/${ownerId}/ingest`, { text, title }),
  confirm: (id: string, value?: unknown, weight?: number) => call<AppState>('POST', `/api/preferences/${id}/confirm`, { value, weight }),
  reject: (id: string) => call<AppState>('POST', `/api/preferences/${id}/reject`),
  plan: (text: string, participants: string[]) => call<{ decision: Decision; state: AppState }>('POST', '/api/plan', { text, participants }),
  correct: (body: { ownerId: string; key: string; value: unknown; scope: 'trip' | 'profile'; weight?: number }) =>
    call<{ decision: Decision; state: AppState }>('POST', '/api/corrections', body),
  removeOverride: (id: string) => call<{ decision: Decision; state: AppState }>('DELETE', `/api/overrides/${id}`),
  approve: (decisionId: string, ownerId: string, approve: boolean) => call<AppState>('POST', `/api/decisions/${decisionId}/approval`, { ownerId, approve }),
  evaluation: () => call<EvalReport>('GET', '/api/eval'),
  messages: (decisionId: string, regenerate = false) => call<AppState>('POST', `/api/decisions/${decisionId}/messages${regenerate ? '?regenerate=1' : ''}`),
  approveMessage: (decisionId: string, ownerId: string, text?: string) => call<AppState>('POST', `/api/decisions/${decisionId}/messages/${ownerId}/approve`, { text }),
};
