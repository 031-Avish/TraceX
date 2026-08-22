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
const { LambdaClient, GetFunctionCommand } = require("@aws-sdk/client-lambda");
const { SQSClient, GetQueueAttributesCommand, GetQueueUrlCommand } = require("@aws-sdk/client-sqs");
const { CloudWatchMetricsCollector } = require("./cloudwatch-metrics");

class AwsResourceCollector {
  constructor(region) {
    this.region = region || process.env.AWS_REGION || "us-east-1";
    this.ddb = new DynamoDBClient({ region: this.region });
    this.lambda = new LambdaClient({ region: this.region });
    this.sqs = new SQSClient({ region: this.region });
    this.metrics = new CloudWatchMetricsCollector(this.region);
  }

  /**
   * Single entry point the agent actually calls: given any AWS resource
   * ARN, figures out which service it belongs to (the 3rd ARN segment —
   * arn:aws:<service>:...) and dispatches to that service's own health
   * check. Add a case here + one method below for each new resource type
   * this demo needs to support — the tool schema itself never changes.
   */
  async getResourceHealth(resourceArn, windowMinutes = 15) {
    if (!resourceArn || typeof resourceArn !== "string") {
      return { success: false, error: "resourceArn is required, e.g. arn:aws:dynamodb:us-east-1:123456789012:table/my-table" };
    }
    const parts = resourceArn.split(":");
    const service = parts[2];
    const resource = parts.slice(5).join(":"); // everything after arn:aws:svc:region:account:

    switch (service) {
      case "dynamodb": {
        const tableName = resource.startsWith("table/") ? resource.slice("table/".length) : resource;
        return this.getDynamoDbTableHealth(tableName, windowMinutes);
      }
      case "lambda": {
        const functionName = resource.startsWith("function:") ? resource.slice("function:".length) : resource;
        return this.getLambdaFunctionHealth(functionName, windowMinutes);
      }
      case "sqs": {
        const queueName = resource; // sqs ARN resource part IS the queue name
        return this.getSqsQueueHealth(queueName, windowMinutes);
      }
      default:
        return { success: false, error: `Unsupported resource type "${service}" for ARN ${resourceArn} — this tool currently supports dynamodb, lambda, and sqs resources.` };
    }
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

  async getLambdaFunctionHealth(functionName, windowMinutes = 15) {
    if (!functionName) return { success: false, error: "functionName is required" };

    let fn = null;
    try {
      const resp = await this.lambda.send(new GetFunctionCommand({ FunctionName: functionName }));
      fn = {
        functionName: resp.Configuration.FunctionName,
        state: resp.Configuration.State,
        lastUpdateStatus: resp.Configuration.LastUpdateStatus,
        reservedConcurrentExecutions: resp.Concurrency?.ReservedConcurrentExecutions ?? null,
        memorySize: resp.Configuration.MemorySize,
        timeout: resp.Configuration.Timeout,
        lastModified: resp.Configuration.LastModified,
      };
    } catch (error) {
      return { success: false, error: `GetFunction failed: ${error.message}` };
    }

    const [throttles, invocations, errors] = await Promise.all([
      this.metrics.getServiceMetrics({
        namespace: "AWS/Lambda",
        metricName: "Throttles",
        dimensions: [{ Name: "FunctionName", Value: functionName }],
        statistic: "Sum",
        windowMinutes,
      }),
      this.metrics.getServiceMetrics({
        namespace: "AWS/Lambda",
        metricName: "Invocations",
        dimensions: [{ Name: "FunctionName", Value: functionName }],
        statistic: "Sum",
        windowMinutes,
      }),
      this.metrics.getServiceMetrics({
        namespace: "AWS/Lambda",
        metricName: "Errors",
        dimensions: [{ Name: "FunctionName", Value: functionName }],
        statistic: "Sum",
        windowMinutes,
      }),
    ]);

    return {
      success: true,
      function: fn,
      throttles: throttles.metrics?.[0]?.datapoints || [],
      invocations: invocations.metrics?.[0]?.datapoints || [],
      errors: errors.metrics?.[0]?.datapoints || [],
    };
  }

  async getSqsQueueHealth(queueName, windowMinutes = 15) {
    if (!queueName) return { success: false, error: "queueName is required" };

    let queueUrl = null;
    let attributes = null;
    try {
      const urlResp = await this.sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
      queueUrl = urlResp.QueueUrl;
      const attrResp = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateAgeOfOldestMessage"],
        })
      );
      attributes = {
        approximateNumberOfMessages: Number(attrResp.Attributes?.ApproximateNumberOfMessages || 0),
        approximateNumberOfMessagesInFlight: Number(attrResp.Attributes?.ApproximateNumberOfMessagesNotVisible || 0),
        approximateAgeOfOldestMessageSeconds: Number(attrResp.Attributes?.ApproximateAgeOfOldestMessage || 0),
      };
    } catch (error) {
      return { success: false, error: `GetQueueAttributes failed: ${error.message}` };
    }

    const sentVsDeleted = await this.metrics.getServiceMetrics({
      namespace: "AWS/SQS",
      metricName: "NumberOfMessagesSent",
      dimensions: [{ Name: "QueueName", Value: queueName }],
      statistic: "Sum",
      windowMinutes,
    });

    return {
      success: true,
      queueUrl,
      currentState: attributes,
      messagesSent: sentVsDeleted.metrics?.[0]?.datapoints || [],
    };
  }
}

module.exports = { AwsResourceCollector };
