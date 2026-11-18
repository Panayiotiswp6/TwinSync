// Type declarations written by the TwinSync team for the vendored OpenSelf schema.js (MIT).
export const MEMORY_TYPES: readonly string[];
export const SOURCE_TRUST_LEVELS: readonly ['untrusted', 'external', 'trusted', 'verified', 'owner'];
export interface OpenSelfMemory {
  id: string;
  type: string;
  content: string;
  summary: string;
  source: { kind: string; locator: string; title: string };
  scope: string;
  sensitivity: string;
  sourceTrust: 'untrusted' | 'external' | 'trusted' | 'verified' | 'owner';
  confidence: number;
  occurredAt?: string | null;
  tags: string[];
  contentHash: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}
export function normalizeMemory(input: Record<string, unknown>, now?: Date): OpenSelfMemory;
export function memoryContentHash(content: string): string;
