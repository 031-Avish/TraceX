# ═══════════════════════════════════════════════════════════════
#  DEMO APP — "Production" Payment Service
#  This simulates the client's real infrastructure:
#    - Payment API behind API Gateway
#    - Traffic generator hitting it every minute
#    - SSM "chaos switch" to trigger the incident
# ═══════════════════════════════════════════════════════════════

locals {
  log_group_name     = "/ecs/acme-payment-service"
  metric_namespace   = "AcmeApp"
  alarm_name         = "acme-payment-5xx-critical"
  alarm_4xx_name     = "acme-payment-4xx-warning"
  alarm_latency_name = "acme-payment-high-latency"
  alarm_fatal_name   = "acme-payment-fatal-error"
  chaos_param        = "/presidio-demo/chaos-mode"
}

# ── SSM Parameter: The Chaos Switch ──────────────────────────
# Set to "true" to break the payment service → triggers the incident
resource "aws_ssm_parameter" "chaos_mode" {
  name  = local.chaos_param
  type  = "String"
  value = "false"

  lifecycle { ignore_changes = [value] } # don't reset on re-apply
}

# ── CloudWatch Log Group (shared by demo app) ────────────────
resource "aws_cloudwatch_log_group" "app_logs" {
  name              = local.log_group_name
  retention_in_days = 1
}

# ── IAM Role for Demo App Lambda ─────────────────────────────
resource "aws_iam_role" "demo_app_role" {
  name = "presidio-demo-app-role"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy" "demo_app_policy" {
  name = "presidio-demo-app-policy"
  role = aws_iam_role.demo_app_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.chaos_param}"
      }
    ]
  })
}

# ── Demo App Lambda (Payment Service) ────────────────────────
resource "null_resource" "demo_app_deps" {
  triggers = { pkg = filemd5("${path.module}/../lambda-demo-app/package.json") }
  provisioner "local-exec" {
    command     = "npm install --production"
    working_dir = "${path.module}/../lambda-demo-app"
  }
}

data "archive_file" "demo_app_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda-demo-app"
  output_path = "${path.module}/../.build/demo-app.zip"
  excludes    = [".env"]
  depends_on  = [null_resource.demo_app_deps]
}

resource "aws_lambda_function" "payment_service" {
  function_name    = "acme-payment-service"
  description      = "Fake payment API — chaos-switchable for demo"
  role             = aws_iam_role.demo_app_role.arn
  handler          = "index.handler"
  runtime          = "nodejs18.x"
  timeout          = 15
  memory_size      = 256
  filename         = data.archive_file.demo_app_zip.output_path
  source_code_hash = data.archive_file.demo_app_zip.output_base64sha256

  vpc_config {
    subnet_ids         = local.tracex_lambda_subnet_ids
    security_group_ids = local.tracex_lambda_security_group_ids
  }

  environment {
    variables = {
      CHAOS_PARAM_NAME       = local.chaos_param
      BREAKING_COMMIT_SHA    = var.breaking_commit_sha
      BREAKING_COMMIT_MSG    = var.breaking_commit_msg
      BREAKING_COMMIT_AUTHOR = var.breaking_commit_author
    }
  }

  logging_config {
    log_group  = aws_cloudwatch_log_group.app_logs.name
    log_format = "Text"
  }

  depends_on = [aws_cloudwatch_log_group.app_logs, aws_iam_role_policy_attachment.demo_app_vpc_access]
}

# ── API Gateway (makes it a real HTTP endpoint) ──────────────
resource "aws_apigatewayv2_api" "payment_api" {
  name          = "acme-payment-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "payment_integration" {
  api_id                 = aws_apigatewayv2_api.payment_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.payment_service.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "payment_route" {
  api_id    = aws_apigatewayv2_api.payment_api.id
  route_key = "POST /api/payments"
  target    = "integrations/${aws_apigatewayv2_integration.payment_integration.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.payment_api.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "apigw" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.payment_service.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.payment_api.execution_arn}/*/*"
}

# ── Traffic Generator Lambda ─────────────────────────────────
resource "aws_iam_role" "traffic_gen_role" {
  name = "presidio-traffic-gen-role"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy" "traffic_gen_policy" {
  name = "presidio-traffic-gen-policy"
  role = aws_iam_role.traffic_gen_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "arn:aws:logs:*:*:*"
    }]
  })
}

data "archive_file" "traffic_gen_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda-traffic-gen"
  output_path = "${path.module}/../.build/traffic-gen.zip"
}

