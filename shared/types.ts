// TwinSync v2 domain model — shared by server, decision logic, evaluation and UI.
// Generic: any group wish (trip, dinner, night out, gift…), not only trips.

export type PersonaId = string;

export type Category = 'trip' | 'food' | 'entertainment' | 'activity' | 'gift' | 'other';
export const CATEGORIES: Category[] = ['trip', 'food', 'entertainment', 'activity', 'gift', 'other'];

export type Domain = 'travel' | 'food' | 'money' | 'schedule' | 'social' | 'activities' | 'comfort' | 'style' | 'other';
export const DOMAINS: Domain[] = ['travel', 'food', 'money', 'schedule', 'social', 'activities', 'comfort', 'style', 'other'];

export interface StyleCard {
  summary: string;
  traits: string[];
  /** Short verbatim phrases from the persona's own writing. */
  phrases: SourceRef[];
  usesEmoji: boolean;
}

export interface Persona {
  id: PersonaId;
  name: string;
  handle: string;
  initials: string;
  /** Two colours for the avatar gradient. */
  colors: [string, string];
  emoji: string;
  bio: string;
  style: StyleCard | null;
  synthetic: boolean;
  createdAt: string;
}

export type SourceKind = 'document' | 'note' | 'chat' | 'email' | 'past_decision' | 'wish' | 'correction' | 'request';

export interface Source {
  id: string;
  personaId: PersonaId | 'group';
  kind: SourceKind;
  title: string;
  date: string;
  text: string;
  fileName?: string;
  synthetic: boolean;
  /** true once the AI/rules have extracted memory from it. */
  analyzed: boolean;
}

/** Exact text span of a source that supports a memory item. */
export interface SourceRef {
  sourceId: string;
  quote: string;
}

/** Machine-checkable part of a constraint. Checked in code, never by the model. */
export type Metric = 'max_cost' | 'latest_end';
export interface NumericRule {
  metric: Metric;
  /** max_cost: euros per person. latest_end: ISO datetime, or "weekly:<0-6, Sunday=0>:HH:MM". */
  value: string;
}

export type MemoryKind = 'preference' | 'constraint' | 'fact' | 'decision_pattern' | 'style';
export type Polarity = 'likes' | 'avoids' | 'neutral';
export type MemoryStatus = 'candidate' | 'confirmed' | 'rejected' | 'superseded';
export type Origin = 'seed' | 'ai' | 'rules' | 'owner';

/** OpenSelf memory record stamp (server/memory.ts). */
export interface MemoryStamp {
  id: string;
  type: string;
  sourceTrust: 'untrusted' | 'external' | 'trusted' | 'verified' | 'owner';
  contentHash: string;
  scope: string;
}

/** Where / for how long a statement was meant. A budget said for "a weekend in Greece" is not a rule for "4 days abroad". */
export type Where = 'any' | 'local' | 'domestic' | 'abroad';
export interface MemoryContext {
  where: Where;
  /** Duration in days the statement refers to (e.g. 2 for "διήμερο"); 0 = not specified. */
  days: number;
}

export interface MemoryItem {
  id: string;
  personaId: PersonaId;
  kind: MemoryKind;
  statement: string;
  domain: Domain;
  polarity: Polarity;
  /** 0..1 importance. */
  strength: number;
  hard: boolean;
  rule?: NumericRule;
  /** Context the statement was said in (optional; missing = general). */
  context?: MemoryContext;
  /** Request categories this applies to; empty = all. */
  categories: Category[];
  keywords: string[];
  refs: SourceRef[];
  confidence: number;
  status: MemoryStatus;
  origin: Origin;
  /** profile = permanent; request = only for one request ("μόνο για αυτό"). */
  scope: 'profile' | 'request';
  requestId?: string;
  memory?: MemoryStamp;
  createdAt: string;
}

export interface GroupRequest {
  id: string;
  text: string;
  title: string;
  category: Category;
  periodStart: string | null;
  periodEnd: string | null;
  participants: PersonaId[];
  /** Calendar days the plan spans (1 for an evening). */
  days?: number;
  /** local = in the home city, domestic = elsewhere in Greece, abroad. */
  where?: Exclude<Where, 'any'>;
  place?: string;
  createdAt: string;
}

