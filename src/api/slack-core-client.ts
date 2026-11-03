import { isSessionTurn } from "../core/turn-origin.ts";
import { replayableRequest } from "../core/orchestrator/turn-helpers.ts";
import {
  createSlackSessionStatus,
  type SlackStatusActivity,
  type SlackSessionStatus,
  type SlackSessionStatusState,
} from "../slack/session-status.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import { decideDeploymentAccess } from "../slack/deploy-access.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { ActorAssertion } from "../types.ts";
import type { KeychainApprovals } from "../credentials/keychain-approval.ts";
import { createTaskAcknowledgements, type TaskAckState, type TaskAcknowledgements } from "../slack/task-ack.ts";
import { orgId as configOrgId } from "../config.ts";
import { resolveBranding } from "../resolution/branding.ts";
import { createNoopLeaderLease } from "../persistence/leader-lease.ts";
import {
  createSurfaceCoreClient,
  type SurfaceCoreClient,
  type SurfaceCoreClientDeps,
} from "../surfaces/surface-core-client.ts";
import type { PendingApproval, ScopeId, SurfaceContextRequest, SurfaceContextResult, TurnRequest } from "../types.ts";
import { buffer } from "node:stream/consumers";
import { scopeId } from "../types.ts";
import type { MemoryService } from "../memory/memory-service.ts";
import type { CachedMessage, ReadMessagesOpts, SurfaceCache, IngestEvent } from "../surface-cache/surface-cache.ts";
import type { AckEmojiPickStore } from "../surface-cache/ack-emoji-pick-store.ts";
import type { OrgBranding, ScopedConfigStore } from "../resolution/config-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { swallowAs } from "../util/errors.ts";
import { resolveRuntimeChoiceDurable } from "../harness/harness-router.ts";
import type { RuntimeChoice } from "../harness/harness.ts";
import { modelDisplayName } from "../model/pi-models.ts";
import type { ConversationEvent } from "../loops/sources/adapter.ts";
import { slackConversationRef } from "../loops/sources/slack.ts";

interface StoredApprovalView extends Omit<PendingApproval, "reason"> {
  createdAt?: number;
  reason?: string;
  request?: Record<string, unknown>;
}

interface DirectoryPush {
  members?: Array<{ principalId: string; displayName: string; type: "internal"; slackId?: string; avatarUrl?: string }>;
  channels?: Array<{ channelId: string; name: string; isPrivate?: boolean; isExternal?: boolean }>;
  channelMembers?: Array<{ channelId: string; principalId: string }>;
  channelRosterIds?: string[];
  channelRevocations?: Array<{ channelId: string; principalId: string }>;
  groupMembers?: Array<{ groupId: string; principalId: string }>;
  groupIds?: string[];
  groupRosterIds?: string[];
  workspaceUrl?: string;
  membersSyncedAt?: number;
  channelsSyncedAt?: number;
  partialChannels?: boolean;
  groupsSyncedAt?: number;
}

export interface SlackCoreClient extends SurfaceCoreClient {
  privateContinuationSource?(runId: string): Promise<TurnRequest | null>;
  decideDeploymentAccess(value: string, actor: ActorAssertion, approve: boolean): Promise<string>;
  keychainApprovals?: KeychainApprovals;
  taskAcknowledgements?: TaskAcknowledgements;
  sessionStatus?: SlackSessionStatus;
  externalSlackParticipants(): Promise<boolean>;
  internalMemberOverrides(): Promise<string[]>;
  ackEmojiOverride(): Promise<string[] | null>;
  publishEmojiCatalog(emoji: Record<string, string>): Promise<void>;
  surfaceHeaderFacts(scope: ScopeId): Promise<{ agentLabel?: string; modelName: string }>;
  channelHeaderPinEnabled(scope: ScopeId): Promise<boolean>;
  onScopeModelChanged(listener: (scope: ScopeId) => void): void;
  onChannelHeaderPinChanged(listener: (scope: ScopeId) => void): void;
  readFileArtifact(artifactId: string, viewerId: string): Promise<Buffer>;
  rememberSurfaceHistory?(events: IngestEvent[]): Promise<void>;
  noteSurfaceHistoryGap?(container: string, note: string): Promise<void>;
  readSurfaceMessages?(container: string, opts?: ReadMessagesOpts): Promise<CachedMessage[]>;
  ingestSurfaceEvents(events: IngestEvent[], self?: { name?: string; mentionId?: string }): Promise<void>;
  getApproval(requestId: string): Promise<StoredApprovalView | null>;
  pushDirectory(body: DirectoryPush): Promise<boolean>;

