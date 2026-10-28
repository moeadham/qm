# Upstream merge regression checklist

Use this checklist whenever this fork pulls a new QM release or a substantial
upstream change. It consolidates the intentional fork behavior and production
failures recorded in the source and deployment Git histories through
2026-10-28.

Do not promote an upgrade because it compiles. Preserve each behavior below,
run its automated checks, and exercise the user-visible paths in staging.

## Downstream behavior to preserve

### Personal Claude and Codex subscriptions

- [ ] A user can connect Claude and Codex at the same time.
- [ ] Connecting, reconnecting, refreshing, or disconnecting one provider does
      not modify or revoke the other provider.
- [ ] Settings shows every connected personal provider as available, with an
      independent status and Reconnect action.
- [ ] Existing provider credentials survive an upgrade and browser reload.
- [ ] Credential refresh/replacement/deletion is serialized across core
      instances. A stale refresh must not overwrite a newer token or revive a
      credential that was disconnected.
- [ ] Legacy Codex records without explicit expiry metadata infer expiry from
      the access-token JWT and refresh normally.
- [ ] Provider refresh errors are visible and do not first delete a still-usable
      credential.

Past failures:

- Connecting Claude made Codex disappear, and connecting Codex made Claude
  disappear.
- Reconnect used a legacy exclusive provider preference and silently filtered
  out the other account.
- Concurrent refresh/reconnect operations overwrote newly rotated tokens.
- Scheduled and ordinary Codex turns reached the Responses API without a
  bearer token and failed with `401 Unauthorized: Missing Bearer ... in header`.
- Old Codex device-login records had no expiry metadata and did not refresh.

Automated checks:

```sh
node --experimental-test-module-mocks --test \
  test/subscription-reconnect.test.ts \
  test/codex-device-login.test.ts \
  test/personal-model-account.test.ts \
  test/subscription-model-turn.test.ts

cd plugins/web-ui
NODE_ENV=test ALLOW_UNSIGNED_TEST_IDENTITY=1 node --test \
  test/model-connect-interactions.test.ts \
  test/runtime-config-sync.test.ts \
  test/runtime-config-views.test.ts
```

Staging acceptance:

- [ ] Connect both real subscriptions, then reconnect Claude and verify Codex
      still replies.
- [ ] Reconnect Codex and verify Claude still replies.
- [ ] Reload Settings and a chat; both providers remain connected and usable.
- [ ] Check core logs for the expected provider auth kind without printing any
      token.

Source landmarks: `7ffc3c99`, `f7c79b80`, `2f6e6071`, `33fa1c89`.

### Subscription model catalog, picker, and routing

- [ ] Personal subscription chats expose the models allowed by the connected
      account, not only the scope/company default.
- [ ] Claude and Codex model lists remain current and are backed by runtime
      versions new enough to run them.
- [ ] The selected harness, model, and effort survive reload, restoration,
      `app.turn`, and default-runtime resolution.
- [ ] An exact explicit selection is routed to that provider. It must not be
      rewritten to the scope default or a similarly named company model.
- [ ] Unsupported or unavailable models fail closed with a useful error.
- [ ] Cron creation/editing validates an explicit model against the owner's
      subscription, not only company access.
- [ ] At minimum, verify every model this fork advertises, including current
      Claude models and GPT-6 Astra/Sol/Luna while they remain supported.

Past failures:

- GPT-6 Astra and other current Codex models were absent from the picker even
  though the subscription and CLI supported them.
- Restored chats lost their saved model after runtime configuration loaded.
- A merged upstream catalog reintroduced incompatible/bare model mappings.
- An old Claude Code build rejected a newly advertised model and required an
  upgrade.
- A cron accepted a model choice in the UI but later substituted the scope
  default or failed account-compatibility checks.

Automated checks:

```sh
node --experimental-test-module-mocks --test \
  test/subscription-runtime-config.test.ts \
  test/subscription-model-turn.test.ts \
  test/personal-model-account-execution.test.ts \
  test/pi-models.test.ts \
  test/pi-codex-subscription.test.ts
```

Staging acceptance:

- [ ] Start fresh Claude and Codex chats with non-default models and get a real
      reply from each.
- [ ] Reload both chats and confirm the displayed and executed model is
      unchanged.
- [ ] Run a model-version smoke test for every newly added catalog entry before
      advertising it.

