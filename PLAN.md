# TraceX — Agentic Rebuild Plan

Working plan for turning the current fixed-pipeline demo into an actual agent, on top of
OpenRouter, scoped for a 22-hour hackathon submission.

Update this file's checkboxes as sections land — it's the running log of what's actually
been built vs. still planned, so anyone picking up the repo mid-build knows the state.

## Why this rebuild (context, not just code)

- **Eligibility**: the original proposal pitched this as a Presidio-internal NOC tool. The
  hackathon rules disqualify internal-use-only ideas. Reframe: this is a product a **customer**
  self-configures (brings their own CloudWatch/GitHub/Slack), not something Presidio's NOC
  runs on the customer's behalf. That reframe is *why* the connector-config layer in Phase 2
  isn't optional polish — it's what makes the idea eligible.
- **Theme**: submitting under **Security and Governance at Scale** (multi-tenant credential
  isolation, least-privilege read-only connectors, PII stripping before any LLM call,
  human-approval-gated remediation). **Data for AI** as the secondary angle.
- **Workflow → agent**: judging includes Engineering Excellence & Vision and Creativity &
  Innovation. A hardcoded `Promise.all([logs, metrics, commits])` run identically for every
  incident doesn't hold up under either — and doesn't scale to "whatever the customer
  connected" anyway. The agent has to decide which tools exist for this tenant and which
  ones this incident actually calls for.
- **Model gateway**: OpenRouter with a configurable tool-capable model. Built as a swappable client so
  switching models later is a one-file change.

## Phase 1 — Fixed pipeline → real tool-calling agent

Scope: single demo tenant (still the acme-payment-service setup), but the *decision logic*
becomes real — the model chooses which tools to call and when it has enough evidence,
instead of the code always fetching all six data sources.

- [x] `lambda-agent/package.json` — use the `openai` SDK against OpenRouter's compatible endpoint + `dotenv`
- [x] `lambda-agent/src/engine/llm-client.js` — OpenRouter chat-completions wrapper (tools, usage tracking, cost estimate). This is the provider boundary.
- [x] `lambda-agent/src/engine/tools.js` — wraps the existing collectors (`cloudwatch-logs`, `cloudwatch-metrics`, `github-commits`) as JSON-schema tool definitions the model can choose to call, plus a terminal `submit_triage_brief` tool that forces structured output (replaces the old regex-based `_extractSection` parsing entirely). Also added `get_commit_diff` so the agent can drill into a specific commit's code change, not just the message.
- [x] `lambda-agent/src/engine/agent-loop.js` — the actual ReAct-style loop: call model → model picks tool(s) or finalizes → execute → truncate/sanitize result → feed back → repeat, bounded by `AGENT_MAX_TURNS` (default 6) and a wall-clock budget (`AGENT_WALL_CLOCK_BUDGET_MS`, default 65s — Lambda has 90s total). Falls back to a "manual review needed" brief instead of erroring if the budget/turns run out or the model never calls a tool.
- [x] `lambda-agent/src/handler.js` — replaced the fixed `Promise.all` fan-out with the agent loop
- [x] `lambda-agent/src/engine/triage-engine.js` — removed (superseded by `llm-client.js` + `agent-loop.js`)
- [x] `lambda-agent/src/slack/slack-notifier.js` — added an "Investigation Path" block showing which tools the agent actually chose to call, in order (e.g. `get_deployment_logs → get_error_logs → get_commit_diff → submit_triage_brief`) — this is the visible proof-of-agency for the demo/judges. Also updated the "Pipeline" footer line since the old collection-vs-analysis timing split no longer applies (turns are interleaved now).
- [x] `terraform/agent.tf`, `terraform/variables.tf`, `terraform/terraform.tfvars.example` — configure the OpenRouter key and model, with a deprecated alias for existing local configuration.
- [x] `lambda-agent/.env.example` — local dev env template (never committed — `.gitignore` already excludes `.env`)
- [x] `lambda-agent/test/test-agent-local.js` — local harness to run the full agent loop against real AWS/GitHub/Slack without deploying, using a mock SNS event
- [ ] Run a real local test once OpenRouter/AWS/Slack credentials are available (`node test/test-agent-local.js`) and confirm tool calls for the selected model

