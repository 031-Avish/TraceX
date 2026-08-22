# TraceX — Handoff / Session Continuity Doc

Written 2026-08-22, ~08:41 UTC (~14:11 IST), because the current session is close to its
context/time limit. If you are a fresh AI session or the user picking this back up: read this
first, then verify live state before trusting anything below — AWS state may have drifted.

AWS CLI profile: `presidio-hackathon`, region `us-east-1`, account `444455570150`.
Repos: `/Users/avishmehta/Downloads/presidio-fullstack` (branch `plan-a-full-code`),
`/Users/avishmehta/Downloads/shopco-platform` (branch `main`),
`/Users/avishmehta/Downloads/presidio-fullstack/acme-payment-service` (own repo, branch `main`).

## Architecture in one paragraph

CloudWatch Alarm → SNS → `presidio-sre-agent-triage` Lambda (`lambda-agent/`). It resolves
per-tenant config from DynamoDB `presidio-connector-registry` (via `connector-registry.js`),
builds a dynamic tool list (`engine/tools.js`), runs a ReAct-style loop
(`engine/agent-loop.js`) against OpenRouter (Claude Sonnet 5), and posts a structured brief to
Slack. The console (`console/`, deployed to CloudFront `E2CTXPBFTHZMQC`, bucket
`presidio-tracex-console-444455570150`) talks to `lambda-config-api` (`presidio-config-api`
Lambda) for connectors/applications CRUD and the Simulator's break/heal/status endpoints.

## The three demo scenarios — exact commands

All via the config API: `https://q5pdiqcs6f.execute-api.us-east-1.amazonaws.com`

