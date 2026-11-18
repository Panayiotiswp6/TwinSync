// Shared domain model for TwinSync. Used by the server, the decision engine,
// the evaluation script and the React UI — one definition of Owner, Source,
// Preference and Decision across the whole app.

export type OwnerId = string;

export interface Owner {
  id: OwnerId;
  name: string;
  initials: string;
  color: string;
  tagline: string;
  /** Every profile in the demo is synthetic. Kept explicit so the UI can label it. */
  synthetic: true;
}

export type SourceKind =
  | 'note'
  | 'past_decision'
  | 'chat'
  | 'owner_input'
  | 'owner_correction'
  | 'trip_request';

export interface Source {
  id: string;
  /** Owner id, or "group" for the shared trip request. */
  ownerId: OwnerId | 'group';
  kind: SourceKind;
  title: string;
  /** ISO 8601 with offset. */
  date: string;
  text: string;
  synthetic: boolean;
}

/** A citation: the exact text span of a source that supports a profile item. */
export interface SourceRef {
  sourceId: string;
  quote: string;
}

export type PrefKey =
  | 'budget_max'
  | 'return_by'
  | 'no_camping'
  | 'requires_private_bath'
  | 'likes_hiking'
  | 'max_hike_hours'
  | 'prefers_low_cost'
  | 'prefers_comfort'
  | 'likes_sea';

export type PrefKind = 'constraint' | 'preference';
export type PrefValue = number | string | boolean;

export type PrefStatus = 'candidate' | 'confirmed' | 'rejected' | 'superseded';
/** seed = team-authored synthetic profile; ai = live LLM extraction; rules = demo-mode extractor; owner = owner correction. */
export type PrefOrigin = 'seed' | 'ai' | 'rules' | 'owner';
export type PrefScope = 'profile' | 'trip';

/** OpenSelf memory record stamp (see server/memory.ts). */
export interface MemoryStamp {
  id: string;
  type: 'preference' | 'decision' | 'note';
  sourceTrust: 'untrusted' | 'external' | 'trusted' | 'verified' | 'owner';
  contentHash: string;
  scope: string;
}

export interface Preference {
  id: string;
  ownerId: OwnerId;
  key: PrefKey;
  value: PrefValue;
  /** Importance for soft preferences (0..1). Constraints are binary and ignore it. */
  weight: number;
  status: PrefStatus;
  scope: PrefScope;
  confidence: number;
  origin: PrefOrigin;
  sourceRefs: SourceRef[];
  /** Previous value if the owner corrected the extracted candidate. */
  correctedFrom?: PrefValue;
  memory?: MemoryStamp;
  createdAt: string;
}

export type StayKind = 'hotel' | 'guesthouse' | 'refuge' | 'tent';

export interface TripOption {
  id: string;
  name: string;
  region: string;
  /** Indicative demo price per person (transport + stay + food), EUR. Synthetic, not live. */
  pricePerPerson: number;
  priceNote: string;
  departSaturday: string; // HH:MM
  returnSunday: string; // HH:MM, arrival back in Athens
  activities: string[];
  hikeHours: number;
  /** 0 = no sea, 1 = beach is a main part of the trip. */
  seaAccess: number;
  stay: { kind: StayKind; label: string; privateBath: boolean };
}

export interface TripRequest {
  text: string;
  participants: OwnerId[];
  weekendLabel: string;
}

// ---------- Decision engine output ----------

export interface Violation {
  ownerId: OwnerId;
  prefId: string;
  key: PrefKey;
  scope: PrefScope;
  message: string;
  sourceRefs: SourceRef[];
}

export interface OptionEval {
  optionId: string;
  feasible: boolean;
  violations: Violation[];
  scores: Record<OwnerId, number>;
  avg: number;
  min: number;
}

export interface Reason {
  prefId: string;
  key: PrefKey;
  effect: 'for' | 'against';
  text: string;
  sourceRefs: SourceRef[];
}

export type Confidence = 'low' | 'medium' | 'high';

export interface TwinPosition {
  ownerId: OwnerId;
  /** Best option that satisfies this twin's own hard constraints (null if none). */
  voteOptionId: string | null;
  ranking: { optionId: string; score: number; okForMe: boolean }[];
  reasons: Reason[];
  constraints: Reason[];
  uncertainties: string[];
  confidence: Confidence;
}

export type Stance = 'agree' | 'agree_with_concession' | 'object';

export interface Concession {
  ownerId: OwnerId;
  stance: Stance;
  finalScore: number;
  voteScore: number;
  items: string[];
}

export interface Relaxation {
  ownerId: OwnerId;
  prefId: string;
  key: PrefKey;
  optionId: string;
  message: string;
}

export interface DecisionResult {
  status: 'agreement' | 'deadlock';
  chosenOptionId: string | null;
  options: OptionEval[];
  positions: TwinPosition[];
  concessions: Concession[];
  relaxations: Relaxation[];
  rationale: string[];
}

export type Approval = 'pending' | 'approved' | 'rejected';

export interface DecisionDiff {
  previousDecisionId: string;
  fromOptionId: string | null;
  toOptionId: string | null;
  priceDelta: number | null;
  changes: string[];
}

/** Draft message a twin proposes to post in the group chat, in its owner's style. */
export interface TwinMessage {
  ownerId: OwnerId;
  text: string;
  /** live = written by the model in the owner's style; template = demo mode or rejected model output. */
  mode: 'live' | 'template';
  model?: string;
  /** Owner's own writing used as style reference. */
  styleSourceIds: string[];
  /** Facts the message was allowed to state (all come from the decision). */
  facts: string[];
  /** Set when a model draft was replaced because it stated something not in the facts. */
  guardNote?: string;
  status: 'draft' | 'approved';
}

export interface Decision {
  id: string;
  createdAt: string;
  request: TripRequest;
  /** Snapshot of the effective preferences the engine used (profile + trip-only). */
  inputs: Preference[];
  result: DecisionResult;
  approvals: Record<OwnerId, Approval>;
  status: 'awaiting_approval' | 'approved' | 'rejected' | 'deadlock';
  diff?: DecisionDiff;
  messages?: TwinMessage[];
  messagesNote?: string;
}

export interface ExtractionCandidate {
  key: PrefKey;
  value: PrefValue;
  weight: number;
  quote: string;
  confidence: number;
}