Source landmarks: `8ae4a0e7`, `a6c69203`, `f9e12eda`, `7eb53867`, `95fdb652`,
`20ca7564`.

### Owner authentication for automation and background work

- [ ] Owner-created crons, monitors, and background-command watches can use the
      owner's personal subscription.
- [ ] The owner identity is carried through trigger creation, queueing, retry,
      and automatic follow-up turns.
- [ ] Explicit automation harness/model choices survive `app.turn` and are
      resolved before credential routing.
- [ ] Scope-floor runs and untrusted/public inputs cannot borrow an owner's
      personal credential.
- [ ] Web-delivered schedules are allowed when the conversation has a valid web
      destination; the system prompt must not claim Slack is always required.
- [ ] A scheduled run performs real work and delivers the result, rather than
      merely creating a successful cron record.

Past failures:

- Cron and manual retry both failed before work began with `401 Unauthorized:
Missing Bearer ...` from `https://api.openai.com/v1/responses`.
- Background command wakes inherited Codex but used company authentication, so
  both the initial wake and follow-up failed.
- Non-web subscription turns dropped the requested harness/model and ran the
  scope default.
- The gateway told agents that web conversations could not receive scheduled
  results even when an existing web delivery destination was valid.
- Cron results that used to remain in the parent conversation appeared as many
  read-only sidebar chats after upstream presentation changes.

Automated checks:

```sh
node --experimental-test-module-mocks --test \
  test/run-trigger.test.ts \
  test/run-trigger-home-scope.test.ts \
  test/subscription-model-turn.test.ts \
  test/gateway-context.test.ts
```

Staging acceptance:

- [ ] Create one Codex and one Claude scheduled run in scopes whose defaults use
      the opposite provider.
- [ ] Exercise an automatic follow-up/background wake.
- [ ] Confirm owner auth and exact model in logs, successful web delivery, and
      no `Missing Bearer` response.
- [ ] Confirm the resulting conversation placement/read-only behavior is still
      acceptable in the sidebar.

Source landmarks: `8cdea776`, `32308ce4`, `e1c2742f`, `57909074`, `20ca7564`.

### Persistent cross-harness subagents and skills

- [ ] A Claude parent can open a persistent Codex child with an explicit model,
      and a Codex parent can open a Claude child.
- [ ] Child creation and follow-ups use the owner's matching subscription.
- [ ] The child's explicit harness/model is applied before credential routing.
- [ ] Parent/child sessions persist, follow-ups reach the same child, and an
      idle parent wakes when the child completes.
- [ ] Skill tool schemas remain correct: use `task` for open/follow-up calls and
      `text` for messages where required by the installed QM version.
- [ ] Strict read-only children do not receive file, shell, browser, or secret
      capabilities; the parent relays source when needed.
- [ ] Human review/import/merge/deploy gates in the Add Model skill remain in
      place.

Past failures:

- Delegated sessions did not inherit owner subscription authentication.
- The requested child provider/model was resolved too late and routed with the
  parent's or scope's credential.
- Idle parents did not automatically resume after a child completed.
- Skill calls used the wrong field name (`text` versus `task`).

Automated checks:

```sh
node --experimental-test-module-mocks --test \
  test/session-syscalls.test.ts \
  test/subscription-model-turn.test.ts
```

Staging acceptance:

- [ ] Run the Add Model pattern end to end: Claude implementation, read-only
      Codex adversarial review, follow-up to the same child, parent wake, and
      parent summary.
- [ ] Confirm both child auth kinds in logs and verify the read-only boundary.

Source landmark: `45c98118`.

### Email sign-in and invitations

- [ ] Login magic links and invitation emails use the same configured email
      transport.
- [ ] Both SMTP and Resend configurations remain supported; invitations must
      not require `RESEND_API_KEY` when valid SMTP is configured.
- [ ] Shared email configuration exports remain available to auth, core, CLI,
      and secret-contract validation.
- [ ] The sender address, SMTP host/port/TLS mode, username, and secret mapping
      reach every workload that sends mail.
- [ ] Accepting an invitation produces a durable teammate eligible for future
      magic-link sign-in; it must not remain an expiring legacy external user.
- [ ] Do not introduce an ad hoc email allowlist as a substitute for fixing
      invitation or sign-in eligibility.
- [ ] Error messages say which transport/configuration is missing without
      exposing secrets.

Past failures:

- Admin invitation failed with “invitation emails are not configured — set
  `RESEND_API_KEY`” while Cloudflare SMTP already sent login mail.
