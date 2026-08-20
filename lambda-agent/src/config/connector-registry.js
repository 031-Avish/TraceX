// src/config/connector-registry.js
// Reads per-tenant connector + application config — what a customer entered
// themselves via the console UI (see console/index.html and
// lambda-config-api/). This is what makes the tool list per-incident instead
// of hardcoded: a tenant with no GitHub connector configured simply doesn't
// get a get_recent_commits tool offered to the agent.
//
// DynamoDB (single-table design) holds ONLY non-sensitive scope metadata:
//   pk = tenantId
//   sk = "CONNECTOR#github" | "CONNECTOR#slack" | "APP#<appId>"
// The actual token/bot-token value lives in Secrets Manager (encrypted with
// a dedicated customer-managed KMS key — see terraform/connectors.tf) and is
// fetched here, at investigation time, only for the connectors this specific
// app actually uses. Never persisted anywhere beyond this request's memory.
//
// Falls back to null on any failure (no table, no row, no secret) so the
// existing env-var-driven single-tenant demo keeps working even if nobody has
// touched the console yet — see handler.js for the fallback merge.

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

const TABLE_NAME = process.env.CONNECTOR_TABLE_NAME;

let docClient = null;
function getDocClient() {
  if (!docClient) {
    const raw = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
    docClient = DynamoDBDocumentClient.from(raw);
  }
  return docClient;
}

let smClient = null;
function getSecretsClient() {
  if (!smClient) smClient = new SecretsManagerClient({ region: process.env.AWS_REGION || "us-east-1" });
  return smClient;
}

async function getSecretToken(secretRef) {
  if (!secretRef) return null;
  try {
    const response = await getSecretsClient().send(new GetSecretValueCommand({ SecretId: secretRef }));
    const parsed = JSON.parse(response.SecretString || "{}");
    return parsed.token || null;
  } catch (error) {
    console.warn(`  ⚠ Could not read secret ${secretRef}: ${error.message}`);
    return null;
  }
}

/**
 * Look up the full config for one tenant+app: the app's CloudWatch scope
 * plus whichever GitHub/Slack connector credentials the tenant configured,
 * with the actual secret values fetched from Secrets Manager. Returns null
 * if nothing is found for this tenant/app — callers should treat that as
 * "use the env-var defaults".
 */
async function resolveTenantConfig(tenantId, appId) {
  if (!TABLE_NAME || !tenantId) return null;

  try {
    const response = await getDocClient().send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "tenantId = :t",
        ExpressionAttributeValues: { ":t": tenantId },
      })
    );

    const items = response.Items || [];
    if (!items.length) return null;

    const connectors = {};
    let app = null;

    for (const item of items) {
      if (item.sk.startsWith("CONNECTOR#")) {
        connectors[item.sk.replace("CONNECTOR#", "")] = item.config;
      } else if (item.sk === `APP#${appId}`) {
        app = item.config;
      }
    }

    if (!app) return null;

    const [githubToken, slackToken] = await Promise.all([
      connectors.github ? getSecretToken(connectors.github.secretRef) : null,
      connectors.slack ? getSecretToken(connectors.slack.secretRef) : null,
    ]);

    return {
      logGroupName: app.logGroupName,
      metricNamespace: app.metricNamespace,
      alarmName: app.alarmName,
      github:
        connectors.github && githubToken
          ? { token: githubToken, owner: app.githubRepoOwner || connectors.github.owner, repo: app.githubRepoName || connectors.github.repo }
          : null,
      slack:
        connectors.slack && slackToken
          ? { token: slackToken, channelId: app.slackChannelId || connectors.slack.channelId }
          : null,
    };
  } catch (error) {
    console.warn(`  ⚠ Connector registry lookup failed (falling back to env vars): ${error.message}`);
    return null;
  }
}

module.exports = { resolveTenantConfig };