export interface CandidateOption {
  id: string;
  title: string;
  emoji: string;
  summary: string;
  location: string;
  /** EUR per person; null = unknown (reported as uncertainty). */
  costPerPerson: number | null;
  costNote: string;
  startsAt: string | null;
  endsAt: string | null;
  features: string[];
  origin: 'ai' | 'catalog';
}

export interface Reason {
  memoryId: string;
  effect: 'for' | 'against';
  text: string;
}

/** One twin's judgement of one option (AI in live mode, heuristic in demo mode). */
export interface Evaluation {
  personaId: PersonaId;
  optionId: string;
  score: number;
  verdict: string;
  reasons: Reason[];
  /** Qualitative hard-constraint breaches judged by the evaluator (memory ids). */
  violations: { memoryId: string; text: string }[];
  unknowns: string[];
}

export interface Violation {
  personaId: PersonaId;
  memoryId: string;
  text: string;
  /** code = numeric rule checked in code; judged = evaluator judgement of a qualitative hard constraint. */
  checkedBy: 'code' | 'judged';
  scope: 'profile' | 'request';
}

export interface OptionResult {
  optionId: string;
  feasible: boolean;
  violations: Violation[];
  warnings: string[];
  scores: Record<PersonaId, number>;
  min: number;
  avg: number;
}

export interface TwinVote {
  personaId: PersonaId;
  optionId: string | null;
  score: number;
  verdict: string;
  reasons: Reason[];
  unknowns: string[];
  confidence: 'low' | 'medium' | 'high';
}

export type Stance = 'agree' | 'agree_with_concession' | 'object';

export interface Concession {
  personaId: PersonaId;
  stance: Stance;
  finalScore: number;
  voteScore: number;
  items: string[];
}

export interface Relaxation {
  personaId: PersonaId;
  memoryId: string;
  optionId: string;
  text: string;
}

export interface Outcome {
  /** agreement = every hard limit passes; compromise = none passes, the closest option is proposed. deadlock = legacy / no options. */
  status: 'agreement' | 'compromise' | 'deadlock';
  chosenOptionId: string | null;
  results: OptionResult[];
  votes: TwinVote[];
  concessions: Concession[];
  relaxations: Relaxation[];
  rationale: string[];
}

export interface TwinMessage {
  personaId: PersonaId;
  text: string;
  mode: 'live' | 'template';
  facts: string[];
  styleSourceIds: string[];
  guardNote?: string;
  status: 'draft' | 'approved';
}

export type Approval = 'pending' | 'approved' | 'rejected';

export interface PipelineStep {
  key: 'parse' | 'retrieve' | 'options' | 'evaluate' | 'decide';
  label: string;
  detail: string;
  mode: 'ai' | 'code' | 'demo';
  ms: number;
}

export interface Decision {
  id: string;
  requestId: string;
  createdAt: string;
  options: CandidateOption[];
  evaluations: Evaluation[];
  /** Memory items the run used (profile + request-only), snapshot. */
  inputs: MemoryItem[];
  outcome: Outcome;
  steps: PipelineStep[];
  approvals: Record<PersonaId, Approval>;
  status: 'awaiting_approval' | 'approved' | 'rejected' | 'deadlock';
  diff?: { previousId: string; changes: string[] };
  messages?: TwinMessage[];
  messagesNote?: string;
  /** The twins' negotiation, as a group DM in each owner's style. */
  chat?: TwinChat;
  aiModel: string | null;
}

export interface ChatLine {
  personaId: PersonaId;
  text: string;
}
export interface TwinChat {
  lines: ChatLine[];
  mode: 'live' | 'template';
  note?: string;
}

/** Progress of a long-running job (request generation, onboarding), shown live as a chat. */
export interface JobEvent {
  at: number;
  who: PersonaId | 'system';
  kind: 'join' | 'think' | 'options' | 'vote' | 'say' | 'info' | 'error';
  text: string;
}
export interface Job {
  id: string;
  kind: 'request' | 'onboard';
  status: 'running' | 'done' | 'error';
  events: JobEvent[];
  result?: Record<string, string>;
  error?: string;
}

export interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  embeddingTokens: number;
}

/** A past decision kept OUT of the twin's sources, used only to test whether the twin predicts it. */
export interface HeldOutCase {
  id: string;
  personaId: PersonaId;
  question: string;
  category: Category;
  actualOptionId: string;
  note: string;
  options: CandidateOption[];
  /** synthetic = team-written demo data; imported = the owner's own (with consent), from the questionnaire ZIP. */
  origin: 'synthetic' | 'imported';
}
