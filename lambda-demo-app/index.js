// lambda-demo-app/index.js
// ═══════════════════════════════════════════════════════════════
//  FAKE PAYMENT SERVICE
//
//  - Reads SSM chaos switch to decide healthy vs broken
//  - Reads BREAKING_COMMIT_SHA env var to log the REAL Git SHA
//  - Logs realistic JSON that looks like a Spring Boot Java app
//
//  The triage agent will pull these logs AND your GitHub commits.
//  Claude will match the SHA in the logs to the commit in GitHub.
// ═══════════════════════════════════════════════════════════════

const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const ssm = new SSMClient({});

// The REAL SHA from your GitHub repo — passed via Terraform env var
const COMMIT_SHA = process.env.BREAKING_COMMIT_SHA || "a3f8b2c";
const COMMIT_MSG = process.env.BREAKING_COMMIT_MSG || "refactor: payment service cleanup - remove legacy null checks";
const AUTHOR     = process.env.BREAKING_COMMIT_AUTHOR || "dev-jsmith";

let cachedChaos = null;
let cacheExpiry = 0;

async function isChaosMode() {
  if (Date.now() < cacheExpiry) return cachedChaos;
  try {
    const resp = await ssm.send(new GetParameterCommand({
      Name: process.env.CHAOS_PARAM_NAME || "/presidio-demo/chaos-mode",
    }));
    cachedChaos = resp.Parameter.Value === "true";
    cacheExpiry = Date.now() + 10000;
    return cachedChaos;
  } catch { return false; }
}

