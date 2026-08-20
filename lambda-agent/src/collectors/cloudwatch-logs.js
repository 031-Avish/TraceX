// src/collectors/cloudwatch-logs.js
// Pulls filtered CloudWatch Logs from the client's log group.
// Only fetches ERROR/FATAL/5xx entries — never raw application logs.

const {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} = require("@aws-sdk/client-cloudwatch-logs");

class CloudWatchLogsCollector {
  constructor(region) {
    this.client = new CloudWatchLogsClient({ region: region || process.env.AWS_REGION || "us-east-1" });
  }

  /**
   * Fetch recent error/fatal log events from a CloudWatch Log Group.
   * Uses a filter pattern to only pull 5xx and error-level entries.
   */
  async getRecentErrorLogs(logGroupName, windowMinutes = 15) {
    const endTime = Date.now();
    const startTime = endTime - windowMinutes * 60 * 1000;

    try {
      const response = await this.client.send(
        new FilterLogEventsCommand({
          logGroupName,
          startTime,
          endTime,
          // Filter to only error-level logs — keeps token count low
          filterPattern: '{ $.level = "ERROR" || $.level = "FATAL" || $.statusCode = 500 }',
          limit: 50,
        })
      );

      const events = (response.events || []).map((e) => ({
        timestamp: new Date(e.timestamp).toISOString(),
        message: this._tryParseJson(e.message),
        logStream: e.logStreamName,
      }));

      return { success: true, count: events.length, events };
    } catch (error) {
      if (error.name === "ResourceNotFoundException") {
        return { success: false, count: 0, events: [], error: `Log group not found: ${logGroupName}` };
      }
      return { success: false, count: 0, events: [], error: error.message };
    }
  }

  /**
   * Fetch deployment/release events from logs.
   */
  async getDeploymentLogs(logGroupName, windowMinutes = 30) {
    const endTime = Date.now();
    const startTime = endTime - windowMinutes * 60 * 1000;

    try {
      const response = await this.client.send(
        new FilterLogEventsCommand({
          logGroupName,
          startTime,
          endTime,
          filterPattern: '{ $.event = "DEPLOYMENT_STARTED" || $.service = "ecs-deploy" }',
          limit: 10,
        })
      );

      const events = (response.events || []).map((e) => ({
        timestamp: new Date(e.timestamp).toISOString(),
        message: this._tryParseJson(e.message),
      }));

      return { success: true, count: events.length, events };
    } catch (error) {
      return { success: false, count: 0, events: [], error: error.message };
    }
  }

  /**
   * Fetch ALL recent logs (not just errors) for broader context.
   * Limited to 30 events to keep token budget under control.
   */
  async getAllRecentLogs(logGroupName, windowMinutes = 15) {
    const endTime = Date.now();
    const startTime = endTime - windowMinutes * 60 * 1000;

    try {
      const response = await this.client.send(
        new FilterLogEventsCommand({
          logGroupName,
          startTime,
          endTime,
          limit: 30,
        })
      );

      const events = (response.events || []).map((e) => ({
        timestamp: new Date(e.timestamp).toISOString(),
        message: this._tryParseJson(e.message),
      }));

      return { success: true, count: events.length, events };
    } catch (error) {
      return { success: false, count: 0, events: [], error: error.message };
    }
  }

  _tryParseJson(msg) {
    try {
      return JSON.parse(msg);
    } catch {
      return msg;
    }
  }
}

module.exports = { CloudWatchLogsCollector };
