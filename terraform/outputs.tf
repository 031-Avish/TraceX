# ═══════════════════════════════════════════════════════════════
#  OUTPUTS — Everything you need for the demo
# ═══════════════════════════════════════════════════════════════

output "payment_api_url" {
  description = "Payment API endpoint (the 'production' service)"
  value       = "${aws_apigatewayv2_api.payment_api.api_endpoint}/api/payments"
}

output "config_api_url" {
  description = "Connector config API — the hosted console is built pointing at this automatically"
  value       = aws_apigatewayv2_api.config_api.api_endpoint
}

output "console_url" {
  description = "🧭 The hosted connector console — open this in a browser"
  value       = "https://${aws_cloudfront_distribution.console.domain_name}"
}

output "chaos_switch_command" {
  description = "🚨 Run this to BREAK the service and trigger the incident"
  value       = "aws ssm put-parameter --name ${local.chaos_param} --value true --type String --overwrite --region ${var.aws_region}"
}

output "heal_command" {
  description = "✅ Run this to HEAL the service (reset for next demo)"
  value       = "aws ssm put-parameter --name ${local.chaos_param} --value false --type String --overwrite --region ${var.aws_region}"
}

output "agent_logs_command" {
  description = "Watch triage agent logs"
  value       = "aws logs tail /aws/lambda/presidio-sre-agent-triage --follow --region ${var.aws_region}"
}

output "app_logs_command" {
  description = "Watch payment service logs"
  value       = "aws logs tail ${local.log_group_name} --follow --region ${var.aws_region}"
}

output "alarm_name" {
  value = local.alarm_name
}

output "sns_topic_arn" {
  value = aws_sns_topic.incident_alarms.arn
}

output "authority_vpc_id" {
  description = "Existing authority-provided VPC used by TraceX (lookup only)"
  value       = data.aws_vpc.authority_provided.id
}

output "authority_private_subnet_ids" {
  description = "Existing private subnet IDs used by TraceX Lambdas (lookup only)"
  value       = local.tracex_lambda_subnet_ids
}

output "demo_flow" {
  description = "What happens during the demo"
  value       = <<-EOT

    ╔═══════════════════════════════════════════════════════════╗
    ║  DEMO FLOW — What to do on camera                        ║
    ╠═══════════════════════════════════════════════════════════╣
    ║                                                           ║
    ║  1. Show Slack channel — healthy, no alerts               ║
    ║  2. Show payment API returning 200s (optional)            ║
    ║  3. Run: ./break-it.sh                                    ║
    ║  4. Wait 60-90 sec — errors accumulate, alarm fires       ║
    ║  5. Agent triggers automatically via SNS                  ║
    ║  6. Triage Brief appears in Slack (~30 sec after alarm)   ║
    ║  7. Walk through the brief on camera                      ║
    ║  8. Run: ./heal-it.sh  (reset for next demo)              ║
    ║                                                           ║
    ╚═══════════════════════════════════════════════════════════╝
  EOT
}