exports.handler = async (event) => {
  let requestBody = {};
  try {
    requestBody = typeof event?.body === "string" ? JSON.parse(event.body) : (event?.body || event || {});
  } catch {
    requestBody = {};
  }

  const testScenario = requestBody.testScenario;
  const chaos = await isChaosMode();
  const traceId = `trace-${Math.random().toString(36).substr(2, 16)}`;
  const amount = (Math.random() * 500 + 10).toFixed(2);

  // Deterministic alarm test cases. These are intentionally opt-in and make it
  // possible to prove each CloudWatch metric/alarm path without random traffic.
  if (testScenario === "4xx") {
    console.log(JSON.stringify({
      level: "WARN",
      timestamp: new Date().toISOString(),
      service: "payment-service",
      endpoint: "/api/payments",
      method: "POST",
      statusCode: 400,
      responseTimeMs: 18,
      traceId,
      error: { type: "ValidationError", message: "Payment currency is required" },
      message: "Payment request rejected by validation",
    }));
    return { statusCode: 400, body: JSON.stringify({ status: "error", message: "Payment currency is required" }) };
  }

  if (testScenario === "latency") {
    console.log(JSON.stringify({
      level: "WARN",
      timestamp: new Date().toISOString(),
      service: "payment-service",
      endpoint: "/api/payments",
      method: "POST",
      statusCode: 200,
      responseTimeMs: 1200,
      traceId,
      message: "Payment processed with abnormal downstream latency",
    }));
    return { statusCode: 200, body: JSON.stringify({ status: "success", amount }) };
  }

  if (testScenario === "fatal") {
    console.log(JSON.stringify({
      level: "FATAL",
      timestamp: new Date().toISOString(),
      service: "payment-service",
      endpoint: "/api/payments",
      method: "POST",
      statusCode: 500,
      responseTimeMs: 800,
      traceId,
      error: { type: "DatabaseUnavailable", message: "Payment ledger is unavailable" },
      message: "CRITICAL: Payment processing cannot continue",
    }));
    return { statusCode: 500, body: JSON.stringify({ status: "error", message: "Payment processing unavailable" }) };
  }

  // ════════════ HEALTHY MODE ════════════
  if (!chaos) {
    console.log(JSON.stringify({
      level: "INFO",
      timestamp: new Date().toISOString(),
      service: "payment-service",
      version: "2.4.0",
      taskDefinition: "payment-service:46",
      endpoint: "/api/payments",
      method: "POST",
      statusCode: 200,
      responseTimeMs: Math.floor(Math.random() * 40) + 12,
      traceId,
      amount, currency: "USD",
      message: "Payment processed successfully",
    }));
    return { statusCode: 200, body: JSON.stringify({ status: "success", amount }) };
  }

  // ════════════ CHAOS MODE ════════════

  // Log deployment event once (so agent sees WHEN the bad deploy happened)
  if (!global._deployLogged) {
    console.log(JSON.stringify({
      level: "INFO",
      timestamp: new Date(Date.now() - 120000).toISOString(),
      service: "ecs-deploy",
      event: "DEPLOYMENT_STARTED",
      taskDefinition: "payment-service:47",
      previousTaskDefinition: "payment-service:46",
      deployedBy: "ci/github-actions",
      pipelineId: "run-8847",
      // ──── THIS IS THE REAL SHA FROM YOUR GITHUB REPO ────
      commitSha: COMMIT_SHA,
      commitMessage: COMMIT_MSG,
      author: AUTHOR,
      // ────────────────────────────────────────────────────
      image: `acme/payment-service:2.4.1`,
      message: "ECS rolling deployment initiated for payment-service",
    }));

    console.log(JSON.stringify({
      level: "INFO",
      timestamp: new Date(Date.now() - 90000).toISOString(),
      service: "ecs-deploy",
      event: "DEPLOYMENT_COMPLETED",
      taskDefinition: "payment-service:47",
      runningCount: 4,
      message: "All 4 tasks running new version payment-service:47",
    }));

    global._deployLogged = true;
  }

  // 15% still succeed (realistic — not every request hits the bug)
  if (Math.random() < 0.15) {
    console.log(JSON.stringify({
      level: "INFO",
      timestamp: new Date().toISOString(),
      service: "payment-service", version: "2.4.1",
      taskDefinition: "payment-service:47",
      endpoint: "/api/payments", method: "POST",
      statusCode: 200,
      responseTimeMs: Math.floor(Math.random() * 60) + 25,
      traceId,
      message: "Payment processed successfully",
    }));
    return { statusCode: 200, body: JSON.stringify({ status: "success" }) };
  }

  // 85% fail with NullPointerException
  console.log(JSON.stringify({
    level: "ERROR",
    timestamp: new Date().toISOString(),
    service: "payment-service",
    version: "2.4.1",
    taskDefinition: "payment-service:47",
    traceId,
    endpoint: "/api/payments",
    method: "POST",
    statusCode: 500,
    responseTimeMs: Math.floor(Math.random() * 300) + 400,
    error: {
      type: "NullPointerException",
      message: `Cannot invoke "String.length()" because "Payment.getCurrency()" is null`,
      stackTrace: [
        `java.lang.NullPointerException`,
        `    at com.acme.payment.validation.PaymentValidator.validate(PaymentValidator.java:89)`,
        `    at com.acme.payment.processor.PaymentProcessor.processPayment(PaymentProcessor.java:142)`,
        `    at com.acme.payment.controller.PaymentController.handlePost(PaymentController.java:67)`,
        `    Caused by: null-safety wrapper removed in commit ${COMMIT_SHA}`,
      ].join("\n"),
    },
    message: "Payment processing failed: null currency after validation refactor",
  }));

  // Occasional FATAL with business impact numbers
  if (Math.random() < 0.08) {
    console.log(JSON.stringify({
      level: "FATAL",
      timestamp: new Date().toISOString(),
      service: "payment-service",
      endpoint: "/api/payments",
      error: {
        type: "NullPointerException",
        rootCauseHint: `PaymentValidator.validate() null-safety removed in commit ${COMMIT_SHA}`,
      },
      metrics: {
        failedTransactions: Math.floor(Math.random() * 200) + 600,
        successRate: "14.2%",
        estimatedRevenueImpactPerHour: "$42,350",
      },
      message: "CRITICAL: Payment pipeline broken — 85%+ failure rate",
    }));
  }

  return { statusCode: 500, body: JSON.stringify({ status: "error", message: "Payment processing failed" }) };
};
