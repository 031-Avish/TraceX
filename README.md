# 🤖 Presidio SRE Agent — Full Stack Hackathon Deployment

Everything in Terraform. One `./deploy.sh` stands up a **real simulated production environment** + the AI triage agent. No fake alarm triggers — the incident happens organically.

---

## What Gets Deployed

```
┌─────────────────────────── "PRODUCTION" ─────────────────────────────┐
│                                                                      │
│  Traffic Generator  ──(every 1 min)──>  Payment API (API Gateway)    │
│  (Lambda + cron)                        │                            │
│                                         ▼                            │
│                                    Payment Service (Lambda)          │
│                                    │  reads SSM chaos switch         │
│                                    │  logs to CloudWatch             │
│                                    ▼                                 │
│                              CloudWatch Logs                         │
│                              │  metric filter (5xx count)            │
│                              ▼                                       │
│                         CloudWatch Alarm                             │
│                              │  fires when 5xx > 3/min              │
│                              ▼                                       │
│                           SNS Topic                                  │
│                              │                                       │
└──────────────────────────────┼───────────────────────────────────────┘
                               │
                               ▼
┌──────────────────── TRIAGE AGENT ────────────────────────────────────┐
│                                                                      │
│  Agent Lambda  ──> Collect logs/metrics/commits (parallel)           │
│                ──> Claude API (root cause analysis)                   │
│                ──> Post Triage Brief to Slack                        │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Resources created:** 3 Lambdas, 1 API Gateway, 1 SNS Topic, 1 CloudWatch Alarm,
1 Metric Filter, 2 Log Groups, 1 SSM Parameter, 3 IAM Roles, 1 EventBridge rule

---

## Quick Start

```bash
# 1. Fill in your API keys
cp terraform/terraform.tfvars.example terraform/terraform.tfvars

# 2. Deploy everything
./deploy.sh

# 3. Wait 2 min for traffic to flow, then BREAK IT
./break-it.sh

# 4. Watch Slack — Triage Brief appears in ~2-3 min

# 5. Reset for next demo
./heal-it.sh

# 6. Tear down
./teardown.sh
```

---

## Demo Day Script

### Before going on camera:
```bash
./deploy.sh                    # Stand up everything (~3 min)
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
# Terminal 2: Agent logs appear — collecting data, calling Claude
# Slack: Triage Brief appears with root cause, timeline, cost impact

# "The agent identified the root cause in 20 seconds:
#  commit a3f8b2c removed null-safety checks, causing a
#  NullPointerException on 85% of payment requests."

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

- [ ] Anthropic API key (console.anthropic.com)
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
│   ├── outputs.tf
│   └── terraform.tfvars.example
│
├── lambda-agent/                 # AI Triage Agent code
│   ├── package.json
│   └── src/
│       ├── handler.js
│       ├── collectors/          # CW Logs, CW Metrics, GitHub
│       ├── engine/              # Claude API integration
│       ├── slack/               # Slack Block Kit brief
│       └── utils/               # PII sanitizer, logger
│
├── lambda-demo-app/              # Fake Payment Service
│   ├── package.json
│   └── index.js                 # Chaos-switchable API
│
├── lambda-traffic-gen/           # Traffic Generator
│   ├── package.json
│   └── index.js                 # Hits payment API every minute
│
├── scripts/
│   └── setup-github-repo.sh    # Create demo Git repo
│
├── deploy.sh                    # ⭐ One-command deploy
├── break-it.sh                  # 🚨 Trigger the incident
├── heal-it.sh                   # ✅ Reset for next demo
└── teardown.sh                  # 💣 Destroy everything
```
