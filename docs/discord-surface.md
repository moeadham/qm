# Discord surface

Status: in progress on branch `claude/slack-qm-integration-o4y3ag`. This is the working plan; it becomes the operator doc as the surface lands.

## Decisions

- **One chat platform per instance.** An instance runs Slack or Discord, never both. Startup refuses configuration that sets both. `reach`, hand-offs, approvals and principal deliveries go to whichever platform is configured, so there is no per-person routing and no surface column in the directory.
- **QM is the source of truth for identity.** On Slack the workspace admits its members. On Discord nobody acts until their Discord account is linked to an active QM principal. Core classifies an unlinked `discord:<id>` as a guest everywhere (`classify()` in `src/identity/identity-service.ts`), so a bot bug cannot admit an unknown user. Deactivating the QM user blocks the Discord account.
- **Self-serve linking with Discord OAuth** (`identify` scope). The user signs in to QM, opens `/connect/discord` (optionally with a bot-issued ticket), and approves on Discord. The callback must finish in a browser whose portal session is the QM user who started it, the Discord user must match the ticket when one is present, and a QM user has at most one Discord account. The Discord token is discarded.
- **Channels trust the requester.** Only the requester must be linked. Replies post in the channel even when unlinked members can read it. Channel scopes still never load personal context, and the bot acts only in allowlisted servers.
- **Unlinked users** get a rate-limited DM with a link to connect, and nothing else.
- **`/qm` slash command** with `link`, `unlink` and `stop` subcommands; its replies are ephemeral.
- **Scope:** everything the Slack surface does that Discord supports.

## Configuration

| Variable | Purpose |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot token (Bot tab) |
| `DISCORD_APPLICATION_ID` | Application / OAuth client id |
| `DISCORD_CLIENT_SECRET` | OAuth client secret, used only for account linking |
| `DISCORD_GUILD_IDS` | Comma-separated allowlist of servers the bot acts in |

The OAuth redirect is `<portal URL>/v1/discord-link/callback`; core builds it from the configured portal URL and linking reports itself unconfigured without one. Enable the **Message Content** and **Server Members** privileged intents. Invite with scopes `bot applications.commands` and permissions `309237771328` (view channels, send messages, add reactions, embed links, attach files, read history, create public threads, send in threads, manage messages).

## Done

1. `11b033b` Chat-surface table (`src/surfaces/chat-surface.ts`) replaces `surface === "slack"` checks that apply to any chat platform; prompts render identically for Slack.
2. `8cf5c45`, `0b36212`, `14806ac` Identity guard and self-serve linking: `src/identity/discord-link.ts`, `src/api/routes/discord-link.ts`, portal `/connect/discord` and callback handler, web UI link notices. Independent review accepted (86/100) after fixes.

## Remaining

### PR 3: bot, core chat
- `src/discord/` started from `src/index.ts` under the same background-work and blue-green gating as Slack, using a renamed generic reconciler (`createSurfaceRuntimeReconciler`, from `src/surfaces/slack-runtime.ts`). Refuse to start when Slack is also configured.
- Dependencies `@discordjs/ws`, `@discordjs/rest`, `@discordjs/core`, pinned.
- Gateway held under `leaderLease.hold("discord:gateway", …)`: Discord sends every event to every connection, so exactly one instance connects. Intents: Guilds, GuildMessages, MessageContent, DirectMessages, GuildMessageReactions, DirectMessageReactions, GuildMembers.
- Split the generic half of `src/api/slack-core-client.ts` into a surface core client, and extract the delivery claim loop (`src/slack/deliveries.ts`), envelope staging and conversation-view rendering into `src/surfaces/` now that Discord is their second caller.
- Gating: DMs always; in servers an @mention, or an unprompted reply in a thread where the bot has a stake. Unlinked authors get the link-prompt DM (`mintDiscordLinkTicket`).
- Conversation model: DM `discord:dm:<dmChannelId>` in the user's personal scope; a mention starts a thread, `discord:ch:<parentChannelId>:<threadId>` with `channelRef` `discord:<parentChannelId>`.
- Actor `externalId: "discord:<id>"`; core canonicalizes. Audience is the requester plus linked members who can view the channel.
- Replies: typing indicator, placeholder edited as the reply streams (about one edit per second), split at 2,000 characters, Markdown passthrough.
- Delivery poller for `type:"discord"` rows under the `discord:delivery-dispatch` lease; targets `<channelId>[:<replyToMessageId>]` or `principal:<id>`.
- `/qm link|unlink|stop`; stop also via a status-message button.
- Add `discord` to `src/surfaces/chat-surface.ts` with its label and mention syntax.

### PR 4: interactions, files, reactions
- Approval buttons with the existing `hilo_*`, `keychain_*`, `deploy_access_*` ids over `INTERACTION_CREATE`, deferred within 3 seconds; generalize the Slack-only gate in `src/core/approval-store.ts`.
- Inbound attachments only from Discord's CDN hosts into `stageBlob`; outbound uploads within the server limit, otherwise a QM file link.
- `[[react: …]]` directives and inbound reactions on messages the bot has a stake in.
- Private replies: ephemeral for interactions, DM otherwise.

### PR 5: directory, hand-offs, admin, docs
- Channel directory push with `discord:` ids; people come from QM links, not a Discord roster.
- `reach` and principal deliveries target the configured platform.
- Pinned model header and channel topic.
- Admin install page (stored bot token) and linked-accounts view; "Connect Discord" in web UI settings.
- Operator docs: this file, plus what Discord cannot do (email lookup, group DMs, acting as the user, Slack's AI pane, Slack Connect external access, HTTP events).

## Verification

- Tests through real paths with a fake Discord REST client and gateway, in the style of `test/slack-*.test.ts`; each bug-fix test fails on old code.
- Locally: affected tests, `npm run typecheck`, lint. CI runs the full suite.
- Live QA in the developer's Discord test server: link from a DM prompt, DM conversation, mention to thread to unprompted follow-up, approval button, file round trip, unlinked user sees only the prompt, deactivated user refused. The OAuth link step needs a public portal, so the final end-to-end pass runs on the Fly staging app with its callback registered in the Discord app.
- Per PR: an independent fresh-context review and the Wall of shame lens reviews recorded in the PR description.
