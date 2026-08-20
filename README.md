# 🧭 TraceX — Autonomous SRE Incident Triage Agent

An agent, not a workflow: given a production incident, it decides for itself which of your
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
│    1. Looks up this tenant/app's connector config (DynamoDB + Secrets Manager)        │
│    2. Hands the incident to Azure OpenAI with ONLY the tools this tenant configured    │
│    3. Model decides which tools to call, in what order, and when it has enough        │
│       evidence — get_error_logs, get_deployment_logs, get_service_metrics,            │
│       get_alarm_details, get_recent_commits, get_commit_diff                          │
│    4. Every tool result is sanitized (PII/secrets stripped) and volume-capped          │
│       (most recent N items, not blind truncation) before it reaches the model         │
│    5. Model calls submit_triage_brief once it has evidence — structured output,        │
│       not regex-parsed free text                                                      │
│    6. Brief is sanitized again (belt-and-suspenders) and posted to Slack, showing      │
│       the actual investigation path the agent took                                    │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────── SELF-SERVICE CONSOLE ─────────────────────────────────────┐
│                                                                                        │
│  console/ (React)  ──>  lambda-config-api  ──>  DynamoDB (scope metadata)             │
│                                              └─>  Secrets Manager (tokens, KMS-encrypted)│
│                                                                                        │
│  Connect GitHub/Slack, map an application to a CloudWatch log group/alarm — no one     │
│  touches Terraform or Lambda env vars to onboard a new app.                           │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

Terraform manages all of it: the simulated client environment (payment API, traffic generator,
chaos switch, alarm), the triage agent, and the connector console's backend (DynamoDB table,
dedicated KMS key, Secrets Manager, config API + its own API Gateway).

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
# 1. Fill in your API keys (Azure OpenAI, Slack, GitHub)
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
# edit terraform/terraform.tfvars — see that file for what each field needs

# 2. Deploy everything
./deploy.sh

# 3. Configure connectors + at least one application
cd console && npm install && npm run dev
# open the printed local URL, go to Settings, paste in the config_api_url
# from deploy.sh's output, then add your GitHub/Slack connectors and an
# application (appId "payment-service" to match the demo's alarm)

# 4. Wait 2 min for traffic to flow, then BREAK IT
./break-it.sh

# 5. Watch Slack — Triage Brief appears in ~2-3 min

# 6. Reset for next demo
./heal-it.sh

# 7. Tear down
./teardown.sh
```

If you skip step 3, the agent falls back to the original env-var-driven single-tenant demo
config (`LOG_GROUP_NAME`, `GITHUB_TOKEN`, etc. from `terraform.tfvars`) — the demo still works,
it just isn't demonstrating the self-service connector path.

---

## Demo Day Script

### Before going on camera:
```bash
./deploy.sh                    # Stand up everything (~3 min)
# Configure connectors + application in the console (once, ahead of time)
# Wait 3-5 min for healthy traffic to establish baseline
```

### On camera:
```bash
# Terminal 1: Show healthy payment logs flowing
aws logs tail /ecs/acme-payment-service --follow

# Terminal 2: Agent logs (empty — no incidents yet)
aws logs tail /aws/lambda/presidio-sre-agent-triage --follow

# Slack: Show #noc-acme-incidents — quiet, no alerts

# NOW BREAK IT:
./break-it.sh

# Narrate what's happening:
# "I just flipped the chaos switch. A bad deployment just went out
#  that removed null-safety checks from the payment validator..."

# Terminal 1: 500 errors start appearing in logs
# Wait 1-2 min...
# CloudWatch alarm fires → SNS → Agent triggers automatically
# Terminal 2: agent logs show it deciding what to check — e.g.
#   "Turn 1: agent calling get_deployment_logs(...)"
#   "Turn 2: agent calling get_error_logs(...)"
#   "Turn 3: agent calling get_commit_diff({sha: 'a3f8b2c'})"
# Slack: Triage Brief appears — root cause, timeline, cost impact,
#   AND the investigation path the agent actually chose

# "The agent decided for itself what to check — it saw the deployment
#  happened 12 minutes before the errors started, pulled that exact
#  commit's diff, and found the removed null check."

# Reset for Q&A:
./heal-it.sh
```

---

## How the Chaos Switch Works

```
SSM Parameter: /presidio-demo/chaos-mode

  "false" (default)          "true" (after ./break-it.sh)
  ─────────────────          ──────────────────────────────
  Payment API → 200          Payment API → 500 (85%)
  Healthy logs               Error logs + stack traces
  Alarm: OK                  Alarm: ALARM → SNS → Agent
  Slack: quiet               Slack: Triage Brief 🚨
```

---

## Pre-Hackathon Checklist

- [ ] Azure AI Foundry deployment (endpoint, API key, deployment name — must support tool/function calling)
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
│   ├── outputs.tf
│   └── terraform.tfvars.example
│
├── lambda-agent/                 # AI Triage Agent code
│   ├── package.json
│   └── src/
│       ├── handler.js           # Entry point — resolves tenant config, runs the agent loop
│       ├── collectors/          # CloudWatch Logs/Metrics, GitHub — the raw data sources
│       ├── engine/
│       │   ├── llm-client.js    # Azure OpenAI wrapper — the only file that knows about Azure
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
