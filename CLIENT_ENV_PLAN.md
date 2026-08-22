# CLIENT_ENV_PLAN.md — ShopCo Demo Environment

Simulation plan for a realistic multi-service production environment that TraceX
investigates during the demo. The goal is a shopping application with enough moving
parts that failures produce genuine cross-service correlation signals — not a single
toy Lambda doing everything.

This environment is entirely separate from the TraceX infrastructure. It represents
"the client's production application" that has connected TraceX as their SRE tool.

---

## Overview

**Application:** ShopCo — a fictional e-commerce platform
**Services:** 4 (order, payment, inventory, notification)
**Repository:** `shopco-platform` — a real GitHub repo with a realistic commit history
**Observability:** CloudWatch (primary) + Grafana Cloud with Loki (secondary)
**Chaos switches:** 3 independent failure scenarios via SSM parameters
**TraceX integration:** all 4 services registered as applications in the TraceX console

The demo story: ShopCo's engineering team deployed a hotfix during peak trading hours.
The payment service started failing. Within 90 seconds, the order service started
failing too — every checkout attempt produces a 500. Two CloudWatch alarms fire.
TraceX investigates both simultaneously, follows a traceId across both services, and
delivers one correlated root cause brief to Slack — identifying the bad commit,
the cascade path, and the exact rollback command.

---

## Part 1 — The ShopCo GitHub Repository

### 1.1 Repository structure

```
shopco-platform/
├── services/
│   ├── order-service/        Node.js Lambda — creates and manages orders
│   ├── payment-service/      Node.js Lambda — processes payments via mock gateway
│   ├── inventory-service/    Node.js Lambda — checks and reserves stock
│   └── notification-service/ Node.js Lambda — sends order confirmation events
├── shared/
│   └── tracing.js            Generates and propagates traceIds across service calls
├── terraform/                Infrastructure for the ShopCo environment
├── scripts/
│   ├── break-payment.sh      Flip SSM chaos switch: payment service fails
│   ├── break-inventory.sh    Flip SSM chaos switch: inventory exhausted
│   ├── break-cascade.sh      Flip SSM chaos switch: payment → order cascade
│   ├── heal-all.sh           Reset all chaos switches to healthy
│   └── seed-traffic.sh       Fire a burst of synthetic orders (for baseline)
└── .github/
    └── workflows/
        └── deploy.yml        Simulated CI/CD pipeline (not real — just the file)
```

### 1.2 Commit history design

The repository needs a believable development history. Every commit that matters to
the demo must actually exist at that SHA so the agent can call `get_commit_diff` and
get real output. Commits are created in this order:

```
Phase 1 — Foundation (T-30 days)
─────────────────────────────────
a1b2c3d  initial: scaffold order-service with Express-style Lambda handler
b2c3d4e  initial: scaffold payment-service with mock payment gateway client
c3d4e5f  initial: scaffold inventory-service with in-memory stock map
d4e5f6a  initial: scaffold notification-service with SNS publisher
e5f6a7b  feat: wire services together — order calls payment + inventory in sequence
f6a7b8c  feat: add shared tracing.js — propagate X-Amzn-Trace-Id across service calls
a7b8c9d  feat: add structured JSON logging to all services (level, traceId, statusCode)

Phase 2 — Feature development (T-14 days)
──────────────────────────────────────────
b8c9d0e  feat: add order status endpoint GET /orders/:id
c9d0e1f  feat: payment-service — add retry logic for transient gateway errors
d0e1f2a  feat: inventory-service — add stock reservation with 10-minute TTL
e1f2a3b  fix: order-service — handle null customerId on anonymous checkout
f2a3b4c  perf: inventory-service — cache frequently queried SKUs for 30s
a3b4c5d  feat: notification-service — add order confirmation email template

Phase 3 — The bad deployment (T-2 hours) ← what breaks prod
────────────────────────────────────────────────────────────
b4c5d6e  refactor: payment-service — remove legacy null-safety wrapper in charge()
         [This removes: if (!amount || !currency) return { error: 'invalid' }]
         [Replaced with direct call that throws NullPointerException on bad input]

Phase 4 — Commits after the break (T-1 hour) ← agent checks these too
──────────────────────────────────────────────────────────────────────
c5d6e7f  chore: update payment-service dependencies
d6e7f8a  docs: update API reference for payment endpoint
```

