#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
FUNCTION_NAME="${TRACEX_DEMO_FUNCTION:-acme-payment-service}"
SCENARIO="${1:-}"
RESPONSE_FILE="/tmp/tracex-trigger-response.json"

usage() {
  echo "Usage: ./trigger-alert.sh <4xx|5xx|latency|fatal|status>"
}

invoke_scenario() {
  local scenario="$1"
  local count="$2"
  local payload="{\"testScenario\":\"${scenario}\"}"

  for ((i = 1; i <= count; i++)); do
    aws lambda invoke \
      --function-name "$FUNCTION_NAME" \
      --cli-binary-format raw-in-base64-out \
      --payload "$payload" \
      --region "$REGION" \
      "$RESPONSE_FILE" >/dev/null
    echo "Generated ${scenario} event ${i}/${count}"
  done
}

case "$SCENARIO" in
  4xx)
    invoke_scenario "4xx" 5
    echo "Waiting for acme-payment-4xx-warning to evaluate."
    ;;
  5xx)
    aws ssm put-parameter \
      --name "/acme-payment-service/ops/health-override" \
      --value "true" \
      --type String \
      --overwrite \
      --region "$REGION" >/dev/null
    echo "Chaos mode enabled; waiting 10 seconds for the application cache."
    sleep 10
    for ((i = 1; i <= 10; i++)); do
      aws lambda invoke \
        --function-name "$FUNCTION_NAME" \
        --cli-binary-format raw-in-base64-out \
        --payload '{}' \
        --region "$REGION" \
        "$RESPONSE_FILE" >/dev/null
      echo "Generated 5xx traffic ${i}/10"
    done
    echo "Waiting for acme-payment-5xx-critical to evaluate. Run ./heal-it.sh after the test."
    ;;
  latency)
    invoke_scenario "latency" 10
    echo "Waiting for acme-payment-high-latency to evaluate."
    ;;
  fatal)
    invoke_scenario "fatal" 1
    echo "Waiting for acme-payment-fatal-error to evaluate."
    ;;
  status)
    aws cloudwatch describe-alarms \
      --alarm-name-prefix "acme-payment" \
      --region "$REGION" \
      --query 'MetricAlarms[].{Alarm:AlarmName,State:StateValue,Reason:StateReason}' \
      --output table
    ;;
  *)
    usage
    exit 1
    ;;
esac

if [[ "$SCENARIO" != "status" ]]; then
  echo
  echo "Check states: ./trigger-alert.sh status"
  echo "Agent logs:  aws logs tail /aws/lambda/presidio-sre-agent-triage --follow --region $REGION"
  echo "Slack:       parent alert first, agent report inside its thread"
fi