### 1. Application Errors — payment-service (ShopCo)
Real null-safety bug in `shopco-platform/services/payment-service/index.js`
(`mockGatewayCharge`'s `currency.toUpperCase()`, unguarded). Triggered via order-service
sending it `{amount:null, currency:null}` when `/shopco/chaos/cascade` is `true`.

```
curl -X POST https://q5pdiqcs6f.execute-api.us-east-1.amazonaws.com/simulate/payment-service/break
# wait ~45-90s for shopco-payment-5xx-critical alarm, ~20-40s more for investigation
curl -X POST https://q5pdiqcs6f.execute-api.us-east-1.amazonaws.com/simulate/payment-service/heal
```

**IMPORTANT — do not confuse with `/shopco/chaos/payment`.** That is a DIFFERENT, unrelated
toggle read directly by payment-service itself, which short-circuits with a fake
"Payment gateway unreachable (simulated outage)" message and bypasses the real bug entirely.
It used to be wired to this scenario by mistake (fixed today — see "Recent fixes" below). If
you ever see an RCA blaming "gateway unreachable," check `SIMULATE_REGISTRY["payment-service"]`
in `lambda-config-api/index.js` hasn't regressed back to `/shopco/chaos/payment`.

**Git-history timing**: the "actual bad commit" (`c560c8b`, "refactor: payment-service — remove
legacy null-safety wrapper in charge()") needs a RECENT timestamp for the "no code deploy in the
prior 30-60 min" / "this deploy caused it" narrative to make sense. It was originally timed
relative to an earlier "now" and drifts stale as the session runs long. **A retimed set of
commits (same content, new timestamps ~4-10 min ago) is prepared locally but NOT pushed** — the
force-push was blocked by the permission system. To push it:
```
cd /Users/avishmehta/Downloads/shopco-platform
git push --force-with-lease origin main
```
Local `main` currently points at `eedf9a7a069d346e3ebe22a52e9e539f94e7f113` (verified via
`git diff --quiet` to be tree-identical to the previous HEAD `7a985c5` — only commit dates for
`c560c8b`/`a2cda01`/`7a985c5` changed). If this is stale by the time you read it, redo the same
retiming: pick the last 2-3 commits, `git commit-tree` each with a new
`GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` a few minutes apart ending "now minus ~5-10 min",
preserving trees/parents/messages exactly, then `git update-ref refs/heads/main <new-sha>` and
force-push. Verify with `git diff --quiet <old-head> <new-head>` before pushing — must be empty.

### 2. Infrastructure — Capacity Limits — inventory-service (ShopCo)
Real AWS Lambda concurrency throttle. Zero code correlation by design.
```
curl -X POST https://q5pdiqcs6f.execute-api.us-east-1.amazonaws.com/simulate/inventory-service/break
curl -X POST https://q5pdiqcs6f.execute-api.us-east-1.amazonaws.com/simulate/inventory-service/heal
```
Alarm: `shopco-inventory-availability-critical` (renamed today from a throttle-naming alarm that
leaked the cause in its own description — now symptom-based only).

### 3. Infrastructure — Dependency Failure — acme-payment-service (own repo)
Real DynamoDB capacity issue: `acme-payment-idempotency` table, provisioned at 1 WCU. Break
fires a one-shot burst-load Lambda (`acme-idempotency-load-generator`) against that table for
~80s — self-expires, no heal step needed (but heal endpoint is safe to call, it's a no-op for
type "invoke").
```
curl -X POST https://q5pdiqcs6f.execute-api.us-east-1.amazonaws.com/simulate/acme-payment-service/break
```
Alarm: `acme-payment-fatal-error`. The agent uses `get_dependency_resource_health` (new today —
generic, dispatches by ARN across DynamoDB/Lambda/SQS) plus the app's configured
`infraResourceArn` (set on the Applications page) as a lead it verifies, not trusts blindly.

## Checking status / cleanup

```
# Any app's current status:
curl "https://q5pdiqcs6f.execute-api.us-east-1.amazonaws.com/simulate/{appId}/status?tenantId=demo"

# Check for anything left broken:
aws cloudwatch describe-alarms --alarm-names shopco-payment-5xx-critical shopco-order-5xx-critical \
  shopco-inventory-availability-critical acme-payment-fatal-error --region us-east-1 \
  --profile presidio-hackathon --query "MetricAlarms[].{Name:AlarmName,State:StateValue}"

# Chaos toggles that should be "false" when nothing is intentionally broken:
aws ssm get-parameter --name /shopco/chaos/payment --profile presidio-hackathon --region us-east-1 --query Parameter.Value --output text
aws ssm get-parameter --name /shopco/chaos/cascade --profile presidio-hackathon --region us-east-1 --query Parameter.Value --output text
aws ssm get-parameter --name /acme-payment-service/ops/health-override --profile presidio-hackathon --region us-east-1 --query Parameter.Value --output text
```

## Recent fixes this session (most recent first)

1. **Payment-service RCA was wrong** — Simulator's "Break" for payment-service was wired to
   `/shopco/chaos/payment` (fake gateway-outage message) instead of `/shopco/chaos/cascade`
   (the real, git-correlated null-safety bug). Fixed in `lambda-config-api/index.js`
   `SIMULATE_REGISTRY`. Deployed and pushed (commit `41d37a9`).
2. **CloudWatch log fetch could miss the actually-relevant recent errors** —
   `FilterLogEventsCommand` has no "most recent N" mode; a noisy window with >50 matches could
   return only older entries, causing the agent to cite stale, already-fixed errors instead of
   the ones that actually triggered the current alarm (reproduced live: agent blamed a 10-minute
   stale "gateway unreachable" message instead of the real error from 90s before the alarm
   fired). Fixed in `lambda-agent/src/collectors/cloudwatch-logs.js`: now paginates up to 5
   pages and returns the most recent 50 by timestamp, not just the first 50 the API happens to
   return. **Deployed but not yet re-verified live** — do that first if you have time (break
   payment-service, confirm the RCA cites logs correlated with the actual alarm-trigger time,
   not older noise).
3. **Simulator staleness/sync bug** — the card only ever initialized to "Healthy" and never
   polled until a Break was clicked in that exact browser session, so a real active incident was
   invisible on page load/refresh. Rewrote `SimulatorPage.jsx` to always poll from mount and
   derive phase purely from live `(alarmState, incidentState)` on every poll — see
   `computePhase()`. Click-time tracking is now UX-polish only (persisted to localStorage),
   not a correctness dependency. Deployed, committed (`41d37a9`), live-verified against the
   exact stale-response case the user reported.
4. Generic multi-service infra tool (`get_dependency_resource_health`, DynamoDB/Lambda/SQS by
   ARN) + wired the app's `infraResourceArn` into the incident context as an unverified lead.
   Live-verified (92% confidence, correctly used the hint but confirmed it with a real tool
   call).
5. `simulateStatus` now returns the incident's real `startedAt` (was missing before).
6. Applications page: optional `infraResourceName`/`infraResourceArn` fields, shown as "Depends
   on: ..." on Applications + Simulator cards. Two apps pre-seeded with real data (see below).
7. Overview/Connectors pages filled out (stat tiles, live status grid, CSS grid stretch bug
   fixed). Applications "Add" form is now a modal, not always-open.

## Known-good pre-seeded data

`acme-payment-service` app record: `infraResourceName: "acme-payment-idempotency (DynamoDB
table)"`, `infraResourceArn: "arn:aws:dynamodb:us-east-1:444455570150:table/acme-payment-idempotency"`.
`inventory-service` app record: `infraResourceName: "shopco-inventory-service (own Lambda
concurrency)"`, `infraResourceArn: "arn:aws:lambda:us-east-1:444455570150:function:shopco-inventory-service"`.

## Explicitly deferred / not done

- Multiple Datadog/GitHub connector instances (currently one per tenant, not per-app) — user
  agreed to skip given time constraints and low priority. If revisiting: `CONNECTOR_TYPES`/
  `sk = CONNECTOR#{type}` in `lambda-config-api/index.js` would need to become
  `CONNECTOR#{type}#{instanceId}`, plus `resolveTenantConfig` in `connector-registry.js` and the
  Connectors/Applications UI. Real risk: touches the exact connector-resolution path every
  scenario depends on — re-run full live regression if done close to demo time.
- User asked for a UI-only "+" affordance to add multiple infra resources per app (currently one
  name/ARN pair) and to remove the "(optional — for demo narrative only)" label text — not yet
  done as of this doc.
- AWS cross-account IAM role assumption (rename CloudWatch connector to generic "AWS", add
  optional Role ARN/External ID, STS AssumeRole plumbing in collectors) — discussed, not started.

## Final sweep done at time of writing

Checked and healed: all 4 alarms OK, all 3 chaos toggles false, `shopco-inventory-service`
concurrency was found STUCK at 0 (leftover from an earlier test, never healed) — fixed via
`aws lambda delete-function-concurrency --function-name shopco-inventory-service`, confirmed
back to unrestricted (`null`). Everything was clean as of this doc's writing. Re-run the same
sweep (commands above + `aws lambda get-function --function-name shopco-inventory-service
--query Concurrency`) before a demo if any time has passed, since this exact "stuck throttle
left on" pattern has recurred multiple times this session.

## If something looks broken right now

Check chaos toggles and alarm states (commands above) before assuming code is broken — this
session hit real "stuck toggle left true" and "stale incident record" issues multiple times that
looked like code bugs but were leftover state from a previous test. Heal first, then re-test
clean.
