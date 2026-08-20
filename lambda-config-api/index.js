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
  DeleteSecretCommand,
} = require("@aws-sdk/client-secrets-manager");

const raw = new DynamoDBClient({});
const db = DynamoDBDocumentClient.from(raw);
const sm = new SecretsManagerClient({});
const TABLE_NAME = process.env.CONNECTOR_TABLE_NAME;
const KMS_KEY_ID = process.env.CONNECTOR_KMS_KEY_ID;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const CONNECTOR_TYPES = new Set(["github", "slack"]);

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
    return respond(400, { error: "tenantId, type (github|slack), and config are required" });
  }

  const secretName = secretNameFor(tenantId, type);
  const { token, ...metadata } = config;

  // A blank token means "unchanged" — the console never gets a stored token
  // back to re-submit, so only write a new secret value when one is given.
  if (token) {
    await upsertSecret(secretName, { token });
  }

  await db.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        tenantId,
        sk: `CONNECTOR#${type}`,
        config: { ...metadata, secretRef: secretName, configured: true },
        updatedAt: new Date().toISOString(),
      },
    })
  );
  return respond(200, { ok: true });
}

async function deleteConnector(tenantId, type) {
  if (!tenantId) return respond(400, { error: "tenantId is required" });
  try {
    await sm.send(new DeleteSecretCommand({ SecretId: secretNameFor(tenantId, type), ForceDeleteWithoutRecovery: true }));
  } catch (error) {
    if (error.name !== "ResourceNotFoundException") throw error;
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
