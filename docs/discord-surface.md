# Discord surface

Status: in progress on branch `claude/slack-qm-integration-o4y3ag`. This is the working plan; it becomes the operator doc as the surface lands.

## Decisions

- **One chat platform per instance.** An instance runs Slack or Discord, never both. Startup refuses configuration that sets both. `reach`, hand-offs, approvals and principal deliveries go to whichever platform is configured, so there is no per-person routing and no surface column in the directory.
- **QM is the source of truth for identity.** On Slack the workspace admits its members. On Discord nobody acts until their Discord account is linked to an active QM principal. Core classifies an unlinked `discord:<id>` as a guest everywhere (`classify()` in `src/identity/identity-service.ts`), so a bot bug cannot admit an unknown user. Deactivating the QM user blocks the Discord account.
- **Self-serve linking with Discord OAuth** (`identify` scope). The user signs in to QM, opens `/connect/discord` (optionally with a bot-issued ticket), and approves on Discord. The callback must finish in a browser whose portal session is the QM user who started it, the Discord user must match the ticket when one is present, and a QM user has at most one Discord account. The Discord token is discarded.
- **Channels trust the requester.** Only the requester must be linked. Replies post in the channel even when unlinked members can read it. Channel scopes still never load personal context, and the bot acts only in allowlisted servers.
- **Unlinked users** get a rate-limited DM with a link to connect, and nothing else.
- **`/qm` slash command** with `link`, `unlink`, `stop` and `model` subcommands; its replies are ephemeral.
- **Scope:** everything the Slack surface does that Discord supports.

## Configuration

| Variable | Purpose |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot token (Bot tab) |
| `DISCORD_APPLICATION_ID` | Application / OAuth client id |
| `DISCORD_CLIENT_SECRET` | OAuth client secret, used only for account linking |
| `DISCORD_GUILD_IDS` | Comma-separated allowlist of servers the bot acts in |

The OAuth redirect is `<portal URL>/v1/discord-link/callback`; core builds it from the configured portal URL and linking reports itself unconfigured without one. Enable the **Message Content** privileged intent; the gateway refuses to connect without it. Invite with scopes `bot applications.commands` and permissions `309237771328` (view channels, send messages, add reactions, embed links, attach files, read history, create public threads, send in threads, manage messages).

## Done

1. `11b033b` Chat-surface table (`src/surfaces/chat-surface.ts`) replaces `surface === "slack"` checks that apply to any chat platform; prompts render identically for Slack.
2. `8cf5c45`, `0b36212`, `14806ac` Identity guard and self-serve linking: `src/identity/discord-link.ts`, `src/api/routes/discord-link.ts`, portal `/connect/discord` and callback handler, web UI link notices. Independent review accepted (86/100) after fixes.
3. PR 3, bot and core chat (`src/discord/`). Shared surface pieces moved to `src/surfaces/`: `surface-core-client.ts` (generic half of the Slack core client, plus a streaming `onSnapshot` hook), `turn-flow.ts`, `delivery-claims.ts`, `envelope-staging.ts` (caller supplies the key), `conversation.ts`, `safe-cut.ts`, `surface-runtime.ts` (`createSurfaceRuntimeReconciler`). Startup refuses Slack and Discord together. The gateway runs under the `discord:gateway` lease, deliveries under `discord:delivery-dispatch`, staged-message replay under `discord:envelope-replay`; staged messages share the existing `slack_staged_envelopes` table. Link prompts are limited to one per user per six hours through the rate-limit table. Intents: Guilds, GuildMessages, MessageContent, DirectMessages. A thread's `channelRef` is the raw parent channel id, as on Slack, so the `discord` tool can post to it. Gateway connect failures back off exponentially up to 30 minutes so a misconfigured app does not spend Discord's daily identify budget. `/qm` replies are deferred, then edited.

   Not yet in PR 3: the conversation audience is the requester only (linked members who can view the channel need the member roster, PR 5); the `discord` tool's read actions still go through the Slack context puller; no stop button on a status message; streaming shows only when the run executes on the gateway instance (other instances' deltas never reach its local turn stream), otherwise the reply arrives whole. A gateway stopped before READY during a Discord incident that accepts IDENTIFY but never answers READY keeps identifying about every 15 seconds until READY arrives; it processes nothing and is torn down then.

