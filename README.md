# 🧭 TraceX — Autonomous SRE Incident Triage Agent

An agent: given a production incident, it decides for itself which of your
connected tools to check — CloudWatch logs, metrics, recent GitHub commits, a specific commit's
diff — and how much evidence is enough before it concludes. It doesn't run the same fixed steps
for every incident, because different incidents need different evidence, and because different
customers connect different tools.

**Who configures it: you, not us.** Connect your own CloudWatch scope, GitHub repo, and Slack
channel through the console — TraceX never has standing access to anything you haven't explicitly
connected. That's the actual product, not a demo convenience: an MSP-run NOC tool that only Presidio
operates doesn't scale past Presidio's own client list; a self-service agent your own engineers
configure does.

---

### Engineering Excellence & Vision

TraceX is built as a production-shaped, event-driven system rather than a scripted chatbot demo.
A CloudWatch alarm triggers the agent through SNS; the agent resolves the affected application's
tenant-specific configuration, exposes only the tools that tenant has connected, and runs a bounded
tool-calling loop. The model decides what evidence to collect and when to stop, then submits a typed
triage brief instead of returning free-form text that must be parsed.

Engineering choices are designed around reliability, security, and operability:

- **Evidence-driven autonomy:** logs, metrics, alarms, recent commits, and commit diffs are exposed
  as discrete tools. The investigation path is recorded and shown in Slack, making the agent's
  reasoning observable rather than a black box.
- **Bounded execution:** investigations have turn and wall-clock limits, array-aware payload caps,
  and a safe manual-review fallback so a stalled model cannot consume unbounded time or cost.
- **Trust-aware analysis:** telemetry is confidence-labelled by source. Low-trust repository text
  cannot independently establish root cause, while suspicious prompt-injection patterns are
  quarantined before reaching the model.
- **Security by construction:** connector credentials are encrypted in AWS Secrets Manager with a
  customer-managed KMS key; DynamoDB stores only scope metadata and secret references; IAM policies
  separate configuration write access from agent read access.
- **Privacy and human control:** PII and common secret patterns are sanitized before model input and
  again before Slack output. TraceX diagnoses and proposes remediation, but never executes a change
  without human approval.
- **Infrastructure as code:** Terraform provisions the agent, demo workload, alarms, connector
  registry, API, KMS key, hosted React console, and their least-privilege roles as a repeatable stack.
- **Extensible architecture:** stable investigation tools are separated from provider-specific
  collectors. CloudWatch and Datadog are supported today; additional observability and source-control
  providers can be added without redesigning the agent loop.

The long-term vision is a governed incident-intelligence layer that can investigate across a
customer's existing stack, preserve an auditable chain of evidence, and reduce mean time to
understand without turning production access over to an unaccountable autonomous system.

### Creativity & Innovation

Most incident assistants either summarize a preselected bundle of telemetry or execute a fixed
runbook. TraceX instead changes both **what the model can see** and **how it investigates** based on
the affected tenant and application. If GitHub is not connected, GitHub tools do not exist in that
agent session; if a commit is relevant, the agent can move from deployment evidence to that exact
diff rather than receiving every data source up front.

The key innovations are:

- **Dynamic capability boundaries:** configuration is enforced by constructing a tenant-specific
  toolset, not merely by asking the model to avoid unauthorized tools.
- **Visible proof of agency:** every triage brief includes the actual tool sequence selected during
  the investigation, giving responders and judges a concrete audit trail.
- **Confidence-weighted evidence:** deterministic trust labels help the model distinguish strong
  operational telemetry from weaker, user-controlled text such as commit messages and code diffs.
- **Security on both sides of AI:** sanitization protects data entering the model and content leaving
  it for a searchable collaboration channel—a commonly missed exposure point.
- **Customer-owned onboarding:** a self-service console turns a one-off NOC workflow into a reusable
  product that teams can configure around their own applications, credentials, and alert routes.