The commit `b4c5d6e` is the breadcrumb. It must exist in the repo with a real diff
showing the null check removal. The agent's `get_commit_diff` call will return the
actual code change.

### 1.3 Service implementation — what each service does

**order-service** (`services/order-service/index.js`)
- `POST /orders` — validates cart, calls inventory-service to reserve stock,
  calls payment-service to charge, writes order to DynamoDB, calls
  notification-service to confirm
- Propagates `traceId` header to every downstream call
- Logs structured JSON: `{ service, level, traceId, orderId, statusCode, durationMs }`
- When payment-service returns non-200: logs `ERROR "Payment processing failed"`,
  returns 500 to the caller
- Chaos mode: if SSM `/shopco/chaos/cascade` is `true`, passes a malformed
  amount field to payment-service (triggers the null-safety bug)

**payment-service** (`services/payment-service/index.js`)
- `POST /charge` — calls mock payment gateway, returns `{ success, transactionId }`
- Propagates `traceId` from inbound request header into all log entries
- Healthy: returns 200, logs success with `transactionId`
- Broken (after bad commit): `amount` or `currency` being null throws
  `TypeError: Cannot read properties of null` — logs full stack trace with
  `"null-safety wrapper removed in commit b4c5d6e"` in the error message
- Chaos switch `/shopco/chaos/payment`: if `true`, 90% of requests fail regardless
  of input

**inventory-service** (`services/inventory-service/index.js`)
- `POST /reserve` — checks stock, reserves quantity for 10 minutes
- `DELETE /reserve/:reservationId` — releases a reservation (called on payment failure)
- Chaos switch `/shopco/chaos/inventory`: if `true`, returns `{ available: 0 }`
  for all SKUs, causing order-service to abort with `ERROR "Insufficient stock"`

**notification-service** (`services/notification-service/index.js`)
- `POST /notify` — publishes an SNS message (or logs a simulated email for the demo)
- No chaos switch needed — downstream enough that it only fails if order-service fails

**shared/tracing.js**
- Generates a `traceId` as `shopco-${Date.now()}-${randomHex(8)}`
- Exports `injectTraceId(headers)` and `extractTraceId(headers)`
- Every service imports this — every log entry from every service that handles
  the same request carries the same `traceId`

This is the key detail: when the agent calls `get_trace(traceId)`, it finds log
entries from order-service AND payment-service carrying the same ID. That's the
cross-service correlation signal.

---

## Part 2 — Infrastructure (Terraform)

All ShopCo infrastructure lives in `shopco-platform/terraform/`. It is completely
separate from the TraceX terraform directory. Both can be deployed independently.

### 2.1 Lambda functions

One Lambda per service, Node.js 18.x, behind API Gateway HTTP API.

```
shopco-order-service       → POST /orders, GET /orders/:id
shopco-payment-service     → POST /charge
shopco-inventory-service   → POST /reserve, DELETE /reserve/:id
shopco-notification-service → POST /notify
shopco-traffic-generator   → fires synthetic orders every 60s (EventBridge rule)
```

The traffic generator fires 8 healthy orders per minute when chaos is off.
When chaos is on, those same 8 orders start cascading through the broken path.
No manual curl commands needed during the demo.

### 2.2 CloudWatch log groups (one per service)

```
/shopco/order-service
/shopco/payment-service
/shopco/inventory-service
/shopco/notification-service
```

Retention: 3 days (demo environment — keep costs minimal).

### 2.3 Metric filters (one 5xx filter per service that can fail)

