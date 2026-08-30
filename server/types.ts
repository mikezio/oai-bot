export type AgentStatus = "idle" | "working" | "waiting" | "offline";

export interface AgentActivity {
  kind: "thinking" | "tool" | "waiting";
  tool?: string;
  detail?: string;
  target?: string;
  callId?: string;
  updatedAt: string;
}

export type AvatarPaint = "primary" | "accent" | "ink" | "white" | "none";
export type AvatarLayerMotion = "none" | "breathe" | "float" | "sway" | "blink";

export interface AvatarVectorLayer {
  id: string;
  kind: "path" | "ellipse" | "circle";
  role: "body" | "feature" | "face" | "accessory";
  d?: string;
  cx?: number;
  cy?: number;
  rx?: number;
  ry?: number;
  r?: number;
  fill: AvatarPaint;
  stroke?: AvatarPaint;
  strokeWidth?: number;
  opacity?: number;
  motion?: AvatarLayerMotion;
}

/** Safe, data-only vector character format. It contains no markup, scripts, URLs, or CSS. */
export interface AvatarVectorSpec {
  version: 1;
  name: string;
  layers: AvatarVectorLayer[];
}

export interface AgentProfile {
  id: string;
  name: string;
  title: string;
  description: string;
  instructions: string;
  memories?: Array<{ id: string; text: string; createdAt: string; updatedAt: string }>;
  avatar: string;
  color: string;
  avatarShape?: "blob" | "pebble" | "squircle" | "tablet" | "wedge" | "hex" | "cloud" | "teardrop" | "cat" | "dog" | "custom" | "vector";
  avatarShapeName?: string;
  avatarMorph?: number[];
  avatarVector?: AvatarVectorSpec;
  avatarColor?: string;
  avatarDataUrl?: string;
  avatarAccent?: string;
  avatarFace?: "dots" | "visor" | "spark" | "none";
  avatarTexture?: "solid" | "gradient" | "glass";
  avatarMotion?: "calm" | "lively" | "off";
  avatarAccessory?: "none" | "antenna" | "halo" | "headphones" | "crown";
  model: string;
  effort: string;
  networkAccess: boolean;
  privateWorkspacePath?: string;
  status: AgentStatus;
  activity?: AgentActivity;
  isComposingMessage?: boolean;
  isRetrying?: boolean;
  awaitingUserResponse?: boolean;
  roomThreadIds: Record<string, string>;
  roomLastSeenMessageIds: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface Room {
  id: string;
  name: string;
  description: string;
  agentIds: string[];
  kind?: "group" | "direct";
  directAgentId?: string;
  /** Hidden Codex thread used only to select a Channel member. It never speaks in the transcript. */
  routerThreadId?: string;
  runState?: {
    nonce: string;
    phase: "active" | "winding-down" | "waiting";
    activeAgentId?: string;
    startedAt: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentRef {
  id: string;
  name: string;
  path: string;
  size: number;
  mimeType: string;
}

export type MessageKind = "message" | "peer-message" | "activity" | "approval" | "routine" | "error";
export type MessageStatus = "complete" | "streaming" | "failed";

export interface ChatMessage {
  id: string;
  roomId: string;
  senderType: "user" | "agent" | "system";
  senderId: string;
  content: string;
  kind: MessageKind;
  status: MessageStatus;
  mentions: string[];
  replyTo?: string;
  clientNonce?: string;
  /** Durable client send envelope retained for replay, diagnostics, and retries. */
  richText?: unknown;
  isFork?: boolean;
  traceparent?: string;
  sentAtMs?: number;
  enterEpochMs?: number;
  composedAtMs?: number;
  source?: "desktop" | "mobile";
  attachmentPaths?: string[];
  attachmentNames?: string[];
  dispatchStatus?: "pending" | "processing" | "completed" | "superseded" | "failed";
  attachments?: AttachmentRef[];
  reactions?: Record<string, string[]>;
  turnId?: string;
  cycleId?: string;
  fromAgentId?: string;
  toAgentIds?: string[];
  /** Per-Bot durable transcript cursor assigned when this entry is committed. */
  transcriptCursors?: Record<string, { generation: number; updatedSeq: number }>;
  createdAt: string;
  updatedAt: string;
}

export interface Routine {
  id: string;
  roomId: string;
  agentId: string;
  name: string;
  instruction: string;
  intervalMinutes: number;
  isEnabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PendingApproval {
  id: string;
  rpcId: string | number;
  method: string;
  threadId: string;
  agentId?: string;
  roomId?: string;
  title: string;
  detail: string;
  params: Record<string, unknown>;
  createdAt: string;
}

/** Durable cursor metadata for one Bot's private transcript stream. */
export interface AgentTranscriptMetadata {
  agentId: string;
  /** Changes only when the transcript is intentionally replaced or reset. */
  generation: number;
  /** Monotonic within a generation and suitable for incremental watch cursors. */
  updatedSeq: number;
  createdAt: string;
  updatedAt: string;
}

export type TranscriptEntryKind = MessageKind | "delete";

/** One durable row in a Bot's private, incrementally watchable transcript. */
export interface TranscriptEntry {
  agentId: string;
  generation: number;
  /** Stable ordering of the entry within this transcript generation. */
  seq: number;
  /** Ordering of the latest insert, update, or deletion affecting this row. */
  updatedSeq: number;
  entryId: string;
  messageId?: string;
  entryKind: TranscriptEntryKind;
  body?: string;
  bodyOmitted?: boolean;
  blobHash?: string;
  deleted?: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface TranscriptEntryCommit {
  entryId: string;
  messageId?: string;
  entryKind: TranscriptEntryKind;
  body?: string;
  bodyOmitted?: boolean;
  blobHash?: string;
  deleted?: boolean;
  createdAt?: string;
  updatedAt?: string;
  /** Optimistic concurrency guard. Zero means the row must not yet exist. */
  expectedUpdatedSeq?: number;
}

export interface TranscriptCommitRejection {
  entryId: string;
  currentUpdatedSeq: number;
  reason: "updated-seq-conflict";
}

export interface TranscriptCursor {
  agentId: string;
  generation: number;
  afterUpdatedSeq: number;
}

export interface AgentClientPresence {
  agentId: string;
  viewing: boolean;
  surface: string;
  updatedAt: string;
  expiresAt: string;
}

export type MemberTurnState = "queued" | "running" | "completed" | "passed" | "cancelled" | "failed";

export interface MemberTurnRoomSnapshot {
  id: string;
  name: string;
  description: string;
  isSharedRoom: boolean;
  sharedRoomId?: string;
}

export interface MemberTurnPeerSnapshot {
  id: string;
  name: string;
  description: string;
}

export interface MemberTurnReplySnapshot {
  speakerKind: "human" | "agent" | "system";
  speakerName: string;
  isSelf: boolean;
  quote: string;
}

export interface MemberTurnMessageSnapshot {
  messageId?: string;
  speakerKind: "human" | "agent" | "system";
  speakerId?: string;
  speakerName: string;
  isSelf: boolean;
  text: string;
  replyTo?: MemberTurnReplySnapshot;
}

/** A durable, independently addressable offer for a room member to take a turn. */
export interface MemberTurnWorkflow {
  id: string;
  nonce: string;
  roomId: string;
  memberAgentId: string;
  requestedBy: "user" | "agent" | "routine" | "system";
  requestedByAgentId?: string;
  /** Priority peer delivery may interrupt and supersede non-user work. */
  priority?: boolean;
  triggerMessageId?: string;
  peerAgentIds: string[];
  newMessageIds: string[];
  /** Immutable delivery envelope captured when this turn is offered. */
  roomSnapshot?: MemberTurnRoomSnapshot;
  peerSnapshots?: MemberTurnPeerSnapshot[];
  newMessages?: MemberTurnMessageSnapshot[];
  /** Hidden host cue that asks a newly created Bot to open its direct chat. */
  isFirstRun?: boolean;
  isWindingDown: boolean;
  state: MemberTurnState;
  workflowId?: string;
  rootWorkflowId?: string;
  parentWorkflowId?: string;
  /** Shared group that originated a direct peer handoff. */
  originRoomId?: string;
  leaseId?: string;
  attempts?: number;
  turnId?: string;
  deadlineAt?: string;
  startedAt?: string;
  finishedAt?: string;
  cancellationReason?: string;
  error?: string;
  /** Set on load for work that was running when the previous process exited. */
  recoveryRequired?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type DeliveryReceiptKind = "user-message" | "agent-message" | "member-turn";
export type DeliveryStatus = "not-found" | "pending" | "accepted" | "rejected" | "unknown-durability";
export type DeliveryMode = "off" | "shadow" | "live" | "box" | "local";
export type DeliveryCode =
  | "accepted-local"
  | "delivered-local"
  | "accepted-box"
  | "accepted-temporal"
  | "delivered-box"
  | "delivered-temporal"
  | "duplicate"
  | "refused"
  | "target-not-found"
  | "forbidden"
  | "box-unreachable"
  | "not-temporal"
  | "temporal-unavailable"
  | "invalid-target";

/** Stable message/turn acceptance record, separate from the transcript itself. */
export interface DeliveryReceipt {
  id: string;
  messageId: string;
  clientNonce?: string;
  kind: DeliveryReceiptKind;
  status: DeliveryStatus;
  mode?: DeliveryMode;
  delivery?: DeliveryCode;
  roomId?: string;
  fromAgentId?: string;
  toAgentId?: string;
  memberTurnId?: string;
  workflowId?: string;
  echoEntryId?: string;
  refusalCode?: string;
  acceptedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentNotificationSettings {
  enabled: boolean;
  mentionsOnly: boolean;
  soundEnabled: boolean;
}

/** User/client presentation state kept separate from Bot identity and live activity. */
export interface AgentClientState {
  agentId: string;
  lastViewedAt?: string;
  unreadCount: number;
  lastActivityAt?: string;
  lastEntryId?: string;
  lastEntryKind?: MessageKind;
  lastMessageId?: string;
  lastMessagePreview?: string;
  hiddenFromSidebar: boolean;
  notificationsEnabled: boolean;
  notifyOnUpdatesEnabled: boolean;
  /** Legacy read shape accepted during migration and removed before persistence. */
  notificationSettings?: AgentNotificationSettings;
  updatedAt: string;
}

export interface AppState {
  agents: AgentProfile[];
  rooms: Room[];
  messages: ChatMessage[];
  approvals: PendingApproval[];
  routines: Routine[];
  transcriptMetadata: AgentTranscriptMetadata[];
  transcriptEntries: TranscriptEntry[];
  memberTurns: MemberTurnWorkflow[];
  deliveryReceipts: DeliveryReceipt[];
  agentClientStates: AgentClientState[];
}

export interface AccountState {
  connected: boolean;
  authMode: "chatgpt" | "apiKey" | "none" | "unknown";
  runtimeAvailable?: boolean;
  email?: string;
  planType?: string;
  requiresOpenaiAuth?: boolean;
  primaryUsedPercent?: number;
  primaryWindowMinutes?: number;
  primaryResetsAt?: number;
  error?: string;
}
