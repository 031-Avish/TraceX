// src/collectors/aws-resource.js
// Inspects a downstream AWS resource's own configuration and health
// directly — not the alerting app's logs, not its own alarm. This is the
// gap that made the fraud-check-service incident feel "too easy": the
// agent could only ever see what the alerting app's own structured logs
// happened to say about a dependency, never go look at that dependency's
// actual AWS-side state itself. Starts with DynamoDB since that's the
// first dependency type wired into a demo scenario; add another
// describe*/get*Health method + tool entry for a new resource type later.

const { DynamoDBClient, DescribeTableCommand } = require("@aws-sdk/client-dynamodb");
const { CloudWatchMetricsCollector } = require("./cloudwatch-metrics");

class AwsResourceCollector {
  constructor(region) {
    this.region = region || process.env.AWS_REGION || "us-east-1";
    this.ddb = new DynamoDBClient({ region: this.region });
    this.metrics = new CloudWatchMetricsCollector(this.region);
  }

  async getDynamoDbTableHealth(tableName, windowMinutes = 15) {
    if (!tableName) return { success: false, error: "tableName is required" };

    let table = null;
    try {
      const resp = await this.ddb.send(new DescribeTableCommand({ TableName: tableName }));
      const t = resp.Table;
      table = {
        tableName: t.TableName,
        status: t.TableStatus,
        billingMode: t.BillingModeSummary?.BillingMode || "PROVISIONED",
        provisionedThroughput: t.BillingModeSummary?.BillingMode === "PAY_PER_REQUEST"
          ? null
          : { readCapacityUnits: t.ProvisionedThroughput?.ReadCapacityUnits, writeCapacityUnits: t.ProvisionedThroughput?.WriteCapacityUnits },
        itemCount: t.ItemCount,
        sizeBytes: t.TableSizeBytes,
      };
    } catch (error) {
      return { success: false, error: `DescribeTable failed: ${error.message}` };
    }

    const [consumedWrite, throttled] = await Promise.all([
      this.metrics.getServiceMetrics({
        namespace: "AWS/DynamoDB",
        metricName: "ConsumedWriteCapacityUnits",
        dimensions: [{ Name: "TableName", Value: tableName }],
        statistic: "Sum",
        windowMinutes,
      }),
      this.metrics.getServiceMetrics({
        namespace: "AWS/DynamoDB",
        metricName: "WriteThrottleEvents",
        dimensions: [{ Name: "TableName", Value: tableName }],
        statistic: "Sum",
        windowMinutes,
      }),
    ]);

    return {
      success: true,
      table,
      consumedWriteCapacity: consumedWrite.metrics?.[0]?.datapoints || [],
      writeThrottleEvents: throttled.metrics?.[0]?.datapoints || [],
    };
  }
}

module.exports = { AwsResourceCollector };