```hcl
resource "aws_cloudwatch_log_metric_filter" "order_5xx" {
  log_group_name = "/shopco/order-service"
  pattern        = "{ $.statusCode = 500 }"
  metric_transformation {
    name      = "ShopCo_Order5xxCount"
    namespace = "ShopCo"
    value     = "1"
  }
}

resource "aws_cloudwatch_log_metric_filter" "payment_5xx" {
  log_group_name = "/shopco/payment-service"
  pattern        = "{ $.statusCode = 500 }"
  metric_transformation {
    name      = "ShopCo_Payment5xxCount"
    namespace = "ShopCo"
    value     = "1"
  }
}
```

### 2.4 CloudWatch alarms (fire into TraceX via SNS)

Two alarms, both pointing at the same SNS topic that TraceX is subscribed to:

```hcl
resource "aws_cloudwatch_metric_alarm" "order_5xx" {
  alarm_name          = "shopco-order-5xx-critical"
  namespace           = "ShopCo"
  metric_name         = "ShopCo_Order5xxCount"
  threshold           = 3
  evaluation_periods  = 1
  period              = 60
  statistic           = "Sum"
  alarm_actions       = [var.tracex_sns_topic_arn]

  tags = {
    Client  = "shopco"
    Service = "order-service"
  }
}

resource "aws_cloudwatch_metric_alarm" "payment_5xx" {
  alarm_name          = "shopco-payment-5xx-critical"
  namespace           = "ShopCo"
  metric_name         = "ShopCo_Payment5xxCount"
  threshold           = 3
  evaluation_periods  = 1
  period              = 60
  statistic           = "Sum"
  alarm_actions       = [var.tracex_sns_topic_arn]

  tags = {
    Client  = "shopco"
    Service = "payment-service"
  }
}
```

`var.tracex_sns_topic_arn` is the output from the TraceX terraform deployment.
This is the only connection point between the two terraform stacks.

### 2.5 SSM chaos parameters

```hcl
resource "aws_ssm_parameter" "chaos_payment"   { name = "/shopco/chaos/payment";   type = "String"; value = "false" }
resource "aws_ssm_parameter" "chaos_inventory" { name = "/shopco/chaos/inventory"; type = "String"; value = "false" }
resource "aws_ssm_parameter" "chaos_cascade"   { name = "/shopco/chaos/cascade";   type = "String"; value = "false" }
```

### 2.6 DynamoDB (order state)

```hcl
resource "aws_dynamodb_table" "orders" {
  name         = "shopco-orders"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "orderId"
}
```

order-service writes order records here. The agent can see order IDs in logs
and cross-reference them if needed.

---

## Part 3 — Grafana Cloud + Loki Integration

Grafana Cloud free tier provides Loki (log storage) + Grafana (dashboards) without
running any servers. This gives the demo a second observability source alongside
CloudWatch — demonstrating that TraceX can pull from both in one investigation.

### 3.1 Setup steps

1. Create a Grafana Cloud account (free tier, no credit card)
2. Note the Loki endpoint: `https://logs-prod-XXX.grafana.net`
3. Create an API token with `logs:write` scope
4. Register Grafana as a connector in the TraceX console:
   - Type: Grafana (currently "coming soon" — see Phase 3.2)
   - Loki endpoint, API token

### 3.2 Log shipping from Lambda to Loki

Each Lambda function ships logs to Loki via a CloudWatch Logs subscription filter
that triggers a small forwarder Lambda. The forwarder reads the log batch and POST
it to the Loki push API.

```
CloudWatch Log Group → Subscription Filter → shopco-loki-forwarder Lambda
                                                      ↓
                                               Loki (Grafana Cloud)
```

The forwarder Lambda is ~40 lines — it decodes the CloudWatch log batch, reformats
each entry as a Loki stream with labels `{service="order-service", env="prod"}`,
and POSTs to `https://logs-prod-XXX.grafana.net/loki/api/v1/push`.

