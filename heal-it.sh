#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  ✅ HEAL IT — Reset the service to healthy state
# ═══════════════════════════════════════════════════════════════

echo ""
echo "✅ Healing the payment service..."

aws ssm put-parameter \
  --name "/presidio-demo/chaos-mode" \
  --value "false" \
  --type String \
  --overwrite \
  --region us-east-1 \
  > /dev/null

echo ""
echo "   ✓ Chaos mode DISABLED — service will recover within 60s"
echo "   ✓ Ready for the next demo run"
echo ""

# Also reset alarm state to OK
aws cloudwatch set-alarm-state \
  --alarm-name "acme-payment-5xx-critical" \
  --state-value OK \
  --state-reason "Manual reset after demo" \
  --region us-east-1 \
  2>/dev/null

echo "   ✓ Alarm reset to OK"
echo ""
