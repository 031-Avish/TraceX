// test/test-agent-local.js
// Runs the full agent pipeline locally (real AWS/GitHub/Slack calls, no Lambda deploy needed).
// Requires: `npm install` in lambda-agent/, a filled-in .env (see .env.example), and AWS
// credentials configured (`aws configure`) with access to the log group / metrics used below.
//
// Usage: node test/test-agent-local.js

require("dotenv").config();
const handler = require("../src/handler");

// Simulate an SNS event from a CloudWatch Alarm — same shape the real pipeline delivers.
const mockSnsEvent = {
  Records: [
    {
      Sns: {
        Timestamp: new Date().toISOString(),
        Message: JSON.stringify({
          AlarmName: "acme-payment-5xx-critical",
          AlarmDescription: "P1: Payment service 5xx error rate exceeded threshold",
          NewStateValue: "ALARM",
          NewStateReason: "Threshold crossed: 15 datapoints >= 5.0",
          Region: process.env.AWS_REGION || "us-east-1",
        }),
      },
    },
  ],
};

console.log("Starting local agent test...\n");
console.log("(Make sure ./break-it.sh has been run recently, or logs won't show a real incident.)\n");

handler
  .main(mockSnsEvent)
  .then((result) => {
    console.log("\nResult:", JSON.stringify(JSON.parse(result.body), null, 2));
  })
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
