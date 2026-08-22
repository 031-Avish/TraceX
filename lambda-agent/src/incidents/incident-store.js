const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const TABLE_NAME = process.env.CONNECTOR_TABLE_NAME;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({
  region: process.env.AWS_REGION || "us-east-1",
}));

function incidentKey(alarmData) {
  const startedAt = alarmData.stateChangeTime || alarmData.timestamp || new Date().toISOString();
  return `INCIDENT#${alarmData.alarmName}#${startedAt}`;
}

async function getIncident(tenantId, sk) {
  if (!TABLE_NAME) return null;
  const result = await db.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { tenantId, sk },
  }));
  return result.Item || null;
}

async function createIncident(tenantId, alarmData) {
  if (!TABLE_NAME) return { created: true, sk: incidentKey(alarmData), item: null };
  const sk = incidentKey(alarmData);
  const item = {
    tenantId,
    sk,
    alarmName: alarmData.alarmName,
    service: alarmData.service,
    state: "alerting",
    startedAt: alarmData.stateChangeTime || alarmData.timestamp || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    await db.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item,
      ConditionExpression: "attribute_not_exists(tenantId) AND attribute_not_exists(sk)",
    }));
    return { created: true, sk, item };
  } catch (error) {
    if (error.name !== "ConditionalCheckFailedException") throw error;
    return { created: false, sk, item: await getIncident(tenantId, sk) };
  }
}

async function updateIncident(tenantId, sk, updates) {
  if (!TABLE_NAME) return;
  const names = {};
  const values = {};
  const assignments = [];
  // Skip undefined values — DynamoDB's marshaller drops them from
  // ExpressionAttributeValues, but the SET clause would still reference the
  // now-missing placeholder and the whole update would fail validation.
  Object.entries({ ...updates, updatedAt: new Date().toISOString() })
    .filter(([, value]) => value !== undefined)
    .forEach(([key, value], index) => {
      names[`#k${index}`] = key;
      values[`:v${index}`] = value;
      assignments.push(`#k${index} = :v${index}`);
    });
  await db.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { tenantId, sk },
    UpdateExpression: `SET ${assignments.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

async function findLatestIncident(tenantId, alarmName) {
  if (!TABLE_NAME) return null;
  const result = await db.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "tenantId = :tenantId AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: {
      ":tenantId": tenantId,
      ":prefix": `INCIDENT#${alarmName}#`,
    },
    ScanIndexForward: false,
    Limit: 1,
  }));
  return result.Items?.[0] || null;
}

module.exports = {
  createIncident,
  findLatestIncident,
  updateIncident,
};
