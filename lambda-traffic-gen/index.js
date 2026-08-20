// lambda-traffic-gen/index.js
// ═══════════════════════════════════════════════════════════════
//  TRAFFIC GENERATOR — Simulates production traffic
//
//  Runs every 1 minute via CloudWatch Events.
//  Sends 10 requests per invocation to the payment API.
//  This creates a steady stream of logs and metrics.
// ═══════════════════════════════════════════════════════════════

const https = require("https");
const http = require("http");

exports.handler = async () => {
  const apiUrl = process.env.PAYMENT_API_URL;
  if (!apiUrl) {
    console.log("PAYMENT_API_URL not set — skipping");
    return { statusCode: 200, body: "skipped" };
  }

  const REQUESTS_PER_BATCH = 10;
  const results = { success: 0, errors: 0 };

  // Send requests in parallel
  const promises = [];
  for (let i = 0; i < REQUESTS_PER_BATCH; i++) {
    promises.push(
      makeRequest(apiUrl)
        .then((code) => {
          if (code >= 200 && code < 400) results.success++;
          else results.errors++;
        })
        .catch(() => results.errors++)
    );
  }

  await Promise.all(promises);

  console.log(JSON.stringify({
    event: "traffic_batch_complete",
    totalRequests: REQUESTS_PER_BATCH,
    success: results.success,
    errors: results.errors,
    errorRate: `${((results.errors / REQUESTS_PER_BATCH) * 100).toFixed(0)}%`,
    timestamp: new Date().toISOString(),
  }));

  return { statusCode: 200, body: JSON.stringify(results) };
};

function makeRequest(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" }, timeout: 10000 },
      (res) => {
        res.on("data", () => {}); // drain
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(JSON.stringify({
      amount: (Math.random() * 500 + 10).toFixed(2),
      currency: Math.random() > 0.1 ? "USD" : null, // 10% null currency — triggers the bug
      customerId: `cust_${Math.random().toString(36).substr(2, 8)}`,
    }));
    req.end();
  });
}
