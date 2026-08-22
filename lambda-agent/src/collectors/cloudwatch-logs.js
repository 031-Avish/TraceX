// src/collectors/cloudwatch-logs.js
// Pulls filtered CloudWatch Logs from the client's log group.
// Only fetches ERROR/FATAL/4xx/5xx/high-latency entries — never raw application logs.

const {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} = require("@aws-sdk/client-cloudwatch-logs");

class CloudWatchLogsCollector {
  constructor(region) {
    this.client = new CloudWatchLogsClient({ region: region || process.env.AWS_REGION || "us-east-1" });
  }

  /**
   * Fetch recent actionable log events from a CloudWatch Log Group.
   * Includes errors, rejected requests, and abnormal latency without pulling
   * the entire raw application log stream.
   *
   * FilterLogEvents has no "give me the newest N" mode — it just returns up
   * to `limit` matches from the window with no guaranteed recency ordering,
   * so when a window contains more matches than the limit, the events that
   * actually explain why the alarm just fired can be silently dropped in
   * favor of older, already-resolved noise earlier in the same window
   * (confirmed live: a stale error from 10 minutes earlier crowded out the
   * real error from 90 seconds before the alarm fired, producing a wrong
   * root cause). Paginate through everything in the window (bounded by
   * MAX_PAGES so a genuinely noisy window can't blow up latency/cost), then
   * sort by timestamp descending and keep only the most recent RETURN_LIMIT
   * — recency is what matters for incident correlation, not completeness.
   */
  async getRecentErrorLogs(logGroupName, windowMinutes = 15) {
    const endTime = Date.now();
    const startTime = endTime - windowMinutes * 60 * 1000;
    const RETURN_LIMIT = 50;
    const MAX_PAGES = 5;

    try {
      let allEvents = [];
      let nextToken;
      for (let page = 0; page < MAX_PAGES; page++) {
        const response = await this.client.send(
          new FilterLogEventsCommand({
            logGroupName,
            startTime,
            endTime,
            // Filter to only error-level logs — keeps token count low
            filterPattern: '{ $.level = "ERROR" || $.level = "FATAL" || $.statusCode >= 400 || $.responseTimeMs >= 350 }',
            limit: 100,
            nextToken,
          })
        );
        allEvents = allEvents.concat(response.events || []);
        nextToken = response.nextToken;
        if (!nextToken) break;
      }

      const events = allEvents
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, RETURN_LIMIT)
        .map((e) => ({
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
