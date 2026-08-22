# ═══════════════════════════════════════════════════════════════
#  CONNECTOR REGISTRY — self-service config the customer fills in
#
#  A DynamoDB table + a small API Lambda so a customer can configure their
#  own GitHub/Slack credentials and map applications to a CloudWatch scope
#  through the console UI (console/index.html), instead of anyone editing
#  Terraform vars or Lambda env vars. The triage agent reads this table at
#  investigation time (see lambda-agent/src/config/connector-registry.js).
#
#  Secret handling: DynamoDB holds ONLY non-sensitive scope metadata (repo
#  owner/name, Slack channel ID) plus a pointer to a Secrets Manager secret.
#  The actual token/bot-token value never lives in DynamoDB — it's written
#  to a dedicated Secrets Manager secret, encrypted with a customer-managed
#  KMS key (not the AWS-owned default), and read back only at investigation
#  time by the agent. This gives per-resource IAM scoping and a distinct
#  CloudTrail audit trail on every decrypt, instead of "whoever can read the
#  table can read the token."
# ═══════════════════════════════════════════════════════════════

# ── KMS key dedicated to connector secrets (not the AWS-owned default) ──
resource "aws_kms_key" "connector_secrets" {
  description             = "Encrypts customer-configured connector credentials (GitHub/Slack tokens etc.)"
  deletion_window_in_days = 7
  enable_key_rotation     = true
}

resource "aws_kms_alias" "connector_secrets" {
  name          = "alias/presidio-connector-secrets"
  target_key_id = aws_kms_key.connector_secrets.key_id
}

resource "aws_dynamodb_table" "connector_registry" {
  name         = "presidio-connector-registry"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "tenantId"
  range_key    = "sk"

  attribute {
    name = "tenantId"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  # Defense-in-depth for the non-sensitive metadata that does live here
  # (repo owner/name, channel ID). The actual secret value never touches
  # this table — see the KMS key + Secrets Manager wiring above.
  server_side_encryption {
    enabled = true
  }
}

# ── Let the triage agent read connector configs + decrypt secrets ────
resource "aws_iam_role_policy" "agent_connector_read" {
  name = "presidio-sre-agent-connector-read"
  role = aws_iam_role.agent_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadConnectorMetadata"
        Effect   = "Allow"
        Action   = ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.connector_registry.arn
      },
      {
        Sid      = "ReadConnectorSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:presidio-connector/*"
      },
      {
        Sid      = "DecryptConnectorSecrets"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.connector_secrets.arn
      }
    ]
  })
}

# ── Config API Lambda (full CRUD, behind API Gateway) ────────────
resource "aws_iam_role" "config_api_role" {
  name = "presidio-config-api-role"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy" "config_api_policy" {
  name = "presidio-config-api-policy"
  role = aws_iam_role.config_api_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteOwnLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Sid      = "ReadWriteConnectorMetadata"
        Effect   = "Allow"
        Action   = ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
        Resource = aws_dynamodb_table.connector_registry.arn
      },
      {
        Sid    = "ManageConnectorSecrets"
        Effect = "Allow"
        Action = [
          "secretsmanager:CreateSecret",
          "secretsmanager:PutSecretValue",
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
          "secretsmanager:DeleteSecret",
          "secretsmanager:TagResource"
        ]
        Resource = "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:presidio-connector/*"
      },
      {
        Sid      = "EncryptConnectorSecrets"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = aws_kms_key.connector_secrets.arn
      },
      # ── Simulate incident routes (POST /simulate/{appId}/break|heal, GET
      #    /simulate/{appId}/status) — see lambda-config-api/index.js's
      #    SIMULATE_REGISTRY. Each statement is scoped to exactly the
      #    resources that mechanism touches, not a blanket */* grant.
      {
        Sid    = "SimulateChaosToggle"
        Effect = "Allow"
        Action = ["ssm:PutParameter", "ssm:GetParameter"]
        Resource = [
          "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/shopco/chaos/*",
          "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/acme-payment-service/ops/*",
        ]
      },
      {
        Sid      = "SimulateAcmePaymentInvoke"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = aws_lambda_function.payment_service.arn
      },
      {
        Sid    = "SimulateInventoryThrottle"
        Effect = "Allow"
        Action = ["lambda:PutFunctionConcurrency", "lambda:DeleteFunctionConcurrency"]
        # shopco-inventory-service is deployed by the separate shopco-platform
        # Terraform stack (same AWS account) — referenced by literal ARN since
        # this state has no resource to point at.
        Resource = "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:shopco-inventory-service"
      },
      {
        Sid    = "SimulateStatusReadAlarms"
        Effect = "Allow"
        Action = ["cloudwatch:DescribeAlarms"]
        # DescribeAlarms does not support resource-level restriction (same
        # constraint the triage agent's own ReadMetrics statement in
        # agent.tf already accepts for this action).
        Resource = "*"
      }
    ]
  })
}

resource "null_resource" "config_api_deps" {
  triggers = { pkg = filemd5("${path.module}/../lambda-config-api/package.json") }
  provisioner "local-exec" {
    command     = "npm install --production"
    working_dir = "${path.module}/../lambda-config-api"
  }
}

data "archive_file" "config_api_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda-config-api"
  output_path = "${path.module}/../.build/config-api.zip"
  depends_on  = [null_resource.config_api_deps]
}

resource "aws_lambda_function" "config_api" {
  function_name    = "presidio-config-api"
  description      = "CRUD API for customer-configured connectors and applications"
  role             = aws_iam_role.config_api_role.arn
  handler          = "index.handler"
  runtime          = "nodejs18.x"
  timeout          = 15
  memory_size      = 256
  filename         = data.archive_file.config_api_zip.output_path
  source_code_hash = data.archive_file.config_api_zip.output_base64sha256

  vpc_config {
    subnet_ids         = local.tracex_lambda_subnet_ids
    security_group_ids = local.tracex_lambda_security_group_ids
  }

  environment {
    variables = {
      CONNECTOR_TABLE_NAME = aws_dynamodb_table.connector_registry.name
      CONNECTOR_KMS_KEY_ID = aws_kms_key.connector_secrets.arn
    }
  }

  depends_on = [aws_iam_role_policy_attachment.config_api_vpc_access]
}

resource "aws_apigatewayv2_api" "config_api" {
  name          = "presidio-config-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers = ["content-type"]
  }
}

resource "aws_apigatewayv2_integration" "config_api_integration" {
  api_id                 = aws_apigatewayv2_api.config_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.config_api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "config_api_route" {
  api_id    = aws_apigatewayv2_api.config_api.id
  route_key = "ANY /{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.config_api_integration.id}"
}

resource "aws_apigatewayv2_stage" "config_api_default" {
  api_id      = aws_apigatewayv2_api.config_api.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "config_api_invoke" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.config_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.config_api.execution_arn}/*/*"
}