resource "aws_lambda_function" "traffic_gen" {
  function_name    = "presidio-traffic-generator"
  description      = "Sends simulated traffic to payment API every minute"
  role             = aws_iam_role.traffic_gen_role.arn
  handler          = "index.handler"
  runtime          = "nodejs18.x"
  timeout          = 30
  memory_size      = 128
  filename         = data.archive_file.traffic_gen_zip.output_path
  source_code_hash = data.archive_file.traffic_gen_zip.output_base64sha256

  vpc_config {
    subnet_ids         = local.tracex_lambda_subnet_ids
    security_group_ids = local.tracex_lambda_security_group_ids
  }

  environment {
    variables = {
      PAYMENT_API_URL = "${aws_apigatewayv2_api.payment_api.api_endpoint}/api/payments"
    }
  }

  depends_on = [aws_iam_role_policy_attachment.traffic_gen_vpc_access]
}

# Schedule: every 1 minute
resource "aws_cloudwatch_event_rule" "traffic_schedule" {
  name                = "presidio-traffic-every-minute"
  description         = "Sends traffic to payment API every minute"
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "traffic_target" {
  rule = aws_cloudwatch_event_rule.traffic_schedule.name
  arn  = aws_lambda_function.traffic_gen.arn
}

resource "aws_lambda_permission" "traffic_schedule" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.traffic_gen.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.traffic_schedule.arn
}

# ── CloudWatch Metric Filter + Alarm ─────────────────────────
resource "aws_cloudwatch_log_metric_filter" "error_5xx" {
  name           = "payment-5xx-filter"
  log_group_name = aws_cloudwatch_log_group.app_logs.name
  pattern        = "{ $.statusCode = 500 }"

  metric_transformation {
    name          = "Payment5xxCount"
    namespace     = local.metric_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "error_4xx" {
  name           = "payment-4xx-filter"
  log_group_name = aws_cloudwatch_log_group.app_logs.name
  pattern        = "{ $.statusCode >= 400 && $.statusCode < 500 }"

  metric_transformation {
    name          = "Payment4xxCount"
    namespace     = local.metric_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "request_latency" {
  name           = "payment-latency-filter"
  log_group_name = aws_cloudwatch_log_group.app_logs.name
  pattern        = "{ $.responseTimeMs = * }"

  metric_transformation {
    name      = "PaymentLatency"
    namespace = local.metric_namespace
    value     = "$.responseTimeMs"
    unit      = "Milliseconds"
  }
}

resource "aws_cloudwatch_log_metric_filter" "fatal_errors" {
  name           = "payment-fatal-filter"
  log_group_name = aws_cloudwatch_log_group.app_logs.name
  pattern        = "{ $.level = \"FATAL\" }"

  metric_transformation {
    name          = "PaymentFatalCount"
    namespace     = local.metric_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "payment_5xx" {
  alarm_name          = local.alarm_name
  alarm_description   = "P1: Acme Corp payment-service 5xx error rate exceeded threshold"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Payment5xxCount"
  namespace           = local.metric_namespace
  period              = 60
  statistic           = "Sum"
  threshold           = 3
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.incident_alarms.arn]
  ok_actions    = [aws_sns_topic.incident_alarms.arn]

  tags = { Client = "acme-corp", Service = "acme-payment-service", Environment = "production", Severity = "P1" }
}

resource "aws_cloudwatch_metric_alarm" "payment_4xx" {
  alarm_name          = local.alarm_4xx_name
  alarm_description   = "P2: Acme Corp payment-service 4xx responses exceeded threshold"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Payment4xxCount"
  namespace           = local.metric_namespace
  period              = 60
  statistic           = "Sum"
  threshold           = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.incident_alarms.arn]
  ok_actions          = [aws_sns_topic.incident_alarms.arn]

  tags = { Client = "acme-corp", Service = "acme-payment-service", Environment = "production", Severity = "P2" }
}

resource "aws_cloudwatch_metric_alarm" "payment_high_latency" {
  alarm_name          = local.alarm_latency_name
  alarm_description   = "P2: Acme Corp payment-service average latency exceeded 350 ms"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "PaymentLatency"
  namespace           = local.metric_namespace
  period              = 60
  statistic           = "Average"
  threshold           = 350
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.incident_alarms.arn]
  ok_actions          = [aws_sns_topic.incident_alarms.arn]

  tags = { Client = "acme-corp", Service = "acme-payment-service", Environment = "production", Severity = "P2" }
}

resource "aws_cloudwatch_metric_alarm" "payment_fatal" {
  alarm_name          = local.alarm_fatal_name
  alarm_description   = "P1: Acme Corp payment-service emitted a fatal error"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "PaymentFatalCount"
  namespace           = local.metric_namespace
  period              = 60
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.incident_alarms.arn]
  ok_actions          = [aws_sns_topic.incident_alarms.arn]

  tags = { Client = "acme-corp", Service = "acme-payment-service", Environment = "production", Severity = "P1" }
}
