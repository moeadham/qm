import { createThreadTracker } from "../slack/message-gating.ts";
import { createEnvelopeStaging } from "../surfaces/envelope-staging.ts";
import { createTurnFlow } from "../surfaces/turn-flow.ts";
import { reportFailureAs, swallowAs } from "../util/errors.ts";
import { createSweeper } from "../util/sweeper.ts";
import {
  createDiscordApi,
  createDiscordGateway,
  createDiscordRest,
  type DiscordApi,
  type DiscordGateway,
  type DiscordMessage,
} from "./api.ts";
import { createDiscordBot, discordMessageKey, type AcceptGate } from "./bot.ts";
import { createApprovalButtons } from "./approvals.ts";
import { handleInteraction, QM_COMMANDS } from "./commands.ts";
import type { DiscordConfig } from "./config.ts";
import type { DiscordCoreClient } from "./core.ts";
import { createDiscordDeliveryPoller } from "./deliveries.ts";
import { createDiscordContextFulfiller } from "./context.ts";
import type { SurfaceContextRequest } from "../types.ts";

export { discordConfigFromEnv, assertOneChatPlatform, type DiscordConfig } from "./config.ts";

const GATEWAY_RETRY_MS = 5_000;
const GATEWAY_MAX_BACKOFF_MS = 30 * 60_000;
const GATEWAY_TRANSIENT_BACKOFF_MS = 60_000;
const DELIVERY_SWEEP_MS = 5_000;
const ENVELOPE_REPLAY_SWEEP_MS = 60_000;

function messageKey(body: Record<string, unknown>): string | null {
  const id = body.id;
  const channel = body.channel_id;
  return typeof id === "string" && typeof channel === "string" ? discordMessageKey(channel, id) : null;
}

export async function startDiscordPlugin(
  cfg: DiscordConfig,
  core: DiscordCoreClient,
  transport?: { api: DiscordApi; gateway: DiscordGateway },
): Promise<{ stop(): Promise<void> }> {
  const rest = transport ? undefined : createDiscordRest(cfg.botToken);
  const api = transport?.api ?? createDiscordApi(rest!, cfg.applicationId);
  const gateway = transport?.gateway ?? createDiscordGateway(cfg.botToken, rest!);
  const self = await api.me();
  const flow = createTurnFlow(core, "discord");
  const threads = createThreadTracker();
  const bot = createDiscordBot({ api, core, flow, guildIds: cfg.guildIds, self, threads });
  const deliveries = createDiscordDeliveryPoller({ api, core, flow, threads });
  const buttons = createApprovalButtons({ api, core, resumeTurn: bot.resumeTurn });
  const fulfillContext = createDiscordContextFulfiller({ api, core, selfId: self.id });
  const contextInFlight = new Set<string>();
  const serveContext = (request: SurfaceContextRequest): void => {
    if (contextInFlight.has(request.id)) return;
    contextInFlight.add(request.id);
    void fulfillContext(request)
      .catch(reportFailureAs("discord: context request", undefined))
      .finally(() => contextInFlight.delete(request.id));
  };
  const stopContext = core.onContextRequest(serveContext);
  void core
    .pendingContextRequests()
    .then((pending) => pending.forEach(serveContext))
    .catch(reportFailureAs("discord: context request drain", undefined));
  const staging = core.stagedEnvelopes
    ? createEnvelopeStaging(core.stagedEnvelopes, { account: "discord", keyFor: messageKey })
    : undefined;
  const stageFor = (message: DiscordMessage): (() => Promise<AcceptGate>) | undefined => {
    const key = messageKey(message);
    if (!staging || !key) return undefined;
    return async () => {
      await staging.stage(key, message);
      return { persisted: () => staging.accepted(key), failed: () => {} };
    };
  };
  const handlers = {
    onMessage: (message: DiscordMessage) =>
      void bot.handleMessage(message, stageFor(message)).catch(reportFailureAs("discord: message handler", undefined)),
    onInteraction: (interaction: Parameters<typeof handleInteraction>[1]) =>
      void handleInteraction({ core, api, guildIds: cfg.guildIds, buttons }, interaction).catch(
        reportFailureAs("discord: interaction handler", undefined),
      ),
  };

  let stopped = false;
  let connected = false;
  let fatalCloses = 0;
  let transientFailures = 0;
  let nextAttemptAt = 0;
  let release!: () => void;
  const stopSignal = new Promise<void>((resolve) => (release = resolve));
  const runGateway = async (lost: Promise<void>): Promise<void> => {
    if (stopped) return;
    const connection = gateway.open(handlers);
    const ended = Promise.race([lost.then(() => null), stopSignal.then(() => null), connection.closed]);
    try {
      const first = await Promise.race([connection.ready.then(() => "ready" as const), ended]);
      if (first !== "ready") {
        if (first) {
          fatalCloses++;
          throw first;
        }
        return;
      }
      fatalCloses = 0;
      transientFailures = 0;
      console.log(`[discord] gateway connected as ${self.username}`);
      await api.registerCommands(QM_COMMANDS).catch(swallowAs("discord: register commands", undefined));
      const outcome = await ended;
      if (outcome) {
        fatalCloses++;
        throw outcome;
      }
    } finally {
      await connection.close();
      console.log("[discord] gateway closed");
    }
  };
  const holdGateway = async (): Promise<void> => {
    if (connected || stopped || Date.now() < nextAttemptAt) return;
    connected = true;
    try {
      await core.holdLease("gateway", runGateway);
    } catch (error) {
      const backoff = fatalCloses
        ? Math.min(GATEWAY_RETRY_MS * 2 ** fatalCloses, GATEWAY_MAX_BACKOFF_MS)
        : Math.min(GATEWAY_RETRY_MS * 2 ** transientFailures++, GATEWAY_TRANSIENT_BACKOFF_MS);
      nextAttemptAt = Date.now() + backoff;
      throw error;
    } finally {
      connected = false;
    }
  };

  let polling: Promise<void> | null = null;
  let pollAgain = false;
  const kickDeliveries = (): void => {
    if (stopped) return;
    if (polling) {
      pollAgain = true;
      return;
    }
    polling = (async () => {
      do {
        pollAgain = false;
        await deliveries.poll();
      } while (pollAgain && !stopped);
    })()
      .catch(reportFailureAs("discord: delivery poll", undefined))
      .finally(() => {
        polling = null;
      });
  };

  const replayEnvelopes = (): Promise<unknown> =>
    staging
      ? core.holdLease("envelope-replay", () =>
          staging.sweep((body, gate) => bot.handleMessage(body as unknown as DiscordMessage, async () => gate)),
        )
      : Promise.resolve();

  const sweepers = [
    createSweeper(holdGateway, GATEWAY_RETRY_MS, { label: "discord gateway", immediate: true }),
    createSweeper(kickDeliveries, DELIVERY_SWEEP_MS, { label: "discord deliveries", immediate: true }),
    createSweeper(replayEnvelopes, ENVELOPE_REPLAY_SWEEP_MS, { label: "discord envelope replay" }),
  ];
  const unsubscribe = core.onDeliveryEnqueued(kickDeliveries);
  for (const sweeper of sweepers) sweeper.start();

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      release();
      unsubscribe();
      stopContext();
      await Promise.all(sweepers.map((sweeper) => sweeper.stop()));
      await polling;
    },
  };
}