This means every log entry from every ShopCo service is simultaneously:
- Available in CloudWatch (queried by TraceX's existing tools)
- Available in Grafana/Loki (demonstrating TraceX can pull from external log sources)

### 3.3 Grafana dashboard (for the demo screen)

Set up one Grafana dashboard with four panels:
- Error rate per service (metric from CloudWatch datasource)
- Live log stream for order-service (Loki datasource)
- Live log stream for payment-service (Loki datasource)
- TraceId search panel — query Loki for a specific traceId across all services

This dashboard is what you show on the left half of the screen while TraceX
investigates on the right. It makes the distributed nature of the failure visible
before TraceX correlates it.

### 3.4 Enabling Grafana in the TraceX connector

The Grafana connector in `connectors.js` is currently marked `available: false`.
Enable it and add fields:

```js
{ type: "grafana", name: "Grafana", icon: "G", category: "Observability",
  available: true,
  description: "Loki logs via Grafana Cloud.",
  fields: [
    { key: "lokiEndpoint", label: "Loki endpoint", placeholder: "https://logs-prod-XXX.grafana.net" },
    { key: "token", label: "API token", type: "password", secret: true },
  ]
}
```

Add a `GrafanaCollector` class (similar to the existing `DatadogCollector`) that
calls the Loki query API. Wire it into `tools.js` the same way Datadog is wired —
if a Grafana connector is active, `get_error_logs` routes to Loki instead of (or
in addition to) CloudWatch.

---

## Part 4 — TraceX Integration

### 4.1 Register ShopCo applications in the TraceX console

After deploying both stacks, open the TraceX console and register each service
as an application:

| App ID | Log group | Alarm name | Metric namespace |
|---|---|---|---|
| `order-service` | `/shopco/order-service` | `shopco-order-5xx-critical` | `ShopCo` |
| `payment-service` | `/shopco/payment-service` | `shopco-payment-5xx-critical` | `ShopCo` |
| `inventory-service` | `/shopco/inventory-service` | — (no alarm yet) | `ShopCo` |
| `notification-service` | `/shopco/notification-service` | — | `ShopCo` |

### 4.2 Connect integrations

- **CloudWatch**: region `us-east-1` (IAM-based, no credentials)
- **Grafana**: Loki endpoint + API token
- **GitHub**: PAT + `shopco-platform` repo owner/name
- **Slack**: bot token + channel ID

### 4.3 Affected services in handler.js

For the cascade demo scenario, the alarm event needs to carry both affected service
names so the agent investigates both log groups. The CloudWatch alarm tags
`Service = "order-service"` give the primary service. The `affectedServices` array
(from the handler.js change described in the main plan) carries both:

```js
affectedServices: ["order-service", "payment-service"]
```

For the demo this is set by the chaos scenario — when `break-cascade.sh` runs,
it flips SSM and also sets a second SSM parameter `/shopco/active-incident-services`
that the handler reads to populate `affectedServices`.

---

## Part 5 — Failure Scenarios

### Scenario A — Payment service failure (single-service)

```
./break-payment.sh
  → /shopco/chaos/payment = "true"
  → payment-service: 90% of charge() calls return 500
  → alarm: shopco-payment-5xx-critical fires
  → TraceX investigates payment-service only
  → Root cause: chaos switch (for testing) or bad commit (for the full demo)
```

Use this scenario first to verify the single-service path works.

### Scenario B — Inventory exhaustion (silent failure)

```
./break-inventory.sh
  → /shopco/chaos/inventory = "true"
  → inventory-service: all SKUs return available: 0
  → order-service: every order aborts at inventory check, returns 422
  → No 5xx → no alarm → TraceX not triggered
```

This scenario demonstrates a gap in threshold-based alerting — useful for the
"why TraceX needs anomaly detection" story in a sales conversation, not for the
live demo itself.

### Scenario C — Cascading failure (the main demo scenario)

```
./break-cascade.sh
  → /shopco/chaos/cascade = "true"
  → traffic-generator fires synthetic order
  → order-service calls payment-service with malformed amount field
  → payment-service: TypeError from removed null-safety wrapper (commit b4c5d6e)
        logs: ERROR { traceId: "shopco-xxx", message: "null-safety wrapper removed in commit b4c5d6e" }
  → order-service: receives 500, logs: ERROR { traceId: "shopco-xxx", message: "Payment processing failed — upstream 500" }
  → Both errors carry the same traceId
  → Within 60s: ShopCo_Payment5xxCount > 3 → shopco-payment-5xx-critical fires
  → Within 90s: ShopCo_Order5xxCount > 3 → shopco-order-5xx-critical fires
  → Two SNS messages → two Lambda invocations
  → [Future: alert grouping layer consolidates into one investigation]
  → [Current demo: two investigations, both arrive at same root cause]
  → Slack: two briefs pointing at same commit b4c5d6e
```

For the demo you can show both briefs arriving and pointing at the same commit as
proof of correlation — even before the alert grouping layer is built.

---

## Part 6 — Repository Setup Steps

These are the manual steps to actually create the `shopco-platform` repo:

```
Step 1: Create repo on GitHub
  gh repo create shopco-platform --public

Step 2: Scaffold directory structure
  mkdir -p services/{order,payment,inventory,notification}-service shared terraform scripts

Step 3: Write service code
  See Part 1.3 above — implement each service's index.js

Step 4: Create commits in order
  Follow the commit history in Part 1.2 — each commit message and SHA matters
  because the TraceX agent will call get_commit_diff on b4c5d6e specifically

Step 5: Tag the "bad deployment"
  git tag v2.4.1-hotfix b4c5d6e
  # The demo narrative: "the hotfix deployed at 14:30 broke prod"

Step 6: Deploy terraform
  cd terraform && terraform init && terraform apply

Step 7: Run seed traffic to establish healthy baseline
  ./scripts/seed-traffic.sh
  # Wait 3-5 minutes — let CloudWatch establish a normal error-rate baseline

Step 8: Register in TraceX console
  See Part 4.1
```

---

## Part 7 — Demo Flow

| Time | Action | What's visible |
|---|---|---|
| T-5min | `./scripts/seed-traffic.sh` | Grafana: all green, 0 errors |
| T-0 | Show Slack — quiet | Audience sees healthy state |
| T-0 | Show Grafana dashboard | 4 services, all green |
| T-0 | `./break-cascade.sh` | "A hotfix just went out" |
| T+60s | Grafana: payment-service error rate spikes | Audience sees the failure propagate |
| T+90s | Grafana: order-service error rate spikes | "Two services down" |
| T+120s | First CloudWatch alarm fires | Slack: "TraceX activated" |
| T+150s | Second CloudWatch alarm fires | TraceX now has both services |
| T+180s | TraceX triage brief appears in Slack | One message, two services, one commit |
| T+210s | Walk through the brief | Show: traceId followed, cascade identified, rollback command |
| T+240s | `./heal-all.sh` | Grafana returns to green |

Total on-camera time: ~4 minutes.

---

## Part 8 — What This Demonstrates to an Audience

The sequence above shows three things that existing tools cannot do:

**1. Correlation without manual work.** The audience saw two separate services fail
on the Grafana dashboard. TraceX delivered one root cause. No engineer logged into
CloudWatch. No engineer grepped through logs. No engineer manually traced the
request path.

**2. Cross-service tracing.** The triage brief shows the traceId present in both
the payment-service error and the order-service error — proving the agent followed
a single request across two services, not just pattern-matched on similar timestamps.

**3. Code-level attribution.** The brief cites commit `b4c5d6e`, shows the removed
null check, and gives the exact rollback command. The audience can verify this is
real by clicking the GitHub link in the brief.

These three together — correlation, trace following, code attribution — are what
the USP promises and what the demo must visibly deliver.

---

## Dependency map

```
shopco-platform repo     ←── GitHub connector in TraceX console
shopco terraform         ←── var.tracex_sns_topic_arn from TraceX terraform output
Grafana Cloud account    ←── Grafana connector in TraceX console
                              + Loki forwarder Lambda in shopco terraform
TraceX console           ←── 4 applications registered (order, payment, inventory, notification)
```

The only hard dependency between the two stacks is the SNS topic ARN. Everything
else is configured through the TraceX console after both stacks are deployed.
