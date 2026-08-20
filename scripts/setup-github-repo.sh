#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  SETUP DEMO GITHUB REPO
#  
#  Creates a realistic repo with commits. The LAST commit is 
#  the "breaking" one that the agent should identify as root cause.
#
#  After running this, it prints the SHA — paste it into
#  terraform/terraform.tfvars as breaking_commit_sha.
# ═══════════════════════════════════════════════════════════════

set -e
REPO_NAME="acme-payment-service"
TMPDIR=$(mktemp -d)
cd "$TMPDIR"

echo ""
echo "═══════════════════════════════════════════════"
echo "  CREATING DEMO GITHUB REPO"
echo "═══════════════════════════════════════════════"
echo ""

git init "$REPO_NAME" -b main
cd "$REPO_NAME"
git config user.email "dev@acme-corp.com"
git config user.name "dev-jsmith"

mkdir -p src/main/java/com/acme/payment/validation

# ── Commit 1: Initial code WITH null-safety ──
cat > src/main/java/com/acme/payment/validation/PaymentValidator.java << 'JAVA'
package com.acme.payment.validation;

public class PaymentValidator {
    public boolean validate(Payment payment) {
        if (payment == null) return false;
        if (payment.getAmount() <= 0) return false;
        if (payment.getCurrency() == null || payment.getCurrency().isEmpty()) return false;
        return true;
    }
}
JAVA
git add . && git commit -m "feat: initial payment service with validation"

# ── Commits 2-5: Normal dev work ──
echo "// logging" >> src/main/java/com/acme/payment/validation/PaymentValidator.java
git add . && git commit -m "feat: add structured logging for payment flow"

echo "// metrics" >> src/main/java/com/acme/payment/validation/PaymentValidator.java
git add . && git commit -m "feat: add prometheus metrics for latency tracking"

echo "// timeout" >> src/main/java/com/acme/payment/validation/PaymentValidator.java
git add . && git commit -m "fix: increase gateway timeout from 10s to 30s"

echo "// deps" >> src/main/java/com/acme/payment/validation/PaymentValidator.java
git add . && git commit -m "chore: update Spring Boot to 3.2.1"

# ════════════════════════════════════════════════════════
# ── Commit 6: THE BREAKING COMMIT (removes null checks) ──
# ════════════════════════════════════════════════════════
cat > src/main/java/com/acme/payment/validation/PaymentValidator.java << 'JAVA'
package com.acme.payment.validation;

public class PaymentValidator {
    public boolean validate(Payment payment) {
        return payment.getAmount() > 0 && payment.getCurrency().length() > 0;
    }
}
JAVA
git add . && git commit -m "refactor: payment service cleanup - remove legacy null checks"

BREAKING_SHA=$(git rev-parse --short HEAD)

echo ""
echo "═══════════════════════════════════════════════"
echo "  ✓ REPO CREATED — 6 commits"
echo "═══════════════════════════════════════════════"
echo ""
echo "  Location: $TMPDIR/$REPO_NAME"
echo ""
echo "  ┌────────────────────────────────────────────────────────┐"
echo "  │                                                        │"
echo "  │  BREAKING COMMIT SHA:  $BREAKING_SHA                         │"
echo "  │                                                        │"
echo "  └────────────────────────────────────────────────────────┘"
echo ""
echo "  NOW DO THESE STEPS:"
echo ""
echo "  STEP A — Push to GitHub:"
echo "    cd $TMPDIR/$REPO_NAME"
echo "    gh repo create $REPO_NAME --public --source=. --push"
echo ""
echo "  STEP B — Add to terraform/terraform.tfvars:"
echo ""
echo "    breaking_commit_sha = \"$BREAKING_SHA\""
echo "    github_repo_owner   = \"YOUR_GITHUB_USERNAME\""
echo "    github_repo_name    = \"$REPO_NAME\""
echo ""
echo "  STEP C — Deploy:"
echo "    ./deploy.sh"
echo ""
