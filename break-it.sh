#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  🚨 BREAK IT — Flip the chaos switch
#
#  What happens:
#    1. SSM parameter set to "true"
#    2. Next traffic batch (within 60s) starts getting 500s
#    3. Error logs flow to CloudWatch
#    4. Metric filter counts them
#    5. CloudWatch alarm fires (within 1-2 minutes)
#    6. SNS triggers the triage agent Lambda
#    7. Agent analyzes logs + metrics + Git commits via Claude
#    8. Triage Brief posted to Slack
#
#  Total time from break to Slack: ~2-3 minutes
# ═══════════════════════════════════════════════════════════════

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/terraform"
REGION=$(terraform output -raw 2>/dev/null | head -1 || echo "us-east-1")
REGION="${REGION:-us-east-1}"

echo ""
echo "🚨 ═══════════════════════════════════════════════════"
echo "   BREAKING THE PAYMENT SERVICE"
echo "   ═══════════════════════════════════════════════════"
echo ""
echo "   Flipping chaos switch to TRUE..."
echo ""

aws ssm put-parameter \
  --name "/presidio-demo/chaos-mode" \
  --value "true" \
  --type String \
  --overwrite \
  --region us-east-1 \
  > /dev/null

echo "   ✓ Chaos mode ENABLED"
echo ""
echo "   📡 What happens now:"
echo "   ├── Traffic generator will hit broken service (within 60s)"
echo "   ├── 500 errors flow to CloudWatch Logs"
echo "   ├── Metric filter counts 5xx errors"
echo "   ├── CloudWatch alarm fires (1-2 minutes)"
echo "   ├── SNS triggers triage agent Lambda"
echo "   ├── Agent pulls logs + metrics + Git commits"
echo "   ├── Claude analyzes root cause"
echo "   └── Triage Brief appears in Slack"
echo ""
echo "   ⏱  Expected time to Slack: ~2-3 minutes"
echo ""
echo "   👀 Watch it happen:"
echo "      Terminal 1:  aws logs tail /ecs/acme-payment-service --follow"
echo "      Terminal 2:  aws logs tail /aws/lambda/presidio-sre-agent-triage --follow"
echo "      Slack:       Watch #noc-acme-incidents"
echo ""