- A shared auth email config export was dropped during the v0.1.15 port.
- An invited user accepted successfully but received no later magic-link email.
- A pre-teammate invitation expired as a legacy external-user record after it
  had been accepted.
- Implicit TLS SMTP worked, but an upstream doctor probe incorrectly attempted
  plaintext and timed out.

Automated checks:

```sh
node --experimental-test-module-mocks --test \
  test/invite-email.test.ts \
  test/admin-external-users.test.ts

cd plugins/auth
node --test 'test/**/*.test.ts'

cd ../portal
node --test test/invite-routes.test.ts
```

Staging acceptance:

- [ ] Send a normal login magic link to an existing teammate.
- [ ] Invite a disposable teammate through the supported admin flow, accept it,
      then request and receive a later login magic link.
- [ ] Verify SMTP acceptance from portal/auth and core without logging message
      bodies, tokens, or credentials.

Source landmarks: `514e6305`, `3e3400b1`, `d151e710`.

### Portal login and workspace routing

- [ ] The portal issuer, callback URL, cookie/session keys, and public URL agree
      with the deployed hostname.
- [ ] A requested magic link can be opened once and establishes the intended
      user, organization, and workspace membership.
- [ ] A failed or expired login attempt returns the user to a fresh login flow;
      it must not loop on stale OAuth state.
- [ ] Workspace routing discovery carries valid service authorization between
      portal, web, and core.
- [ ] Login/session state survives a normal service restart and rolling deploy.
- [ ] Portal and web private addresses/routes remain the ones recorded by the
      deployment; an upstream CLI network-discovery change must not silently
      replace or omit them.

Past failures:

- Mobile login ended at `invalid login state` after the authorization callback.
- Users requested a magic link from `/auth/login` but no message arrived even
  though an earlier invitation had been accepted.
- An agent received `workspace routing discovery unauthorized (401)`.
- The portal briefly appeared down during deployment and login-email incidents;
  service health, routing, and mail delivery need to be diagnosed separately.

Staging acceptance:

- [ ] Sign in from a clean private-browser session using an emailed link.
- [ ] Repeat after restarting portal/auth and core.
- [ ] Open a project chat and confirm workspace discovery plus a real agent
      reply, rather than stopping at successful portal authentication.

### Streaming speech dictation

- [ ] Authenticated web users can dictate through the configured AllModels
      realtime speech provider; anonymous users cannot obtain speech config.
- [ ] Audio streams directly from the browser and is not stored by QM.
- [ ] The current microphone can be selected while recording.
- [ ] The waveform, provisional text, final text, Stop, Send, and Cancel states
      remain visually and behaviorally distinct.
- [ ] Stop finalizes into an editable draft. Send finalizes and submits exactly
      once. Duplicate clicks do nothing.
- [ ] Send remains available during recording and finalization.
- [ ] Cancel is available during startup/recording but hidden while Stop or Send
      is finalizing, so it cannot discard a pending final transcript.
- [ ] Switching chats, teardown, or errors abort a pending send safely.
- [ ] Connection interruption preserves the latest partial words in the draft;
      explicit Cancel discards unfinished words.
- [ ] There is no local 120-second cutoff or cumulative 8 MiB cap. Network
      backlog, missing-audio, and provider-session safeguards remain.
- [ ] Existing approval/blocked-input guards still prevent dictation where text
      input is disallowed.
- [ ] CSP permits only the required realtime speech endpoint.

Past failures:

- The composer disabled Send while dictating.
- Finalization allowed Cancel, causing toolbar movement and a transcript-loss
  race.
- A two-minute timer and cumulative byte cap stopped valid long dictation.
- Network interruption discarded partial words.
- Microphone selection and Stop feedback were missing or inconsistent.
- Repeated final/partial events could duplicate words or submissions.
- Direct speech configuration access and CSP expectations diverged between the
  portal and web UI.

Automated checks:

```sh
cd plugins/web-ui
NODE_ENV=test ALLOW_UNSIGNED_TEST_IDENTITY=1 node --test \
  test/composer-speech.test.ts \
  test/speech-input.test.ts \
  test/speech-server.test.ts \
  test/speech-to-text-route.test.ts \
  test/speech-waveform.test.ts \
  test/speech-worklet.test.ts \
  test/approval-blocks-input.test.ts \
  test/browser-error-routes.test.ts

cd ../portal
node --test test/playground.test.ts
```

