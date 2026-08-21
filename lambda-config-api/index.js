// lambda-config-api/index.js
// ═══════════════════════════════════════════════════════════════
//  CONNECTOR CONFIG API — backs the self-service console UI
//
//  Lets a customer configure their own GitHub/Slack credentials and map
//  applications to a CloudWatch log group/namespace/alarm, without anyone
//  touching Terraform or env vars. The triage agent reads this config at
//  investigation time (see lambda-agent/src/config/connector-registry.js).
//
//  Secret handling: DynamoDB stores ONLY non-sensitive scope metadata (repo
//  owner/name, Slack channel ID) + a pointer to a Secrets Manager secret.
//  The actual token/bot-token value is written to Secrets Manager, encrypted
//  with a dedicated customer-managed KMS key (see terraform/connectors.tf),
//  and is never returned to the browser after it's saved — the console only
//  ever sees "connected: true/false", never the value.
//
//  Deliberately minimal beyond that for the hackathon: no auth on this API,
//  one shared table/KMS key rather than per-tenant keys. Real multi-tenant
//  auth + per-tenant KMS keys are production-roadmap items — see PLAN.md.
// ═══════════════════════════════════════════════════════════════

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, PutCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
const {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  GetSecretValueCommand,
  DeleteSecretCommand,
} = require("@aws-sdk/client-secrets-manager");

const raw = new DynamoDBClient({});
const db = DynamoDBDocumentClient.from(raw);
const sm = new SecretsManagerClient({});
const TABLE_NAME = process.env.CONNECTOR_TABLE_NAME;
const KMS_KEY_ID = process.env.CONNECTOR_KMS_KEY_ID;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const CONNECTOR_TYPES = new Set(["cloudwatch", "github", "slack", "datadog"]);
const SECRET_FIELDS = new Set(["token", "apiKey", "appKey"]);

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const path = event.rawPath || "/";
  const qs = event.queryStringParameters || {};

  if (method === "OPTIONS") {
    return respond(204, "");
  }

  try {
    if (path === "/connectors" && method === "GET") return await listConnectors(qs.tenantId);
    if (path === "/connectors" && method === "PUT") return await putConnector(JSON.parse(event.body || "{}"));
    if (path === "/connectors/test" && method === "POST") return await testConnector(JSON.parse(event.body || "{}"));
    if (path.startsWith("/connectors/") && method === "DELETE") {
      const type = decodeURIComponent(path.split("/")[2]);
      return await deleteConnector(qs.tenantId, type);
    }

    if (path === "/applications" && method === "GET") return await listApplications(qs.tenantId);
    if (path === "/applications" && method === "PUT") return await putApplication(JSON.parse(event.body || "{}"));
    if (path.startsWith("/applications/") && method === "DELETE") {
      const appId = decodeURIComponent(path.split("/")[2]);
      return await deleteItem(qs.tenantId, `APP#${appId}`);
    }

    return respond(404, { error: `No route for ${method} ${path}` });
  } catch (error) {
    console.error(error);
    return respond(500, { error: error.message });
  }
};

async function listConnectors(tenantId) {
  if (!tenantId) return respond(400, { error: "tenantId is required" });
  const items = await queryTenant(tenantId, "CONNECTOR#");
  // item.config here is metadata only (owner/repo, channelId, secretRef) —
  // the secret VALUE lives in Secrets Manager and is never fetched here.
  const connectors = items.map((item) => ({
    type: item.sk.replace("CONNECTOR#", ""),
    config: item.config,
    updatedAt: item.updatedAt,
  }));
  return respond(200, { connectors });
}