All Phase 1 files pass `node --check` and `terraform validate` (syntax-level — `validate` itself needs `terraform init` for providers, not run here since it's a network op).

## Phase 2 — Self-service connector config (the eligibility-critical part)

Scope: prove a customer can configure their own tool connections, not just that the agent
is smart. Minimal but real — not mocked screens.

- [x] `lambda-agent/src/config/connector-registry.js` — per-tenant connector config (DynamoDB-backed). `handler.js` calls this first and falls back to the original env-var defaults if nothing's configured yet, so the existing acme-payment-service demo still works untouched.
- [x] `terraform/connectors.tf` — DynamoDB table (`presidio-connector-registry`, single-table design: `pk=tenantId`, `sk=CONNECTOR#<type>` or `APP#<appId>`), IAM read access for the agent Lambda, and a new `presidio-config-api` Lambda (full CRUD) behind its own API Gateway HTTP API with CORS enabled
- [x] `lambda-config-api/` — the CRUD API backing the console: `GET/PUT /connectors`, `DELETE /connectors/{type}`, `GET/PUT /applications`, `DELETE /applications/{appId}`. Secrets are never echoed back to the browser after saving (masked to `••••••••1234`), and a blank token on an edit means "keep existing" rather than wiping it — handled via a read-modify-write in `putConnector`.
- [x] `console/` — single self-contained page (no build step, no framework): 3 connector cards (GitHub, Slack, Datadog stubbed as "coming soon"), an Applications list mapping an app (matched by the alarm's `service` name) to its CloudWatch log group/namespace/alarm plus optional per-app repo/channel overrides. *(Superseded by the React rebuild in Phase 2.5 below — kept here as the historical record of what shipped first.)*
- [x] `lambda-agent/src/collectors/github-commits.js`, `lambda-agent/src/slack/slack-notifier.js` — both now accept an optional per-tenant config object (token/owner/repo, token/channelId) instead of only reading fixed env vars, so the registry path is real, not decorative
- [x] `deploy.sh` — prints the `config_api_url` output after deploy, with a reminder to configure the console before running the demo
- [x] `terraform validate` passes end-to-end (ran a real `terraform init` to confirm, not just HCL syntax)
- [ ] Deploy for real once AWS credentials are available and click through the console against a live API — same caveat as Phase 1, needs real credentials I don't have

### Credential storage hardening (added after a direct question about it)

Initial cut stored connector tokens as plaintext DynamoDB attributes, protected only by
DynamoDB's default SSE (AWS-owned key — no dedicated key policy, no distinct audit trail).
Fixed:

- [x] `terraform/connectors.tf` — added a dedicated customer-managed KMS key (`aws_kms_key.connector_secrets`, rotation enabled) instead of relying on the AWS-owned default
- [x] `lambda-config-api/index.js` — tokens now go to Secrets Manager (`presidio-connector/<tenantId>/<type>`), encrypted with that key. DynamoDB holds only non-sensitive metadata (repo owner/name, channel ID) + a `secretRef` pointer. A blank token on an edit means "keep existing" — no more read-modify-write against Dynamo to preserve it, since the metadata write and the secret write are now separate concerns.
- [x] `lambda-agent/src/config/connector-registry.js` — fetches the token from Secrets Manager at investigation time using the stored `secretRef`, never persists it beyond that request's memory
- [x] IAM tightened to match: `config-api` role can `CreateSecret`/`PutSecretValue`/`DeleteSecret` scoped to `presidio-connector/*` only; `agent` role can only `GetSecretValue` on the same path; both get `kms:*` scoped to the one dedicated key, not `kms:*` on everything

**Stated limitation, not hidden**: the agent Lambda still sees the plaintext token at investigation time (it has to, to call GitHub/Slack on the customer's behalf) — true zero-knowledge isn't achievable for this feature. The security boundary here is dedicated encrypted storage + least-privilege IAM + a distinct CloudTrail audit trail on every decrypt, not "the backend never sees it."

**Known scope cut, stated explicitly rather than hidden**: no auth on the config console or API itself, one shared KMS key/table rather than a key per tenant, and CloudWatch access still relies on the agent Lambda's own same-account IAM role rather than real cross-account AssumeRole. All three are exactly what the original proposal doc lists as "Out of Scope (Production Roadmap)" — correct to cut for a hackathon demo, wrong to ship without saying so out loud. Worth a line in the README and possibly the demo video.

## Phase 2.5 — Flow validation pass + React console rebuild

Prompted by a direct question about how "important info only" was actually being enforced —
worth re-reading the code rather than trusting the earlier claim.

- [x] **Real bug fixed** in `agent-loop.js`: `_truncate()` was slicing the *serialized JSON string*
  to the first N characters. Collector results are chronological (oldest first), so this kept the
  oldest, least relevant log lines and could silently drop the most recent one — often the actual
  smoking-gun FATAL entry. Fixed with `_limitArrays()`, which caps any array in the tool result to
  its most recent `MAX_ARRAY_ITEMS` (default 20) *before* stringifying, so volume is controlled by
  keeping the right data, not by truncating wherever the string happened to end. `_truncate()` is
  now just a backstop for pathological single-field sizes, not the primary mechanism. This also
  fixes `get_commit_diff`'s previously-uncapped `files` array for free (same generic fix).
- [x] **Real gap fixed** in `tools.js`: the file's own docstring claimed "a tenant with no GitHub
  connector configured doesn't get a get_recent_commits tool offered" — but the code always offered
  all 6 tools regardless of credentials. A tenant without GitHub configured could still have the
  agent "choose" `get_recent_commits`, burn a turn, and get back a guaranteed failure. Tool schemas
  are now filtered by `githubAvailable` (checked from the resolved tenant config or the env var
  fallback), and the corresponding executors aren't registered either — so the model literally
  cannot see or call a tool it has no credentials for.
- [x] Rebuilt `console/` as a proper React app (Vite + React Router) instead of the single static
  HTML file — `npm install && npm run build` both verified clean. Pages: Overview (connection status
  summary), Connectors (view/edit GitHub + Slack, Datadog stubbed), Applications (list with real
  Edit — not just re-add — plus Add/Cancel), Settings (API URL + tenant ID, persisted to
  localStorage). `deploy.sh`'s printed instructions updated to match (`npm run dev` instead of
  "open index.html").
- [x] **UI workflow fix — CloudWatch moved to Integrations**: CloudWatch was previously selected
  via a per-app "Observability provider" dropdown in the Applications page, which made it look like
  an application-level choice rather than a first-class integration. Fixed across three files:
  `console/src/connectors.js` — `cloudwatch` added as the first entry in the Observability category
  with a `region` field (no credentials — IAM-based); `console/src/pages/ApplicationsPage.jsx` —
  removed `observabilityProvider` dropdown entirely, restructured the form into labelled scope
  sections (CloudWatch scope, Datadog scope, per-app overrides) so the app form configures *which*
  resources within a connected integration, not *which* provider to use;
  `console/src/pages/OverviewPage.jsx` — `cloudwatch` added to the connector status summary so
  its connected state is visible on the Overview. Build verified clean (`npm run build`).

## Phase 2.6 — PII sanitization gap (found by asking "are we actually removing PII?")

Traced every call site of `sanitize()` — turned out to be exactly one: tool results going into the
model, in `agent-loop.js`. Two real gaps followed from that:

- [x] **Inbound gap**: the incident summary (alarm name/description, built directly in
  `_incidentSummary()`) bypassed the sanitizer entirely — it's pushed straight into `messages`
  without going through the same choke point as tool results. Low risk with our synthetic demo
  data, but `AlarmDescription` is operator-authored free text in production, not guaranteed clean.
  Fixed: `_incidentSummary()` now sanitizes its own output before returning it.
- [x] **Outbound gap (the bigger one)**: `slack-notifier.js` never imported or called `sanitize()`
  at all. Even with clean inputs, the model's own generated text (`rootCause`, `timeline`,
  `financialImpact`, `remediation`) went straight to Slack with zero scrubbing — and Slack is a
  *more* exposed surface than the LLM call itself (searchable, exportable, seen by more people than
  the on-call engineer). Fixed: all four fields are sanitized immediately in `postTriageBrief`
  before being used in any Block Kit content — belt-and-suspenders, not relying on "the input was
  already clean" as the only control.
- [x] `sanitizer.js` — added a phone number pattern (was missing entirely). Required separators
  (dash/dot/space) specifically to avoid colliding with plain digit sequences that are everywhere
  in this domain — trace IDs, revenue figures, task revisions. Verified against real sample strings
  (see below) — redacts phone/email/IP/SSN/card/AWS-key/generic-token correctly, zero false
  positives on `traceId`, `failedTransactions`, `estimatedRevenueImpactPerHour`, or
  `taskDefinition:...:47`.
- [x] Confirmed no real PII (the user's own email, etc.) leaked into any repo file — everything is
  synthetic demo data (`Acme Corp`, `dev-jsmith`, placeholder tokens).

## Phase 2.7 — Source confidence + injection hardening

Motivated by the same audit approach as Phase 2.6: trace every path where user-controlled
data reaches the LLM and ask whether Claude can distinguish ground-truth AWS telemetry from
free-form user text. The sanitizer handles PII; this phase handles adversarial instructions
embedded in data — a different attack class entirely.

- [x] `lambda-agent/src/utils/confidence-scorer.js` — deterministic (no LLM call, no added
  latency, no new npm dependencies) confidence labeler. Assigns a base score per tool:
  `get_alarm_details`/`get_service_metrics` → CRITICAL (0.95), `get_error_logs` → HIGH (0.85),
  `get_deployment_logs` → HIGH (0.80), `get_commit_diff` → MEDIUM (0.65),
  `get_recent_commits` → LOW (0.45). Valid-JSON structure adds a +0.05 bonus.
  If an injection pattern is detected, confidence drops to 0.05 and the data field is
  replaced with `[QUARANTINED]`. Covers three injection vectors: commit message text,
  code comment injection in diffs (e.g. `// ignore previous instructions`), and
  token-stuffing patterns (`[INST]`, `<|...|>`, `### System`).
- [x] `lambda-agent/src/engine/agent-loop.js` — wired `applyConfidenceLabel(name, sanitized)`
  between the sanitize and `_truncate` steps, so every tool result reaching Claude is wrapped
  in a `{ _tracex_meta: { source, confidence, trust_level, guidance }, data }` envelope.
  The `_tracex_meta` block appears at the front of the serialized string and survives
  `_truncate()` even on large payloads. Updated `_systemPrompt()` to explain trust levels
  so Claude knows CRITICAL/HIGH sources dominate, LOW sources cannot be sole root cause,
  and SUSPECT results must be discarded entirely.

Defense-in-depth context (no single layer is sufficient on its own):
  1. Tool filtering (Phase 2.5) — unconfigured GitHub means no commit tool → zero commit injection surface
  2. `_limitArrays` (Phase 2.5) — caps to 20 items, limiting attacker-controlled text volume
  3. Injection pattern detection (this phase) — quarantines common adversarial patterns
  4. System prompt framing (this phase) — Claude cannot conclude from LOW-trust evidence alone
  5. Sanitizer on Slack output (Phase 2.6) — PII can't leak even in Claude's generated text

## Phase 3 — Submission polish

- [x] Update `README.md` — rewritten end to end: corrected architecture diagram (was still showing
  Claude + the old fixed pipeline), GTM framing up top (customer-configured, not Presidio-internal —
  matches the eligibility reasoning from the top of this file), a full Security & Governance
  section, updated Quick Start (OpenRouter vars + console setup step), updated demo script and
  project structure to include `lambda-config-api/`, `console/`, and the new `engine/`/`config/`
  files.
- [ ] Record demo video
- [ ] Final pass: confirm no secrets anywhere in the repo before the push (submission stays on
  GitHub per the user's call — GitLab migration deferred to later, not blocking)

## Phase 4 — ShopCo demo environment (separate repo)

A realistic multi-service "client" environment for TraceX to investigate, built in a separate
repo (`github.com/031-Avish/shopco-platform`) per `CLIENT_ENV_PLAN.md`. Kept fully separate from
this repo deliberately — it's meant to look like a real customer's own engineering repo, not
TraceX's own code, so it can't reference this repo, this plan, or anything demo-specific without
undermining the whole point of the exercise.

- 4 services (order/payment/inventory/notification), real inter-service HTTP calls, traceId
  propagation, structured logging — all real, working code
- 24-commit history spanning ~30 days, infra and application commits interleaved by date (not
  infra as one commit at the end) — no branches/PRs, since the agent's `get_commit_diff`/
  `get_recent_commits` tools only read `git log`, blind to whether history came through a PR
- The "bad commit" is real, tagged `v2.4.1-hotfix`, diff verified with `git show --stat` after
  every rewrite: removes a null-safety check in `payment-service`, replaced with unsafe
  `currency.toUpperCase()`/`amount.toFixed()` calls that throw a real `TypeError` on null input
- All 3 chaos scenarios (payment outage, inventory exhaustion, cascading order+payment failure)
  are actually wired to SSM parameters in the application code, not just present in the plan doc
- Terraform: one Lambda + API Gateway per service, IAM scoped per-service, alarms wired to
  *this* repo's real SNS topic (the one hard dependency between the two stacks) — verified with
  a real `terraform plan` against live AWS credentials, 59 to add, 0 errors. Not yet `apply`'d.
- **Grafana dropped in favor of Datadog** for the second observability source — Datadog already
  has a working collector on this side (`lambda-agent/src/collectors/datadog.js`); Grafana would
  have needed a new collector plus a CloudWatch→Loki forwarder built from scratch, and a Grafana
  Cloud account that needs manual signup either way.
- Caught and scrubbed several places where the ShopCo repo's own comments/CI-workflow leaked
  that it was a staged demo (e.g. a CI file literally saying "not a real workflow, part of the
  ShopCo narrative") — worth double-checking any future additions there for the same thing, since
  the whole value of that repo is looking like a real, independent customer environment.
- Not yet done: Datadog account signup (manual, not automatable), registering the 4 apps in this
  repo's console, the `break-*.sh`/`heal-all.sh` scripts, actually deploying either stack for real.