Together, these choices make TraceX more than an LLM wrapper: it is a constrained, inspectable agent
whose authority and evidence adapt to the environment it is investigating.

### Viability and Execution Plan

The working prototype already covers the complete incident loop: deploy a monitored service,
generate healthy traffic, inject a failure, trigger an alarm, investigate autonomously, and deliver
a structured Slack brief. The repository includes one-command deployment, break/heal scripts, a
self-service connector console, a realistic multi-service ShopCo test environment, and local tests
for core agent behavior.

| Stage | Focus | Exit criteria |
|---|---|---|
| **Prototype — complete** | Autonomous triage, CloudWatch/GitHub/Slack integration, Datadog collection, secure connector storage, hosted console | A synthetic incident produces a grounded brief with a visible investigation path |
| **Pilot — next 4–6 weeks** | Console authentication, tenant isolation, cross-account AWS roles, audit export, replay-based evaluation | 2–3 design partners run TraceX read-only against non-critical services with measured precision and triage-time savings |
| **Production beta — 2–3 months** | SSO/RBAC, per-tenant encryption, retries and dead-letter handling, budgets, regional deployment, integration SDK | Security review passed; SLOs and support runbooks established; onboarding completed without engineering assistance |
| **Scale — 3–6 months** | More observability/ITSM providers, incident history, team analytics, enterprise policy controls | Repeatable onboarding, paid conversions, and demonstrable reduction in mean time to understand |

Success will be measured with operational outcomes rather than model novelty alone: median time to
first useful brief, root-cause precision, evidence citation coverage, false-confidence rate, cost per
investigation, responder acceptance rate, and reduction in mean time to understand. The initial
production posture remains deliberately read-only; automated remediation is a later, policy-gated
capability only after the diagnostic system earns trust.

The principal prototype gaps are known and explicit: the console/API needs authentication,
CloudWatch currently uses same-account IAM instead of cross-account `AssumeRole`, and the current
deployment uses a shared connector table and KMS key. These are bounded platform-hardening tasks,
not unresolved questions in the core product loop.

### GTM (Go-To-Market) Strategy

**Ideal customer profile.** Start with cloud-native teams running AWS workloads that already use
CloudWatch, GitHub, and Slack but do not have a large 24/7 SRE organization: SaaS scale-ups,
mid-market engineering teams, and managed-service customers with recurring incident volume.
Their pain is immediate and measurable—senior engineers lose time assembling the same evidence
across disconnected tools before they can act.

**Beachhead use case.** Sell read-only, human-approved incident triage for noisy production alerts.
This has a low adoption barrier because TraceX does not replace the customer's observability stack,
does not require an autonomous-remediation leap of faith, and can demonstrate value during the
first incident through faster evidence collection and a clear investigation trail.

**Distribution motion.** Use a product-led trial for individual platform teams, supported by guided
design-partner pilots for larger accounts. Presidio and other cloud/MSP channels can introduce
TraceX during AWS modernization, observability, and managed-services engagements, while AWS,
Datadog, GitHub, and Slack marketplace listings create integration-led discovery. Public incident
replays and before/after MTTR benchmarks provide the technical proof needed to convert SRE buyers.

**Commercial model.** Offer a free developer tier for a small number of services and incidents,
then charge by monitored service plus investigation volume. Enterprise plans add SSO/RBAC,
cross-account and multi-region support, longer audit retention, policy controls, private networking,
and premium support. This aligns price with operational footprint while keeping initial evaluation
simple.

**Expansion path.** Land with one team and one high-pain service, expand across applications and
observability providers, then add incident memory, ITSM workflows, fleet-wide reliability analytics,
and carefully governed remediation approvals. The same connector and policy architecture supports
that expansion without requiring customers to replace their existing tools.

---

## What gets deployed