async function putConnector(body) {
  const { tenantId, type, config } = body;
  if (!tenantId || !CONNECTOR_TYPES.has(type) || !config) {
    return respond(400, { error: "tenantId, a supported connector type, and config are required" });
  }

  // CloudWatch authenticates with the Lambda execution role and therefore has
  // no customer secret. External connectors keep their credentials in Secrets Manager.
  const secretName = type === "cloudwatch" ? null : secretNameFor(tenantId, type);
  const { secrets, metadata } = splitConfig(config);
  const existing = secretName ? await readSecret(secretName) : {};
  const mergedSecrets = { ...existing, ...secrets };

  if ((type === "github" || type === "slack") && !mergedSecrets.token) {
    return respond(400, { error: `${type} token is required` });
  }
  if (type === "datadog" && (!mergedSecrets.apiKey || !mergedSecrets.appKey)) {
    return respond(400, { error: "Datadog API and application keys are required" });
  }

  // Do not persist a connector merely because its form is structurally valid.
  // The provider must accept the effective (new + previously stored) credentials.
  try {
    await validateConnector(type, mergedSecrets, config);
  } catch (error) {
    return respond(422, { error: safeProviderError(error) });
  }

  // A blank token means "unchanged" — the console never gets a stored token
  // back to re-submit, so only write a new secret value when one is given.
  if (Object.keys(secrets).length) {
    await upsertSecret(secretName, mergedSecrets);
  }

  await db.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        tenantId,
        sk: `CONNECTOR#${type}`,
        config: {
          ...metadata,
          ...(secretName ? { secretRef: secretName } : {}),
          configured: true,
          authMode: type === "cloudwatch" ? "lambda-iam-role" : "secret",
        },
        updatedAt: new Date().toISOString(),
      },
    })
  );
  return respond(200, { ok: true });
}

async function testConnector(body) {
  const { tenantId, type, config = {} } = body;
  if (!tenantId || !CONNECTOR_TYPES.has(type)) {
    return respond(400, { error: "tenantId and a supported connector type are required" });
  }
  const { secrets } = splitConfig(config);
  const credentials = type === "cloudwatch"
    ? {}
    : { ...(await readSecret(secretNameFor(tenantId, type))), ...secrets };
  const started = Date.now();
  try {
    const details = await validateConnector(type, credentials, config);
    return respond(200, { ok: true, status: "healthy", latencyMs: Date.now() - started, testedAt: new Date().toISOString(), details });
  } catch (error) {
    return respond(422, { ok: false, status: "failed", latencyMs: Date.now() - started, testedAt: new Date().toISOString(), error: safeProviderError(error) });
  }
}

function validateConnector(type, credentials, config) {
  if (type === "cloudwatch") return testCloudWatch(config);
  if (type === "github") return testGithub(credentials.token, config);
  if (type === "slack") return testSlack(credentials.token, config);
  return testDatadog(credentials, config);
}

async function testCloudWatch(config) {
  const region = String(config.region || process.env.AWS_REGION || "us-east-1").trim();
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) throw new Error("Enter a valid AWS region, for example us-east-1");
  return {
    region,
    authMode: "lambda-iam-role",
    permissionsManagedBy: "presidio-sre-agent-role",
  };
}

async function testGithub(token, config) {
  if (!token) throw new Error("A GitHub token is required");
  const path = config.owner && config.repo ? `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}` : "/user";
  const data = await providerFetch(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "TraceX" } });
  return { account: data.login, repository: data.full_name, permissions: data.permissions };
}

async function testSlack(token, config) {
  if (!token) throw new Error("A Slack bot token is required");
  const headers = { Authorization: `Bearer ${token}` };
  const auth = await providerFetch("https://slack.com/api/auth.test", { method: "POST", headers });
  if (!auth.ok) throw new Error(`Slack: ${auth.error || "authentication failed"}`);
  if (config.channelId) {
    const channel = await providerFetch(`https://slack.com/api/conversations.info?channel=${encodeURIComponent(config.channelId)}`, { headers });
    if (!channel.ok) throw new Error(`Slack channel: ${channel.error || "not accessible"}`);
  }
  return { team: auth.team, botUser: auth.user, channelAccessible: Boolean(config.channelId) };
}

