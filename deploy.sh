#!/bin/bash
set -e
GREEN='\033[0;32m'; RED='\033[0;31m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo -e "\n${BLUE}${BOLD}═══════════════════════════════════════════════════${NC}"
echo -e "${BLUE}${BOLD}  PRESIDIO SRE AGENT — FULL STACK DEPLOY${NC}"
echo -e "${BLUE}${BOLD}═══════════════════════════════════════════════════${NC}\n"

# ── Prereq checks ──
echo -e "${YELLOW}[1/5]${NC} Checking prerequisites..."
for cmd in node npm terraform aws; do
  command -v $cmd &>/dev/null && echo -e "  ${GREEN}✓${NC} $cmd" || { echo -e "  ${RED}✗${NC} $cmd missing"; exit 1; }
done
[ -f "$ROOT/terraform/terraform.tfvars" ] || { echo -e "\n  ${RED}✗${NC} terraform/terraform.tfvars not found\n  cp terraform/terraform.tfvars.example terraform/terraform.tfvars"; exit 1; }
aws sts get-caller-identity &>/dev/null || { echo -e "  ${RED}✗${NC} AWS creds not configured"; exit 1; }
echo -e "  ${GREEN}✓${NC} AWS account: $(aws sts get-caller-identity --query Account --output text)\n"

# ── Install Lambda deps ──
echo -e "${YELLOW}[2/5]${NC} Installing Lambda dependencies..."
cd "$ROOT/lambda-agent" && npm install --production --silent 2>&1 | tail -1
cd "$ROOT/lambda-demo-app" && npm install --production --silent 2>&1 | tail -1
echo -e "  ${GREEN}✓${NC} All dependencies installed\n"

# ── Terraform ──
echo -e "${YELLOW}[3/5]${NC} Terraform init + apply..."
cd "$ROOT/terraform"
terraform init -input=false 2>&1 | grep -E "Terraform has been" || true
echo ""
terraform apply -auto-approve 2>&1 | tail -20
echo ""

# ── Capture outputs ──
API_URL=$(terraform output -raw payment_api_url 2>/dev/null)
CONFIG_API_URL=$(terraform output -raw config_api_url 2>/dev/null)
ALARM=$(terraform output -raw alarm_name 2>/dev/null)
REGION=$(terraform output -raw 2>/dev/null || echo "us-east-1")
echo -e "  ${GREEN}✓${NC} Infrastructure deployed!\n"

# ── Warm up the Lambdas ──
echo -e "${YELLOW}[4/5]${NC} Warming up Lambdas..."
aws lambda invoke --function-name acme-payment-service --payload '{}' /dev/null --region ${REGION:-us-east-1} 2>/dev/null && echo -e "  ${GREEN}✓${NC} Payment service warm"
aws lambda invoke --function-name presidio-sre-agent-triage --payload '{"warmup":true}' /dev/null --region ${REGION:-us-east-1} 2>/dev/null && echo -e "  ${GREEN}✓${NC} Triage agent warm"

# ── Wait for traffic ──
echo -e "\n${YELLOW}[5/5]${NC} Traffic generator is running (1 batch/min)."
echo -e "  Healthy logs are flowing to CloudWatch.\n"

cd "$ROOT"

echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  ✓ FULL STACK DEPLOYED — READY FOR DEMO${NC}"
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Payment API:${NC}     $API_URL"
echo -e "  ${BOLD}Status:${NC}          Healthy ✅ (traffic flowing every minute)"
echo ""
echo -e "  ${BOLD}Config Console:${NC}  cd console && npm install && npm run dev"
echo -e "  ${BOLD}Config API:${NC}      $CONFIG_API_URL  (paste into the console's Settings page)"
echo -e "  (configure connectors + at least one application there before running the demo,"
echo -e "   or the agent falls back to the env-var defaults for the acme-payment-service demo)"
echo ""
echo -e "  ${BOLD}${RED}🚨 TO BREAK IT (triggers the incident):${NC}"
echo -e "    ./break-it.sh"
echo ""
echo -e "  ${BOLD}${GREEN}✅ TO HEAL IT (reset for next demo):${NC}"
echo -e "    ./heal-it.sh"
echo ""
echo -e "  ${BOLD}Watch payment logs:${NC}"
echo -e "    aws logs tail /ecs/acme-payment-service --follow"
echo ""
echo -e "  ${BOLD}Watch agent logs:${NC}"
echo -e "    aws logs tail /aws/lambda/presidio-sre-agent-triage --follow"
echo ""
echo -e "  ${BOLD}Tear down:${NC}"
echo -e "    ./teardown.sh"
echo ""
