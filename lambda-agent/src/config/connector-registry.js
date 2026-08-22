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

async function getSecret(secretRef) {
  if (!secretRef) return {};
  try {
    const response = await getSecretsClient().send(new GetSecretValueCommand({ SecretId: secretRef }));
    const parsed = JSON.parse(response.SecretString || "{}");
    return parsed;
  } catch (error) {
    console.warn(`  ⚠ Could not read secret ${secretRef}: ${error.message}`);
    return {};
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

    // Build the list of observability sources actually available for this app —
    // not a single provider "choice". CloudWatch is always included: the alarm
    // that triggered this investigation is a CloudWatch alarm, so its metric and
    // log group are always relevant ground truth. Any other connected+ready
    // provider is added alongside it, letting the agent itself decide which
    // source(s) to query per incident instead of the registry picking for it.
    // Add an entry here for each new observability connector type as its
    // collector is built — nothing else in the agent needs to change.
    const OBSERVABILITY_SOURCE_BUILDERS = {
      datadog: (connector, secret) =>
        secret.apiKey && {
          provider: "datadog",
          apiKey: secret.apiKey,
          appKey: secret.appKey,
          site: connector.site || "us1",
          service: app.serviceName || appId,
          environment: app.environment,
          errorQuery: app.errorQuery,
          deploymentQuery: app.deploymentQuery,
          metricQuery: app.metricQuery,
          monitorId: app.monitorId,
        },
    };

    const observabilityConnectorTypes = Object.keys(OBSERVABILITY_SOURCE_BUILDERS).filter((type) => connectors[type]);
    const [githubSecret, slackSecret, ...observabilitySecrets] = await Promise.all([
      connectors.github ? getSecret(connectors.github.secretRef) : {},
      connectors.slack ? getSecret(connectors.slack.secretRef) : {},
      ...observabilityConnectorTypes.map((type) => getSecret(connectors[type].secretRef)),
    ]);

    const observabilitySources = [{ provider: "cloudwatch" }];
    observabilityConnectorTypes.forEach((type, i) => {
      const source = OBSERVABILITY_SOURCE_BUILDERS[type](connectors[type], observabilitySecrets[i]);
      if (source) observabilitySources.push(source);
    });

    return {
      logGroupName: app.logGroupName,
      metricNamespace: app.metricNamespace,
      alarmName: app.alarmName,
      // Optional, presenter-entered metadata (Applications page — "Related
      // infra resource"): the specific downstream AWS resource this app is
      // known to depend on. Purely informational — surfaced to the model as
      // one more fact in the incident summary so it can go straight to
      // get_dependency_resource_health instead of having to infer an ARN
      // from log text alone; the agent still verifies with real tool calls
      // rather than trusting this at face value.
      infraResourceName: app.infraResourceName || null,
      infraResourceArn: app.infraResourceArn || null,
      observabilitySources,
      github:
        connectors.github && githubSecret.token
          ? {
              token: githubSecret.token,
              owner: app.githubRepoOwner || connectors.github.owner,
              repo: app.githubRepoName || connectors.github.repo,
              // Scopes commit lookups to this service's own directory when
              // multiple services share one repo, so an unrelated service's
              // commit can't get pulled into this investigation.
              path: app.githubPath || null,
            }
          : null,
      slack:
        connectors.slack && slackSecret.token
          ? { token: slackSecret.token, channelId: app.slackChannelId || connectors.slack.channelId }
          : null,
    };
  } catch (error) {
    console.warn(`  ⚠ Connector registry lookup failed (falling back to env vars): ${error.message}`);
    return null;
  }
}

module.exports = { resolveTenantConfig };