Staging acceptance:

- [ ] Use a real microphone for Stop/edit/Send and one-click Send flows.
- [ ] Run longer than two minutes and stream more than 8 MiB before manually
      stopping.
- [ ] Interrupt the network after a partial transcript and verify words survive.
- [ ] Verify anonymous denial and authenticated `no-store` speech settings.

Source landmarks: `357a3abc`, `4059977c`, `2ccc729d`, `47ef91dc`, `6dc464f5`,
`771b5594`, `1bbcb6ef`.

### Deployment, sandbox, database, and integrations

- [ ] Production builds have enough Node heap for the web bundle.
- [ ] Test fakes move sandboxes portably across hosts/filesystems.
- [ ] Production dependency advisories are reviewed after every merge; do not
      assume a previously clean audit is still clean.
- [ ] Core remains sized for the configured worker count. Do not raise worker
      concurrency without checking memory, queue behavior, and Fly restarts.
- [ ] Sandbox resource inventory/routing remains enabled. A failed Sprite can be
      replaced per scope without deleting its disk before recovery is assessed.
- [ ] The shared agent Postgres credential remains an organization grant using
      the restricted `qm_agents` role/schema, not the QM application role.
- [ ] Eligible internal agents receive `SHARED_DATABASE_URL` and CA material;
      external-participant and strict read-only sessions do not.
- [ ] GitHub credentials remain brokered and granted to the intended scope.
      Test clone, branch, push, and PR creation; do not treat an ungranted global
      token as intermittent authentication.
- [ ] Marketing Discord delivery uses a transport accepted by Discord and can
      decode both plain and `deflate-raw` QM capability payloads.
- [ ] Skills, grants, scoped sandbox defaults, and email secrets survive the
      deployment. A source/image upgrade must not silently replace database
      configuration.

Past failures:

- Web image build exhausted the default Node heap.
- A fake sandbox rename crossed host/filesystem boundaries and failed.
- Too many concurrent workers overloaded the small core machine.
- A Sprite became permanently unresponsive while status misleadingly reported
  `cold`/`repaired`; checkpoint lookup also failed.
- Agents lacked Postgres because the credential/grant was absent, not because
  the database itself was down.
- GitHub access looked flaky when the broker token was not actually available
  to the session's scope.
- Discord rejected Python `urllib` with Cloudflare HTTP 403/1010, and the skill
  misread compressed capability tokens as ordinary JWT payloads.
- A short Fly private-network/Postgres timeout burst occurred during staging;
  distinguish infrastructure transients from application regressions.

Source/deployment landmarks: `d1cd4e80`, `83517c74`, `3d08dca9`; deployment
commits `2733304`, `bff109b`, `d8da4e9`, `b26a269`, `09dff51`.

## Required merge gates

### Before resolving conflicts

- [ ] Record the old fork commit, upstream tag/commit, database migration level,
      deployed image digests, and rollback images.
- [ ] Back up PostgreSQL and verify the backup can be listed/restored.
- [ ] Inventory active secrets, credential grants, skills, schedules, sandbox
      resources/defaults, service sizing, and delivery destinations by name only.
- [ ] Read upstream release notes and diffs for auth, credentials, model routing,
      triggers, sessions/subagents, mail, web composer, migrations, and deploy
      images.
- [ ] Search upstream for equivalents of every downstream patch. Remove a fork
      patch only after proving upstream preserves the same caller-visible
      behavior.

### Automated qualification

- [ ] `npm ci` on the supported Node version.
- [ ] `npm run format:check`
- [ ] `npm run typecheck`
- [ ] `npm run typecheck:contract`
- [ ] `npm run lint`
- [ ] `npm run lint:ox`
- [ ] `npm run test:root:shard:check`
- [ ] `npm test`
- [ ] `npm run test:pg` against disposable PostgreSQL.
- [ ] `npm test --prefix plugins/web-ui`
- [ ] `npm run typecheck --prefix plugins/web-ui`
- [ ] `npm test --prefix cli`
- [ ] Run all affected plugin suites.
- [ ] `npm run audit:prod` at the root and production audits in independently
      deployed packages such as web UI and connector SDK.
- [ ] Build the exact core/web/portal images that staging will run.

Run the full suite on the high-memory Linux test host rather than a developer
laptop. Do not weaken or skip a failing check merely to obtain a green build;
record any accepted upstream failure explicitly.

