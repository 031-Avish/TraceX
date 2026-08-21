# ═══════════════════════════════════════════════════════════════
#  VPC ENDPOINTS — Private paths from VPC-resident Lambdas to AWS services
#
#  Without these, every AWS SDK call from inside the VPC exits through the
#  authority-managed NAT gateway, adding latency and creating a hard dependency
#  on the NAT being available. With endpoints, traffic stays on AWS's private
#  backbone and never touches the internet.
#
#  Gateway endpoints (free — injected as a route into the private route tables):
#    - DynamoDB      (connector-registry.js: connector metadata reads/writes)
#
#  Interface endpoints (billed per AZ-hour — ENI placed in each private subnet):
#    - SSM           (lambda-demo-app: reads /presidio-demo/chaos-mode)
#    - Secrets Manager (agent + config-api: read/write connector tokens)
#    - CloudWatch Logs (all Lambdas: write logs; agent: FilterLogEvents/GetLogEvents)
#    - CloudWatch    (agent: GetMetricData + DescribeAlarms)
#
#  All interface endpoints share a dedicated security group that accepts HTTPS
#  only from the Lambda workloads security group defined in network.tf.
#
#  Note: private_dns_enabled = true requires DNS resolution and DNS hostnames
#  to be enabled on the authority-provided VPC (both are on by default in AWS).
# ═══════════════════════════════════════════════════════════════

# ── Security group for interface endpoint ENIs ────────────────
#  Accepts HTTPS from Lambda workloads only. No egress rule needed —
#  security groups are stateful, so return traffic is automatically allowed.
resource "aws_security_group" "vpc_endpoints" {
  name        = "presidio-tracex-vpc-endpoints"
  description = "HTTPS inbound from TraceX Lambda workloads to interface endpoint ENIs"
  vpc_id      = data.aws_vpc.authority_provided.id

  ingress {
    description     = "HTTPS from TraceX Lambda workloads"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda_workloads.id]
  }
}

# ── Route table lookup for the DynamoDB gateway endpoint ──────
#  Gateway endpoints are injected as routes, not ENIs, so Terraform needs
#  the route table IDs for the private subnets — not the subnet IDs themselves.
data "aws_route_tables" "authority_private" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.authority_provided.id]
  }
  filter {
    name   = "association.subnet-id"
    values = data.aws_subnets.authority_private.ids
  }
}

# ── DynamoDB — Gateway endpoint (free) ───────────────────────
resource "aws_vpc_endpoint" "dynamodb" {
  vpc_id            = data.aws_vpc.authority_provided.id
  service_name      = "com.amazonaws.${var.aws_region}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = data.aws_route_tables.authority_private.ids

  tags = { Name = "presidio-tracex-dynamodb-endpoint" }
}

# ── SSM — Interface endpoint ──────────────────────────────────
#  Used by lambda-demo-app to read /presidio-demo/chaos-mode.
#  Only the SSM service endpoint is needed — ssm-messages and ec2messages
#  are for Session Manager, which TraceX does not use.
resource "aws_vpc_endpoint" "ssm" {
  vpc_id              = data.aws_vpc.authority_provided.id
  service_name        = "com.amazonaws.${var.aws_region}.ssm"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = local.tracex_lambda_subnet_ids
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = { Name = "presidio-tracex-ssm-endpoint" }
}

# ── Secrets Manager — Interface endpoint ──────────────────────
#  Used by connector-registry.js (agent) and lambda-config-api to read
#  and write connector tokens (GitHub PAT, Slack bot token).
#  KMS decryption of the secret happens server-side within AWS — the Lambda
#  does not call KMS directly, so no separate KMS endpoint is needed.
resource "aws_vpc_endpoint" "secretsmanager" {
  vpc_id              = data.aws_vpc.authority_provided.id
  service_name        = "com.amazonaws.${var.aws_region}.secretsmanager"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = local.tracex_lambda_subnet_ids
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = { Name = "presidio-tracex-secretsmanager-endpoint" }
}

# ── CloudWatch Logs — Interface endpoint ──────────────────────
#  Used by every Lambda to write its own logs (PutLogEvents), and by the
#  triage agent to query the payment service log group (FilterLogEvents,
#  GetLogEvents) during investigation.
resource "aws_vpc_endpoint" "cloudwatch_logs" {
  vpc_id              = data.aws_vpc.authority_provided.id
  service_name        = "com.amazonaws.${var.aws_region}.logs"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = local.tracex_lambda_subnet_ids
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = { Name = "presidio-tracex-cloudwatch-logs-endpoint" }
}

# ── CloudWatch Monitoring — Interface endpoint ────────────────
#  Used by the triage agent to call GetMetricData (error rate time series)
#  and DescribeAlarms (alarm threshold and state change details).
resource "aws_vpc_endpoint" "cloudwatch_monitoring" {
  vpc_id              = data.aws_vpc.authority_provided.id
  service_name        = "com.amazonaws.${var.aws_region}.monitoring"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = local.tracex_lambda_subnet_ids
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = { Name = "presidio-tracex-cloudwatch-monitoring-endpoint" }
}
