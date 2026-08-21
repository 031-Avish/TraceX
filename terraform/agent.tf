# ═══════════════════════════════════════════════════════════════
#  TRIAGE AGENT — The AI SRE that analyzes incidents
# ═══════════════════════════════════════════════════════════════

locals {
  effective_openrouter_api_key = var.openrouter_api_key != "" ? var.openrouter_api_key : var.openrouter_api_key
}

# ── SNS Topic (alarm → agent trigger) ────────────────────────
resource "aws_sns_topic" "incident_alarms" {
  name         = "presidio-incident-alarms"
  display_name = "Presidio Incident Alarms"
}

resource "aws_sns_topic_subscription" "agent_sub" {
  topic_arn = aws_sns_topic.incident_alarms.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.triage_agent.arn
}

resource "aws_lambda_permission" "sns_invoke" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.triage_agent.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.incident_alarms.arn
}

# ── IAM Role for Triage Agent ────────────────────────────────
resource "aws_iam_role" "agent_role" {
  name = "presidio-sre-agent-role"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy" "agent_policy" {
  name = "presidio-sre-agent-policy"
  role = aws_iam_role.agent_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadAppLogs"
        Effect   = "Allow"
        Action   = ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"]
        Resource = "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:${local.log_group_name}:*"
      },
      {
        Sid      = "WriteOwnLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/presidio-sre-agent-triage:*"
      },
      {
        Sid      = "ReadMetrics"
        Effect   = "Allow"
        Action   = ["cloudwatch:GetMetricData", "cloudwatch:GetMetricStatistics", "cloudwatch:DescribeAlarms"]
        Resource = "*"
      }
    ]
  })
}

# ── Agent Lambda Log Group ───────────────────────────────────
resource "aws_cloudwatch_log_group" "agent_logs" {
  name              = "/aws/lambda/presidio-sre-agent-triage"
  retention_in_days = 3
}

# ── Agent Lambda Function ────────────────────────────────────
resource "null_resource" "agent_deps" {
  triggers = { pkg = filemd5("${path.module}/../lambda-agent/package.json") }
  provisioner "local-exec" {
    command     = "npm install --production"
    working_dir = "${path.module}/../lambda-agent"
  }
}

data "archive_file" "agent_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda-agent"
  output_path = "${path.module}/../.build/agent.zip"
  excludes    = [".env"]
  depends_on  = [null_resource.agent_deps]
}

resource "aws_lambda_function" "triage_agent" {
  function_name    = "presidio-sre-agent-triage"
  description      = "Presidio SRE Agent — Autonomous incident triage via LLM"
  role             = aws_iam_role.agent_role.arn
  handler          = "src/handler.main"
  runtime          = "nodejs18.x"
  timeout          = 90
  memory_size      = 512
  filename         = data.archive_file.agent_zip.output_path
  source_code_hash = data.archive_file.agent_zip.output_base64sha256

  vpc_config {
    subnet_ids         = local.tracex_lambda_subnet_ids
    security_group_ids = local.tracex_lambda_security_group_ids
  }

  environment {
    variables = {
      OPENROUTER_API_KEY   = local.effective_openrouter_api_key
      OPENROUTER_MODEL     = var.openrouter_model
      SLACK_BOT_TOKEN      = var.slack_bot_token
      SLACK_CHANNEL_ID     = var.slack_channel_id
      GITHUB_TOKEN         = var.github_token
      GITHUB_REPO_OWNER    = var.github_repo_owner
      GITHUB_REPO_NAME     = var.github_repo_name
      LOG_GROUP_NAME       = local.log_group_name
      METRIC_NAMESPACE     = local.metric_namespace
      CONNECTOR_TABLE_NAME = aws_dynamodb_table.connector_registry.name
      TENANT_ID            = "demo"
    }
  }

  lifecycle {
    precondition {
      condition     = local.effective_openrouter_api_key != ""
      error_message = "Set openrouter_api_key in terraform.tfvars (openrouter_api_key is accepted only as a deprecated compatibility alias)."
    }
  }

  depends_on = [
    aws_iam_role_policy.agent_policy,
    aws_cloudwatch_log_group.agent_logs,
    aws_iam_role_policy_attachment.agent_vpc_access,
  ]
}