For a fresh disposable Ubuntu host, copy and run
`scripts/bootstrap-linux-qualification-host.sh`. Pin `QM_EXPECTED_SHA` to the
candidate under test. The script installs the CI toolchain, checks out that
exact public revision, starts the same pgvector/PostgreSQL image used by CI,
installs all workspace dependencies, builds the CLI contract export, and writes
the disposable database environment to its private results directory. It never
copies production secrets or data and intentionally leaves test execution to
this checklist.

### Staging qualification

- [ ] Use an isolated staging deployment and database. Never point qualification
      at production data or production delivery destinations.
- [ ] Apply migrations, restart every workload, and check health/readiness plus
      crash/restart logs.
- [ ] Verify storage round-trip, a private live agent turn, and sandbox exec/file
      persistence.
- [ ] Complete the live checks in every feature section above.
- [ ] Exercise at least one real cron and one background/monitor follow-up.
- [ ] Verify email invitation plus later magic-link login.
- [ ] Verify GitHub clone/push/PR and Discord delivery with disposable targets.
- [ ] Leave staging running long enough to catch token refresh, queue, worker,
      and memory failures rather than testing only first-run success.

### Production promotion

- [ ] Pin the exact immutable images proven in staging.
- [ ] Reconfirm rollback compatibility with any applied schema migrations.
- [ ] Deploy one layer at a time and observe logs/health before continuing.
- [ ] Repeat a minimal canary: login email, both subscriptions, scheduled owner
      auth, private agent/Sprite, storage, and configured delivery.
- [ ] Record the deployed commit/images, test evidence, known exceptions, and
      rollback location in the deployment repository.

## Current v0.1.15 candidate notes (2026-10-28)

These are qualification notes, not permanent exceptions. Resolve them or update
this section with evidence before promoting the current candidate.

- [x] Focused subscription, cron, subagent, and invitation tests passed on the
      remote Fly test runner (69 tests).
- [x] Focused portal tests passed (10 tests).
- [x] Dedicated model verification and development-supervisor regression checks
      passed (25 tests).
- [x] A real staging PostgreSQL advisory-lock probe passed.
- [x] The high-memory Linux runner completed all five root shards after fixing
      merge regressions in personal model fallback/routing, core SMTP secret
      validation, public owner-auth sanitization, dependency expectations, and
      formatting.
- [x] The full PostgreSQL suite plus cross-process swarm and model-overlay tests
      passed against `pgvector/pgvector:0.8.1-pg16`.
- [x] CLI typecheck, unit tests, Terraform end-to-end tests, deployment
      contracts, desktop tests, and all admin/auth/portal plugin suites passed.
- [x] The complete web UI suite (including speech), all web typechecks, and the
      production web build passed.
- [x] Final admin, web UI, auth, and portal production images built and booted.
- [x] Repository format, core/contract typechecks, ESLint, Knip, and Oxlint pass.
- [ ] Complete a live staging acceptance test with both real Claude and Codex
      personal subscriptions; test credentials were intentionally not copied
      into the isolated runner.
- [ ] Complete real-browser speech and login/email acceptance against staging.
- [ ] Resolve or explicitly accept the remaining production audit findings.
      As of 2026-10-28, the root and connector SDK audits are clean. The root
      uses exact security overrides for `body-parser` 2.4.0 and `qs` 6.17.0;
      these are deliberate exceptions to the seven-day package-age policy
      because the production image's mandatory audit otherwise cannot build.
      Web retains five upstream dependency-chain findings with no supported fix
      path (`zod`/LM Studio and KaTeX/mini-lit). The direct critical DOMPurify
      finding was fixed.

## Incident signatures worth searching in logs

```text
Missing Bearer
workspace routing discovery unauthorized
invalid login state
that model isn't available for your connected AI account
does not support this model
invitation emails are not configured
overlay manager not configured
computer isn't responding
HTTP 403/1010
ECONNRESET
ETIMEDOUT
out of memory
JavaScript heap out of memory
```

For any match, determine whether the failure is code, expired/revoked provider
authorization, missing credential grant, sandbox resource health, or transient
infrastructure before applying a workaround.

## Updating this checklist

When a new downstream feature ships or production exposes a new failure mode:

1. Add the expected behavior and the exact failure signature here.
2. Add or identify an automated regression test.
3. Add a live staging check for behavior automation cannot prove.
4. Record the source and deployment commits without including private evidence,
   user data, credentials, tokens, or secret values.
