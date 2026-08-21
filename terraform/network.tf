# ═══════════════════════════════════════════════════════════════
#  AUTHORITY-PROVIDED NETWORK — LOOKUP ONLY
#
#  TraceX must use the existing innovation-sprint VPC. This file deliberately
#  contains no aws_vpc, aws_subnet, aws_route_table, aws_nat_gateway, or
#  aws_internet_gateway resources. Terraform only discovers the supplied VPC
#  and its private subnets. The authority-owned network is never managed by
#  this state and cannot be destroyed by `terraform destroy`.
# ═══════════════════════════════════════════════════════════════

data "aws_vpc" "authority_provided" {
  filter {
    name   = "tag:Name"
    values = [var.existing_vpc_name]
  }
}

data "aws_subnets" "authority_private" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.authority_provided.id]
  }

  filter {
    name   = "tag:Name"
    values = [var.existing_private_subnet_name_pattern]
  }
}

# TraceX owns only this workload security group. It has no inbound rules.
# Outbound HTTPS/DNS follows the authority-managed private route table/NAT.
resource "aws_security_group" "lambda_workloads" {
  name        = "presidio-tracex-lambda-workloads"
  description = "Outbound-only security group for TraceX Lambda ENIs"
  vpc_id      = data.aws_vpc.authority_provided.id

  egress {
    description = "Outbound access through authority-managed VPC routing"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    precondition {
      condition     = length(data.aws_subnets.authority_private.ids) >= 2
      error_message = "The authority-provided VPC must expose at least two private subnets matching existing_private_subnet_name_pattern."
    }
  }
}

locals {
  tracex_lambda_subnet_ids         = sort(data.aws_subnets.authority_private.ids)
  tracex_lambda_security_group_ids = [aws_security_group.lambda_workloads.id]
}

# VPC-attached Lambdas need ENI lifecycle permissions. These attachments do
# not grant permission to create or modify VPCs, subnets, routes, NAT, or IGWs.
resource "aws_iam_role_policy_attachment" "demo_app_vpc_access" {
  role       = aws_iam_role.demo_app_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "traffic_gen_vpc_access" {
  role       = aws_iam_role.traffic_gen_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "agent_vpc_access" {
  role       = aws_iam_role.agent_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "config_api_vpc_access" {
  role       = aws_iam_role.config_api_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}
