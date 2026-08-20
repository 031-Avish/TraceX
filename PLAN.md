# TraceX — Agentic Rebuild Plan

Working plan for turning the current fixed-pipeline demo into an actual agent, on top of
Azure OpenAI (Azure AI Foundry), scoped for a 22-hour hackathon submission.

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
- **Model**: Azure AI Foundry / Azure OpenAI, not Claude. Built as a swappable client so
  switching models later is a one-file change.

## Phase 1 — Fixed pipeline → real tool-calling agent

Scope: single demo tenant (still the acme-payment-service setup), but the *decision logic*
becomes real — the model chooses which tools to call and when it has enough evidence,
instead of the code always fetching all six data sources.

- [x] `lambda-agent/package.json` — drop `@anthropic-ai/sdk`, add `openai` (Azure-capable SDK) + `dotenv`
- [x] `lambda-agent/src/engine/llm-client.js` — Azure OpenAI chat-completions wrapper (tools, usage tracking, cost estimate). This is the *only* file that knows about Azure — swapping providers later touches only this file.
- [x] `lambda-agent/src/engine/tools.js` — wraps the existing collectors (`cloudwatch-logs`, `cloudwatch-metrics`, `github-commits`) as JSON-schema tool definitions the model can choose to call, plus a terminal `submit_triage_brief` tool that forces structured output (replaces the old regex-based `_extractSection` parsing entirely). Also added `get_commit_diff` so the agent can drill into a specific commit's code change, not just the message.
- [x] `lambda-agent/src/engine/agent-loop.js` — the actual ReAct-style loop: call model → model picks tool(s) or finalizes → execute → truncate/sanitize result → feed back → repeat, bounded by `AGENT_MAX_TURNS` (default 6) and a wall-clock budget (`AGENT_WALL_CLOCK_BUDGET_MS`, default 65s — Lambda has 90s total). Falls back to a "manual review needed" brief instead of erroring if the budget/turns run out or the model never calls a tool.
- [x] `lambda-agent/src/handler.js` — replaced the fixed `Promise.all` fan-out with the agent loop
- [x] `lambda-agent/src/engine/triage-engine.js` — removed (superseded by `llm-client.js` + `agent-loop.js`)
- [x] `lambda-agent/src/slack/slack-notifier.js` — added an "Investigation Path" block showing which tools the agent actually chose to call, in order (e.g. `get_deployment_logs → get_error_logs → get_commit_diff → submit_triage_brief`) — this is the visible proof-of-agency for the demo/judges. Also updated the "Pipeline" footer line since the old collection-vs-analysis timing split no longer applies (turns are interleaved now).
- [x] `terraform/agent.tf`, `terraform/variables.tf`, `terraform/terraform.tfvars.example` — swapped `anthropic_api_key` for Azure OpenAI vars (`azure_openai_endpoint`, `azure_openai_api_key`, `azure_openai_deployment`, `azure_openai_api_version`). Also fixed pre-existing invalid HCL (semicolon-separated single-line blocks) in `variables.tf` that `terraform validate` would have choked on.
- [x] `lambda-agent/.env.example` — local dev env template (never committed — `.gitignore` already excludes `.env`)
- [x] `lambda-agent/test/test-agent-local.js` — local harness to run the full agent loop against real AWS/GitHub/Slack without deploying, using a mock SNS event
- [ ] Run a real local test once Azure credentials are available (`node test/test-agent-local.js`), confirm `tool_calls` come back correctly for the actual deployment — **this is the one thing I can't verify myself**, needs real Azure/AWS/Slack credentials

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

## Phase 3 — Submission polish

- [x] Update `README.md` — rewritten end to end: corrected architecture diagram (was still showing
  Claude + the old fixed pipeline), GTM framing up top (customer-configured, not Presidio-internal —
  matches the eligibility reasoning from the top of this file), a full Security & Governance
  section, updated Quick Start (Azure OpenAI vars + console setup step), updated demo script and
  project structure to include `lambda-config-api/`, `console/`, and the new `engine/`/`config/`
  files.
- [ ] Record demo video
- [ ] Final pass: confirm no secrets anywhere in the repo before the push (submission stays on
  GitHub per the user's call — GitLab migration deferred to later, not blocking)