```
┌─────────────────────────── "PRODUCTION" (this demo's simulated client env) ──────────┐
│                                                                                       │
│  Traffic Generator ──(every 1 min)──> Payment API (API Gateway) ──> Payment Service   │
│  (Lambda + cron)                                                    │ reads SSM       │
│                                                                      │ chaos switch    │
│                                                                      ▼                 │
│                                                                CloudWatch Logs         │
│                                                                │ metric filter (5xx)   │
│                                                                ▼                       │
│                                                           CloudWatch Alarm             │
│                                                                │ fires on threshold    │
│                                                                ▼                       │
│                                                             SNS Topic                  │
└────────────────────────────────────────────────────────────────┼─────────────────────┘
                                                                   ▼
┌──────────────────────────────── TRIAGE AGENT ─────────────────────────────────────────┐
│                                                                                        │
│  Agent Lambda                                                                         │
│    1. Resolves alarm tags, tenant/app configuration, and encrypted connector secrets  │
│    2. Deduplicates the event, stores incident state, and opens a Slack alert thread    │
│    3. Hands the incident to OpenRouter with ONLY the tools this tenant configured      │
│    4. Model decides which tools to call, in what order, and when it has enough        │
│       evidence — get_error_logs, get_deployment_logs, get_service_metrics,            │
│       get_alarm_details, get_recent_commits, get_commit_diff                          │
│    5. Every tool result is volume-capped, sanitized, and assigned a trust label        │
│       (most recent N items, not blind truncation) before it reaches the model         │
│    6. Model calls submit_triage_brief once it has evidence — structured output,        │
│       not regex-parsed free text                                                      │
│    7. Brief is sanitized again and posted inside the original Slack thread, showing   │
│       the actual investigation path; later OK events add a recovery reply             │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────── SELF-SERVICE CONSOLE ─────────────────────────────────────┐
│                                                                                        │
│  CloudFront ──> S3 (React build)  ──>  lambda-config-api  ──>  DynamoDB (scope metadata)│
│                                                             └─>  Secrets Manager (KMS)   │
│                                                                                        │
│  Connect GitHub/Slack, map an application to a CloudWatch log group/alarm — no one     │
│  touches Terraform or Lambda env vars to onboard a new app.                           │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

Terraform manages all of it: the simulated client environment (payment API, traffic generator,
chaos switch, alarm), the triage agent, and the connector console (DynamoDB table, dedicated
KMS key, Secrets Manager, config API + its own API Gateway, and the console itself hosted on
S3 + CloudFront — a real HTTPS URL, not a local dev server).

---

## End-to-End Runtime Workflow

TraceX has two event paths: an **alarm path**, which opens and investigates an incident, and a
**recovery path**, which closes the communication loop when the same CloudWatch alarm returns to
`OK`.

### Alarm path: `ALARM` → investigation → threaded brief

1. **CloudWatch detects a threshold breach.** A metric alarm changes to `ALARM` and publishes its
   event to SNS, which invokes the TraceX Lambda.
2. **The event is normalized and identified.** `handler.js` parses the SNS payload, derives the AWS
   region from the alarm ARN, and fetches the alarm's `Client`, `Service`, and `Environment` tags.
   Metric namespace, name, statistic, and dimensions are retained so the agent queries the exact
   signal that triggered the incident. Direct Lambda invocation is also supported for local tests.
3. **Tenant and application scope is resolved.** The service tag becomes the application ID.
   `connector-registry.js` queries the tenant partition in DynamoDB, finds that application's scope,
   and retrieves only the required GitHub, Slack, or Datadog credentials from Secrets Manager.
   Missing registry configuration falls back to environment variables for the original demo path.
4. **The observability route is selected.** CloudWatch alarms are always investigated against their
   originating CloudWatch logs and metric dimensions, even if Datadog is also connected. For
   provider-routed/direct incidents, the configured application can use Datadog collectors behind
   the same stable tool names.
5. **Duplicate delivery is stopped.** `incident-store.js` conditionally creates an incident record
   keyed by tenant, alarm name, and state-change time. If SNS redelivers the same alarm event, the
   conditional write fails safely and TraceX exits without opening another Slack thread or paying
   for another model investigation.
6. **Responders receive an immediate alert.** TraceX posts a parent message to the configured Slack
   channel before the model begins work. The message identifies the service, environment, alarm,
   and metric and tells responders that an investigation is underway. Its channel and timestamp are
   saved on the incident record.
7. **A least-authority toolset is assembled.** `tools.js` binds each collector to the affected
   application's scope; the model can adjust time windows but cannot select another tenant's log
   group or repository. GitHub tools are omitted entirely unless usable GitHub credentials exist.
8. **The agent investigates iteratively.** `agent-loop.js` sends the sanitized incident summary and
   available tool schemas to the configured OpenRouter model. On every turn, the model can request
   one or more evidence tools, inspect their results, and decide what to query next. It typically
   uses two to four calls rather than fetching every source automatically.
9. **Evidence passes through a safety pipeline.** Each tool result is processed in this order:

   ```text
   collector result
        → keep the newest N items in every array
        → redact PII and common secret patterns
        → attach source confidence and trust guidance
        → quarantine recognized prompt-injection content
        → apply a final character-size backstop
        → return the evidence to the model
   ```

10. **The model returns a typed conclusion.** Once evidence is sufficient, the model must call
    `submit_triage_brief` with root cause, timeline, financial impact, remediation, confidence, and
    severity. TraceX also records the selected tool path, turn count, token usage, estimated cost,
    and elapsed time. Plain-text answers are nudged back to the terminal tool; model failures,
    exhausted turns, or the wall-clock limit produce a safe manual-review brief.
11. **The result is delivered in context.** Generated fields are sanitized again, then the report is
    posted as a reply inside the original Slack alert thread. If creation of the parent alert failed,
    TraceX retries it once and refuses to create an orphan standalone report. The thread shows the
    investigation path, evidence-backed conclusion, confidence, impact, suggested remediation,
    performance/cost metadata, and a human-approval warning.
12. **Incident state is finalized.** DynamoDB is updated to `reported` or `report_failed`, together
    with completion time, severity, confidence, report timestamp, and any delivery error.

### Recovery path: `OK` → correlated thread update

1. CloudWatch publishes another event when the alarm returns to `OK`.
2. TraceX looks up the latest incident for the same tenant and alarm.
3. If that incident has already been recovered, the duplicate event is ignored.
4. Otherwise, TraceX posts a recovery message into the saved Slack thread and updates the incident
   state to `recovered` with its recovery time.
5. Recovery events do **not** start another model investigation, keeping the workflow fast and
   inexpensive while preserving one continuous incident record.

### Responsibility map

| Component | Responsibility |
|---|---|
| `lambda-agent/src/handler.js` | Event parsing, alarm-tag lookup, configuration resolution, incident lifecycle orchestration, Slack threading, and recovery routing |
| `lambda-agent/src/config/connector-registry.js` | DynamoDB application/connector lookup and just-in-time Secrets Manager reads |
| `lambda-agent/src/incidents/incident-store.js` | Idempotent incident creation, state transitions, and recovery correlation |
| `lambda-agent/src/engine/tools.js` | Per-incident tool schemas, tenant-bound executors, GitHub capability filtering, and CloudWatch/Datadog routing |
| `lambda-agent/src/engine/agent-loop.js` | Bounded tool-calling loop, evidence processing, structured completion, and safe fallback |
| `lambda-agent/src/engine/llm-client.js` | OpenRouter-compatible model request boundary, token accounting, and cost estimation |
| `lambda-agent/src/collectors/` | Read-only retrieval from CloudWatch, Datadog, and GitHub |
| `lambda-agent/src/utils/sanitizer.js` | PII and secret-pattern redaction before AI and Slack exposure |
| `lambda-agent/src/utils/confidence-scorer.js` | Source trust labels and prompt-injection quarantine |
| `lambda-agent/src/slack/slack-notifier.js` | Initial alert, threaded triage brief, recovery message, and final outbound sanitization |
| `lambda-config-api/index.js` | Connector/application CRUD and secret writes used by the self-service console |
| `console/` | Customer onboarding, connector testing, application scope mapping, and deployment settings |

### State model and safety boundaries

```text
ALARM received
    → alerting
    → investigating          (Slack parent created)
    → reported               (threaded brief delivered)
       or report_failed      (brief delivery failed)

