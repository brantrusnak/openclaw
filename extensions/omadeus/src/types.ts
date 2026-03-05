// ---------------------------------------------------------------------------
// Omadeus config shape (stored under channels.omadeus in OpenClaw config)
// ---------------------------------------------------------------------------

export type OmadeusChannelConfig = {
  enabled?: boolean;
  casUrl?: string;
  maestroUrl?: string;
  email?: string;
  password?: string;
  organizationId?: number;
  /** Cached Omadeus session JWT obtained during onboarding/startup. */
  sessionToken?: string;
  /** When true, messages sent by the authenticated user are ignored. Default: true. */
  ignoreSelfMessages?: boolean;
  dm?: {
    policy?: string;
    allowFrom?: Array<string | number>;
  };
};

export type ResolvedOmadeusAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: OmadeusChannelConfig;
  casUrl: string;
  maestroUrl: string;
  email: string;
  password: string;
  organizationId: number;
  sessionToken?: string;
  /** "none" if neither config credentials nor cached session token exist */
  credentialSource: "config" | "session" | "none";
};

// ---------------------------------------------------------------------------
// CAS auth types
// ---------------------------------------------------------------------------

export type CasTokenResponse = {
  token?: string;
};

export type CasAuthorizationCodeResponse = {
  authorizationCode?: string;
  code?: string;
};

export type OmadeusSessionTokenResponse = {
  token: string;
};

export type OmadeusOrganization = {
  id: number;
  title: string;
  plan: string;
  membersCount: number;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// JWT decoded payload (only fields we need)
// ---------------------------------------------------------------------------

export type OmadeusJwtPayload = {
  id: number;
  email: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  referenceId: number;
  sessionId: string;
  organizationId: number;
  roles: string[];
  exp: number;
};

// ---------------------------------------------------------------------------
// Jaguar socket message (chat — DMs, nugget rooms, task rooms, etc.)
// ---------------------------------------------------------------------------

export type OmadeusSubscribableType =
  | "direct"
  | "channel"
  | "nugget"
  | "project"
  | "sprint"
  | "release"
  | "summary"
  | "client"
  | "folder"
  | (string & {});
export type OmadeusSubscribableKind =
  | "task"
  | "direct"
  | "channel"
  | "nugget"
  | "project"
  | "sprint"
  | "release"
  | "summary"
  | "client"
  | "folder"
  | (string & {});

export type OmadeusMessage = {
  id: number;
  temporaryId?: string;
  type: "message";
  roomId: number;
  senderId: number;
  senderReferenceId: number;
  organizationId: number;
  body: string;
  roomName: string | null;
  subscribableType: OmadeusSubscribableType;
  subscribableKind: OmadeusSubscribableKind;
  createdAtTimestamp: number;
  mimetype: string;
  filename: string | null;
  fileLength: number | null;
  duration: number | null;
  details: string | null;
  replyRootId: number | null;
  attachmentUrl: string | null;
  speechFileUrl: string | null;
  reactions: Record<string, unknown>;
  threadRoomId: number | null;
  replyTo: unknown | null;
  createdAt: string;
  removedAt: string | null;
  metadata: unknown | null;
  isMute: boolean;
  isSeen: boolean;
};

/** Parsed details.rawMessage field for @mention detection. */
export type OmadeusMessageDetails = {
  rawMessage?: string;
};

// ---------------------------------------------------------------------------
// Dolphin socket events (task/data — assignments, updates, etc.)
// ---------------------------------------------------------------------------

export type DolphinSocketEvent = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Inbound message (normalized for OpenClaw)
// ---------------------------------------------------------------------------

export type OmadeusInboundMessage = {
  from: string;
  fromReferenceId: number;
  content: string;
  roomId: number;
  roomName: string | null;
  subscribableType: OmadeusSubscribableType;
  subscribableKind: OmadeusSubscribableKind;
  isMention: boolean;
  timestamp: number;
};