async function testDatadog(credentials, config) {
  if (!credentials.apiKey || !credentials.appKey) throw new Error("Datadog API and application keys are required");
  const hosts = { us1: "api.datadoghq.com", us3: "api.us3.datadoghq.com", us5: "api.us5.datadoghq.com", eu1: "api.datadoghq.eu", ap1: "api.ap1.datadoghq.com", ap2: "api.ap2.datadoghq.com", us1_fed: "api.ddog-gov.com" };
  const host = hosts[config.site || "us1"];
  if (!host) throw new Error("Unsupported Datadog site");
  const headers = { "DD-API-KEY": credentials.apiKey, "DD-APPLICATION-KEY": credentials.appKey };
  const validation = await providerFetch(`https://${host}/api/v1/validate`, { headers });
  if (!validation.valid) throw new Error("Datadog rejected the API key");
  await providerFetch(`https://${host}/api/v1/monitor?group_states=all&page_size=1`, { headers });
  return { site: config.site || "us1", permissions: ["api-access", "monitor-read"] };
}

async function providerFetch(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Provider returned ${response.status}: ${data.errors?.join(", ") || data.error || response.statusText}`);
  return data;
}

function splitConfig(config) {
  const secrets = {};
  const metadata = {};
  for (const [key, value] of Object.entries(config || {})) {
    if (SECRET_FIELDS.has(key)) {
      if (value) secrets[key] = value;
    } else metadata[key] = value;
  }
  return { secrets, metadata };
}

async function readSecret(name) {
  try {
    const response = await sm.send(new GetSecretValueCommand({ SecretId: name }));
    return JSON.parse(response.SecretString || "{}");
  } catch (error) {
    if (error.name === "ResourceNotFoundException") return {};
    throw error;
  }
}

function safeProviderError(error) {
  return String(error.message || "Connection failed").replace(/(token|key|secret)=[^\s&]+/gi, "$1=[REDACTED]");
}

async function deleteConnector(tenantId, type) {
  if (!tenantId) return respond(400, { error: "tenantId is required" });
  if (type !== "cloudwatch") {
    try {
      await sm.send(new DeleteSecretCommand({ SecretId: secretNameFor(tenantId, type), ForceDeleteWithoutRecovery: true }));
    } catch (error) {
      if (error.name !== "ResourceNotFoundException") throw error;
    }
  }
  return deleteItem(tenantId, `CONNECTOR#${type}`);
}

async function listApplications(tenantId) {
  if (!tenantId) return respond(400, { error: "tenantId is required" });
  const items = await queryTenant(tenantId, "APP#");
  const apps = items.map((item) => ({
    appId: item.sk.replace("APP#", ""),
    config: item.config,
    updatedAt: item.updatedAt,
  }));
  return respond(200, { applications: apps });
}

async function putApplication(body) {
  const { tenantId, appId, config } = body;
  if (!tenantId || !appId || !config) {
    return respond(400, { error: "tenantId, appId, and config are required" });
  }
  await db.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { tenantId, sk: `APP#${appId}`, config, updatedAt: new Date().toISOString() },
    })
  );
  return respond(200, { ok: true });
}

async function deleteItem(tenantId, sk) {
  if (!tenantId) return respond(400, { error: "tenantId is required" });
  await db.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { tenantId, sk } }));
  return respond(200, { ok: true });
}

async function queryTenant(tenantId, skPrefix) {
  const response = await db.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "tenantId = :t AND begins_with(sk, :p)",
      ExpressionAttributeValues: { ":t": tenantId, ":p": skPrefix },
    })
  );
  return response.Items || [];
}

function secretNameFor(tenantId, type) {
  return `presidio-connector/${tenantId}/${type}`;
}

// Secrets Manager has no single "upsert" call — PutSecretValue fails if the
// secret doesn't exist yet, so create it on first write.
async function upsertSecret(name, valueObj) {
  const SecretString = JSON.stringify(valueObj);
  try {
    await sm.send(new PutSecretValueCommand({ SecretId: name, SecretString }));
  } catch (error) {
    if (error.name === "ResourceNotFoundException") {
      await sm.send(new CreateSecretCommand({ Name: name, SecretString, KmsKeyId: KMS_KEY_ID }));
    } else {
      throw error;
    }
  }
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}