Initial Slack failure
    → slack_alert_failed
    → retry parent once
    → investigating/report_failed

Later OK event
    → recovered              (reply added to the same thread)
```

- All telemetry and repository access is read-only.
- Remediation is recommendation-only; the Slack buttons are presentation controls and do not grant
  the agent permission to mutate production.
- Agent execution defaults to six turns, a 65-second wall-clock budget, 20 items per nested array,
  and 4,000 characters per tool response; each is configurable by environment variable.
- Connector secrets exist in plaintext only in Lambda memory while an authorized request uses them.
- Incident identity uses the alarm state-change timestamp, making normal SNS redelivery idempotent.

---

## Why this is an agent, not a workflow

The earlier version of this ran a hardcoded `Promise.all([logs, metrics, commits])` for every
incident, then dumped everything into one LLM prompt. That doesn't hold up for a product where
different customers connect different tools — a tenant with no GitHub connector configured simply
never sees `get_recent_commits` as an option; the model can't call a tool it has no credentials
for, because it's never offered in the first place, not because of a runtime permission check.

Full build log and the reasoning behind every architectural decision — including gaps that were
found and fixed while stress-testing the earlier claims — is in [`PLAN.md`](./PLAN.md).

---

## Security & Governance

- **Credentials are never shared with TraceX by default.** Nothing is connected until you
  configure it in the console. GitHub/Slack tokens are written to **AWS Secrets Manager**,
  encrypted with a **dedicated customer-managed KMS key** — not the AWS-owned default. DynamoDB
  holds only non-sensitive scope metadata (repo owner/name, channel ID) and a pointer to the
  secret; the token value itself never lives there.
- **Least-privilege IAM, split by function.** The config API can write secrets under
  `presidio-connector/*` only. The agent can only read them, same path. Neither has broader
  `secretsmanager:*` or `kms:*` access.
- **PII/secret sanitization runs on both sides of the model call**, not just one: every tool
  result is scrubbed (emails, IPs, phone numbers, SSNs, card numbers, AWS keys, generic
  tokens/secrets) before it reaches the model, *and* the model's own generated output is scrubbed
  again before it reaches Slack — a more exposed, more exportable surface than the LLM call itself.
- **Diagnosis is autonomous; remediation is not.** The agent proposes a remediation command, it
  never executes one. Every triage brief carries an explicit human-approval footer.
- **Stated limitation, not hidden**: the agent Lambda does see the plaintext token at
  investigation time — it has to, to call GitHub/Slack on your behalf. There's no way around that
  without breaking the feature (see `PLAN.md` for the full reasoning on why). The actual security
  boundary is dedicated encrypted storage + least-privilege IAM + a distinct CloudTrail audit trail
  on every decrypt, not "the backend never sees it."
- **Known scope cuts for this build**, stated explicitly: no auth on the console/config API
  itself, one shared KMS key rather than per-tenant keys, and CloudWatch access via the agent
  Lambda's own same-account IAM role rather than real cross-account `AssumeRole`. All three are
  exactly what a production rollout would need next.

---

## Quick Start

```bash
# 1. Fill in your API keys (OpenRouter, Slack, GitHub)
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
# edit terraform/terraform.tfvars — see that file for what each field needs

# 2. Deploy everything
./deploy.sh

# 3. Configure connectors + at least one application
# Terraform hosts the console on S3 + CloudFront and prints its URL —
# open it (already pointed at this deployment's config API, no setup
# needed), then add your GitHub/Slack connectors and an application
# (appId "payment-service" to match the demo's alarm)

# 4. Wait 2 min for traffic to flow, then BREAK IT
./break-it.sh

# 5. Watch Slack — Triage Brief appears in ~2-3 min

# 6. Reset for next demo
./heal-it.sh

# 7. Tear down
./teardown.sh
```

## Observability integrations

The console now includes an integration catalog. CloudWatch remains the built-in/default
provider and Datadog is implemented end to end. GitHub and Slack use the same test-before-save
connection flow. Grafana, New Relic, Elastic, Splunk, and Azure Monitor appear as roadmap cards
and are deliberately not presented as working connectors.

To connect Datadog:

1. Open **Connectors → Datadog** and select the Datadog site.
2. Enter an API key and an application key with read access to logs, metrics, and monitors.
3. Click **Test connection**, then **Save connection**.
4. Open **Applications**, select Datadog, and map the service tag, environment, metric query,
   monitor ID, and optional log-query overrides.

At incident time the agent keeps the same stable tools (`get_error_logs`,
`get_service_metrics`, and so on), while the executor routes them to the provider mapped to
the affected application. Connector secrets remain in Secrets Manager and are never returned
to the browser.

## Required existing VPC

TraceX uses the authority-provided `path-labs-innovation-sprint-vpc`. Terraform discovers that
VPC and the `path-labs-innovation-sprint-private-*` subnets by their `Name` tags and attaches all
four Lambdas to those private subnets. It does **not** create or manage any VPC, subnet, route
table, NAT gateway, or internet gateway. `terraform destroy` therefore cannot delete the
authority-owned network.

The existing private subnets must retain outbound connectivity through the authority-managed NAT
gateway because the agent and configuration API call OpenRouter, GitHub, Slack, and Datadog.
TraceX creates only an outbound-only workload security group inside the supplied VPC.

If you skip step 3, the agent falls back to the original env-var-driven single-tenant demo
config (`LOG_GROUP_NAME`, `GITHUB_TOKEN`, etc. from `terraform.tfvars`) — the demo still works,
it just isn't demonstrating the self-service connector path.

---

## Demo Day Script

The demo runs three scenarios, each proving a different kind of investigation — a code-level
bug the agent finds via git history, a pure infra capacity limit with zero code correlation, and
a downstream AWS dependency failure the agent inspects directly via a live resource-health tool.
All three are triggered from the console's **Simulator** page (Break/Fix buttons, live-polled
status), or directly against the config API for a terminal-driven demo:

```bash
CONFIG_API=https://q5pdiqcs6f.execute-api.us-east-1.amazonaws.com

# Terminal: agent logs (empty — no incidents yet)
aws logs tail /aws/lambda/presidio-sre-agent-triage --follow

# Slack: show the incident channel — quiet, no alerts
```

### Scenario 1 — Application Errors (payment-service, ShopCo)
A real, unguarded `currency.toUpperCase()` null-safety bug in `payment-service`'s `charge()`
code, reached when `order-service` forwards a malformed payload.
```bash
curl -X POST $CONFIG_API/simulate/payment-service/break
# ~45-90s: shopco-payment-5xx-critical alarm fires
# ~20-40s: agent investigates — logs, metrics, deployment history, then get_recent_commits /
#          get_commit_diff — and finds the actual commit that removed the null check
curl -X POST $CONFIG_API/simulate/payment-service/heal
```

### Scenario 2 — Infrastructure Capacity Limit (inventory-service, ShopCo)
Real Lambda concurrency throttle — zero code correlation, by design.
```bash
curl -X POST $CONFIG_API/simulate/inventory-service/break
curl -X POST $CONFIG_API/simulate/inventory-service/heal
```

### Scenario 3 — Downstream Dependency Failure (acme-payment-service)
A real DynamoDB table (`acme-payment-idempotency`) provisioned undersized. Break fires a
one-shot burst-load function against that table — payment-service's own code never changes,
and there's no code deploy to correlate against.
```bash
curl -X POST $CONFIG_API/simulate/acme-payment-service/break
# self-expires after ~80s, no heal step needed
```
Narrate: the agent rules out a code cause (no recent deploy), then calls
`get_dependency_resource_health` on the table's ARN — pulled from the app's own configured
dependency metadata — to confirm the table's provisioned capacity is genuinely undersized,
rather than just repeating the error string back.

For each scenario, watch the agent logs turn-by-turn (e.g. `Turn 2: agent calling
get_dependency_resource_health(...)`), then the Slack Triage Brief: root cause, timeline,
financial impact, remediation, and the investigation path the agent actually chose — not a
fixed script.

---

## How the Chaos Toggles Work

Each scenario has its own real, instantly-reversible break mechanism — not a single global
switch. See `lambda-config-api/index.js`'s `SIMULATE_REGISTRY` for the authoritative mapping:

```
payment-service      → SSM /shopco/chaos/cascade (order-service sends payment-service a
                        malformed payload, reaching the real null-safety bug)
inventory-service     → zeroed Lambda reserved concurrency (real AWS throttle)
acme-payment-service  → one-shot burst-load invoke against a real, undersized DynamoDB table
```

---

## Pre-Hackathon Checklist

- [ ] OpenRouter API key and a model that supports tool/function calling
- [ ] Slack app with `chat:write` scope, bot token, channel ID
- [ ] GitHub PAT + demo repo (`bash scripts/setup-github-repo.sh`)
- [ ] Terraform installed
- [ ] AWS CLI installed
- [ ] Node.js 18+ installed

---

## Project Structure

```
presidio-fullstack/
├── terraform/                    # ALL infrastructure (one apply)
│   ├── provider.tf
│   ├── variables.tf
│   ├── demo-app.tf              # Payment service + traffic gen + alarm
│   ├── agent.tf                 # Triage agent + SNS
│   ├── connectors.tf            # DynamoDB registry + KMS key + config API
│   ├── console-hosting.tf       # S3 + CloudFront — hosts the built console
│   ├── outputs.tf
│   └── terraform.tfvars.example
│
├── lambda-agent/                 # AI Triage Agent code
│   ├── package.json
│   └── src/
│       ├── handler.js           # Entry point — resolves tenant config, runs the agent loop
│       ├── collectors/          # CloudWatch Logs/Metrics, GitHub — the raw data sources
│       ├── engine/
│       │   ├── llm-client.js    # OpenRouter wrapper — provider-specific boundary
│       │   ├── tools.js         # Wraps collectors as tool schemas, gated by what's configured
│       │   └── agent-loop.js    # The actual agent: tool-calling loop, truncation, sanitization
│       ├── config/
│       │   └── connector-registry.js  # Reads per-tenant config from DynamoDB + Secrets Manager
│       ├── slack/                # Slack Block Kit brief, incl. investigation-path display
│       └── utils/                # PII sanitizer, logger
│
├── lambda-config-api/            # CRUD API backing the console (connectors + applications)
│
├── console/                      # React (Vite) self-service connector console
│   └── src/pages/                # Overview, Connectors, Applications, Settings
│
├── lambda-demo-app/               # Fake Payment Service (simulated client environment)
├── lambda-traffic-gen/            # Traffic Generator
├── scripts/
│   └── setup-github-repo.sh      # Create demo Git repo
│
├── deploy.sh                     # ⭐ One-command deploy
├── break-it.sh                   # 🚨 Trigger the incident
├── heal-it.sh                    # ✅ Reset for next demo
├── teardown.sh                   # 💣 Destroy everything
└── PLAN.md                       # Full build log — every decision and why
```