4. Web UI settings show a Discord account card (`plugins/web-ui/src/discord-account.ts`) next to the Slack one when linking is configured: the linked Discord username and link date with an Unlink button, or a link button to `/connect/discord`. The OAuth callback returns to `/settings?discord=<status>`, and `GET /v1/discord-link` reports `username` and `linkedAt` from the stored link; the username is kept in the link's optional `label`, so links made before it existed show the Discord id.
5. Approval buttons (`src/discord/approval-cards.ts`, `src/discord/approvals.ts`). Command approvals, credential (keychain) requests and app-access requests post as messages with buttons; a click is deferred within Discord's 3 seconds and decided through the same core paths Slack uses. Command approvals go to the requester's DM, as on Slack (the approval store now enqueues them for any chat surface), and only the requester's click counts; the resumed turn replays the stored request with an idempotency key, and its reply lands in the original conversation. Credential cards post in the requesting conversation and only the credential owner can decide; app-access cards go to the owner's DM and carry the delivery id, from which the request is read back. Button ids are `qm:cmd:<once|session|always|deny>:<id>`, `qm:key:<once|standing|deny>:<askId>` and `qm:app:<approve|decline>:<deliveryId>`. A credential card decided elsewhere keeps its buttons until clicked, then shows the outcome. `getApproval`, `decideDeploymentAccess` and `keychainApprovals` moved into the shared surface core client.
6. `/qm model [name]` shows or sets the model for the conversation's scope, the same override the web model picker and the agent's `runtime` tool use (QM keeps no per-session model): in a DM that is the user's personal scope, which also covers their personal web chats; in a server channel or thread it is the parent channel's scope. `name` autocompletes from the models available to that user there, including ChatGPT/Codex and Claude subscription models, and `default` clears the override. Validation is `availableRuntimeError`, as for scheduled runtimes, and the change is audited as `runtime-config.update`. Name matching is the shared `matchRuntimeModel`.
7. Crons created in a Discord thread or DM default to that conversation and their fires queue `discord` deliveries back to it. A scheduled run now gets the surface tool of the chat surface it delivers to instead of always Slack's. Not yet: `reach` to a named channel (`#name`) resolves only Slack channels.

## Remaining

### PR 3 follow-ups
- Independent review accepted at `a899994` (88/100) after four rounds of fixes.
- Live QA once the bot is in the test server with Message Content enabled, then the staging end-to-end pass.

### PR 4: interactions, files, reactions
- Status-message stop button; reaction and member intents when their features land.
- Inbound attachments only from Discord's CDN hosts into `stageBlob`; outbound uploads within the server limit, otherwise a QM file link.
- `[[react: …]]` directives and inbound reactions on messages the bot has a stake in.
- Private replies: ephemeral for interactions, DM otherwise.

### PR 5: directory, hand-offs, admin, docs
- Channel audience: the requester plus linked members who can view the channel (needs the GuildMembers intent).
- Channel directory push with `discord:` ids; people come from QM links, not a Discord roster.
- `reach` and principal deliveries target the configured platform.
- Pinned model header and channel topic.
- Admin install page (stored bot token) and linked-accounts view.
- Operator docs: this file, plus what Discord cannot do (email lookup, group DMs, acting as the user, Slack's AI pane, Slack Connect external access, HTTP events).

## Verification

- Tests through real paths with a fake Discord REST client and gateway, in the style of `test/slack-*.test.ts`; each bug-fix test fails on old code.
- Locally: affected tests, `npm run typecheck`, lint. CI runs the full suite.
- Live QA in the developer's Discord test server: link from a DM prompt, DM conversation, mention to thread to unprompted follow-up, approval button, file round trip, unlinked user sees only the prompt, deactivated user refused. The OAuth link step needs a public portal, so the final end-to-end pass runs on the Fly staging app with its callback registered in the Discord app.
- Per PR: an independent fresh-context review and the Wall of shame lens reviews recorded in the PR description.