  holdDeliveryDispatch<T>(fn: (lost: Promise<void>) => Promise<T>): Promise<T | null>;
  holdEnvelopeReplay<T>(account: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null>;
  holdDirectorySync<T>(fn: (lost: Promise<void>) => Promise<T>): Promise<T | null>;
  pendingContextRequests(): Promise<SurfaceContextRequest[]>;
  onContextRequest(listener: (request: SurfaceContextRequest) => void): () => void;
  fulfillContextRequest(id: string, outcome: { result?: SurfaceContextResult; error?: string }): Promise<void>;
  pickAckEmoji(text: string, candidates: readonly string[]): Promise<string | undefined>;
  recordAckPick(pick: AckPickInput): Promise<void>;
  inboxSlackMessage(msg: {
    channel: string;
    ts: string;
    threadTs?: string;
    text?: string;
    senderEmail?: string;
    isDirectMessage?: boolean;
  }): Promise<void>;
}

type AckPickInput = {
  channel: string;
  ts: string;
  outcome: "picked" | "declined";
  picked?: string;
  icon?: string;
  message?: string;
  candidates?: string;
  latencyMs?: number;
};

export type { SurfaceContextRequest };

export interface SlackCoreClientDeps extends SurfaceCoreClientDeps {
  identity: IdentityService;
  keychainApprovals?: KeychainApprovals;
  taskAcknowledgements?: DurableMap<TaskAckState>;
  sessionStatus?: DurableMap<SlackSessionStatusState>;
  statusActivity?: SlackStatusActivity;
  featureFlags?: FeatureFlagStore;
  config: ScopedConfigStore;
  runtimeFallback: RuntimeChoice;
  pickAckEmoji?(text: string, candidates: readonly string[]): Promise<string | undefined>;
  ackPicks?: AckEmojiPickStore;
  ackModelId?: () => string | undefined;
  brandingDefault?: OrgBranding;
  surfaceCache?: SurfaceCache;
  memory?: MemoryService;
  inboxEvent?(event: ConversationEvent): Promise<void>;
}

export function createSlackCoreClient(deps: SlackCoreClientDeps): SlackCoreClient {
  const lease = deps.leaderLease ?? createNoopLeaderLease();
  const orgScope: ScopeId = scopeId("org", configOrgId());
  const base = createSurfaceCoreClient("slack", deps);

  return {
    ...base,
    decideDeploymentAccess: (value, actor, approve) =>
      decideDeploymentAccess(deps.app, deps.identity, value, actor, approve),
    ...(deps.keychainApprovals ? { keychainApprovals: deps.keychainApprovals } : {}),
    ...(deps.taskAcknowledgements
      ? { taskAcknowledgements: createTaskAcknowledgements(deps.taskAcknowledgements, lease, deps) }
      : {}),
    ...(deps.sessionStatus && deps.featureFlags
      ? {
          sessionStatus: createSlackSessionStatus(
            deps.sessionStatus,
            lease,
            deps.runs,
            deps.featureFlags,
            Date.now,
            deps.statusActivity,
          ),
        }
      : {}),
    async externalSlackParticipants() {
      return (await deps.config.getExternalSlackParticipantsDurable(orgScope)) === true;
    },

    async internalMemberOverrides() {
      return deps.config.getInternalMemberOverridesDurable();
    },

    async ackEmojiOverride() {
      return await deps.config.getAckEmojiDurable(orgScope);
    },

    async publishEmojiCatalog(emoji) {
      deps.config.setSlackEmojiCatalog(orgScope, emoji);
    },

    async surfaceHeaderFacts(scope) {
      const [choice, branding] = await Promise.all([
        resolveRuntimeChoiceDurable(deps.config, orgScope, scope, deps.runtimeFallback),
        resolveBranding(deps.config, orgScope, deps.brandingDefault),
      ]);
      return {
        ...(branding.selfLabel ? { agentLabel: branding.selfLabel } : {}),
        modelName: modelDisplayName(choice.modelId),
      };
    },

    async channelHeaderPinEnabled(scope) {
      return deps.config.getChannelHeaderPinDurable(scope);
    },

    onScopeModelChanged(listener) {
      deps.config.onRuntimeSelectionChanged((scope) => listener(scope));
    },

    onChannelHeaderPinChanged(listener) {
      deps.config.onChannelHeaderPinChanged((scope) => listener(scope));
    },

    async readFileArtifact(artifactId, viewerId) {
      const opened = await deps.app.openFileForViewer(artifactId, viewerId);
      if (!opened) throw new Error(`file artifact ${artifactId} not found (or not visible to ${viewerId})`);
      return buffer(opened.stream);
    },

    async rememberSurfaceHistory(events) {
      await deps.surfaceCache?.ingest(events);
    },

    async noteSurfaceHistoryGap(container, note) {
      if (!deps.memory) return;
      const kind = (await deps.surfaceCache?.containerState(container))?.kind;
      await deps.memory.capture(scopeId(kind === "group" ? "group" : "channel", container), [note], Date.now());
    },

    async readSurfaceMessages(container, opts) {
      return deps.app.readSurfaceMessages(container, { ...opts, noFallback: true });
    },

    async ingestSurfaceEvents(events, self) {
      if (!events.length) return;
      await deps.app.ingestSurfaceEvents(events, "slack", self);
    },

    async privateContinuationSource(runId) {
      const run = await deps.runs.get(runId);
      if (
        !run?.request.externalSlack ||
        run.request.origin.kind !== "human" ||
        isSessionTurn(run.request) ||
        run.request.actor.type !== "internal"
      )
        return null;
      return replayableRequest(run.request);
    },

    async getApproval(requestId) {
      const record = await deps.app.getApproval(requestId);
      if (!record) return null;
      return {
        requestId: record.requestId,
        ...(record.createdAt !== undefined ? { createdAt: record.createdAt } : {}),
        command: record.command,
        ...(record.reason !== undefined ? { reason: record.reason } : {}),
        ...(record.purpose !== undefined ? { purpose: record.purpose } : {}),
        ...(record.summary !== undefined ? { summary: record.summary } : {}),
        ...(record.summaryDetail !== undefined ? { summaryDetail: record.summaryDetail } : {}),
        ...(record.grantModes !== undefined ? { grantModes: record.grantModes } : {}),
        ...(record.kind !== undefined ? { kind: record.kind } : {}),
        ...(record.request !== undefined ? { request: record.request as unknown as Record<string, unknown> } : {}),
      };
    },

    async pushDirectory(body) {
      if (body.workspaceUrl) await deps.app.setDirectoryWorkspaceUrl(body.workspaceUrl);
      let applied = true;
      if (body.members) applied = (await deps.app.upsertDirectory(body.members, body.membersSyncedAt)) && applied;
      if (body.channels) {
        applied =
          (await deps.app.upsertChannels(
            body.channels,
            body.channelMembers,
            body.channelsSyncedAt,
            body.channelRosterIds,
            body.channelRevocations,
            body.partialChannels,
          )) && applied;
      }
      if (body.groupMembers) {
        applied =
          (await deps.app.upsertGroups(body.groupMembers, body.groupsSyncedAt, body.groupIds, body.groupRosterIds)) &&
          applied;
      }
      return applied;
    },

    holdDeliveryDispatch(fn) {
      return base.holdLease("delivery-dispatch", fn);
    },
    holdDirectorySync(fn) {
      return base.holdLease("directory-sync", fn);
    },
    holdEnvelopeReplay(account, fn) {
      return base.holdLease(`envelope-replay:${account}`, fn);
    },

    pendingContextRequests() {
      return deps.app.pendingContextRequests("slack");
    },

    onContextRequest(listener) {
      return deps.app.onContextRequestCreated((request) => {
        if (request.source === "slack") listener(request);
      });
    },

    pickAckEmoji(text, candidates) {
      return deps.pickAckEmoji?.(text, candidates) ?? Promise.resolve(undefined);
    },

    async inboxSlackMessage(msg) {
      const at = Math.round(Number.parseFloat(msg.ts) * 1000);
      if (!Number.isFinite(at)) return;
      await deps.inboxEvent?.({
        source: "slack",
        conversationRef: slackConversationRef(msg.channel, msg.ts, msg.threadTs, msg.isDirectMessage),
        at,
        ...(msg.text ? { text: msg.text } : {}),
        ...(msg.senderEmail ? { senderEmail: msg.senderEmail } : {}),
      });
    },
    async recordAckPick(pick) {
      if (!deps.ackPicks) return;
      const ackModel = deps.ackModelId?.();
      await deps.ackPicks
        .record({
          surface: "slack",
          channel: pick.channel,
          ts: pick.ts,
          outcome: pick.outcome,
          ...(pick.picked ? { picked: pick.picked } : {}),
          ...(pick.icon ? { icon: pick.icon } : {}),
          ...(pick.message ? { message: pick.message } : {}),
          ...(pick.candidates ? { candidates: pick.candidates } : {}),
          ...(ackModel ? { model: ackModel } : {}),
          ...(pick.latencyMs != null ? { latencyMs: pick.latencyMs } : {}),
          createdAt: Date.now(),
        })
        .catch(() => {});
    },

    async fulfillContextRequest(id, outcome) {
      await deps.app
        .fulfillContextRequest(id, outcome)
        .then((ok) => {
          if (!ok) return;
        })
        .catch(swallowAs("slack-core-client: fulfill context request", undefined));
    },
  };
}
