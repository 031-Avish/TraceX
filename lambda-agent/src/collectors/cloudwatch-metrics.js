// src/collectors/cloudwatch-metrics.js
// Pulls CloudWatch metric data for the alerting service.
// Returns structured time-series data for the LLM to correlate with log events.

const {
  CloudWatchClient,
  GetMetricDataCommand,
  DescribeAlarmsCommand,
} = require("@aws-sdk/client-cloudwatch");

class CloudWatchMetricsCollector {
  constructor(region) {
    this.client = new CloudWatchClient({ region: region || process.env.AWS_REGION || "us-east-1" });
  }

  /**
   * Fetch metric data for the alerting namespace.
   * Returns time-series arrays the LLM can analyze for anomaly timing.
   */
  async getServiceMetrics({ namespace, metricName, dimensions = [], statistic = "Sum", windowMinutes = 30 }) {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - windowMinutes * 60 * 1000);

    try {
      const response = await this.client.send(
        new GetMetricDataCommand({
          StartTime: startTime,
          EndTime: endTime,
          MetricDataQueries: [
            {
              Id: "error_count",
              MetricStat: {
                Metric: {
                  Namespace: namespace,
                  MetricName: metricName,
                  Dimensions: dimensions,
                },
                Period: 60,
                Stat: statistic,
              },
              ReturnData: true,
            },
          ],
        })
      );

      const results = (response.MetricDataResults || []).map((m) => ({
        id: m.Id,
        label: m.Label || m.Id,
        datapoints: (m.Timestamps || []).map((ts, i) => ({
          timestamp: ts.toISOString(),
          value: m.Values?.[i] || 0,
        })).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)),
        statusCode: m.StatusCode,
      }));

      return { success: true, count: results.length, metrics: results };
    } catch (error) {
      return { success: false, count: 0, metrics: [], error: error.message };
    }
  }

  /**
   * Get alarm details — provides threshold and state change info.
   */
  async getAlarmDetails(alarmName) {
    try {
      const response = await this.client.send(
        new DescribeAlarmsCommand({
          AlarmNames: [alarmName],
        })
      );

      const alarm = response.MetricAlarms?.[0];
      if (!alarm) return { success: false, alarm: null, error: "Alarm not found" };

      return {
        success: true,
        alarm: {
          name: alarm.AlarmName,
          state: alarm.StateValue,
          stateReason: alarm.StateReason,
          stateUpdated: alarm.StateUpdatedTimestamp?.toISOString(),
          threshold: alarm.Threshold,
          comparisonOperator: alarm.ComparisonOperator,
          evaluationPeriods: alarm.EvaluationPeriods,
          metricName: alarm.MetricName,
          namespace: alarm.Namespace,
        },
      };
    } catch (error) {
      return { success: false, alarm: null, error: error.message };
    }
  }
}

module.exports = { CloudWatchMetricsCollector };
