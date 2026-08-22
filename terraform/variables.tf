variable "aws_region" { default = "us-east-1" }

# Authority-provided network. TraceX looks these resources up by Name tag and
# never creates or manages the VPC, subnets, routes, NAT, or internet gateway.
variable "existing_vpc_name" {
  type    = string
  default = "path-labs-innovation-sprint-vpc"
}

variable "existing_private_subnet_name_pattern" {
  type    = string
  default = "path-labs-innovation-sprint-private-*"
}

# ── OpenRouter ──
variable "openrouter_api_key" {
  type      = string
  sensitive = true
  default   = ""
}

# Deprecated compatibility alias. New configurations should use
# openrouter_api_key instead.
variable "anthropic_api_key" {
  type      = string
  sensitive = true
  default   = ""
}

variable "openrouter_model" {
  type    = string
  default = "anthropic.claude-sonnet-5"
}

variable "slack_bot_token" {
  type      = string
  sensitive = true
}
variable "slack_channel_id" { type = string }
variable "github_token" {
  type      = string
  sensitive = true
}
variable "github_repo_owner" { type = string }
variable "github_repo_name" {
  type    = string
  default = "acme-payment-service"
}

# ── The breaking commit (from your GitHub repo) ──
variable "breaking_commit_sha" {
  type    = string
  default = "a3f8b2c"
}
variable "breaking_commit_msg" {
  type    = string
  default = "refactor: payment service cleanup - remove legacy null checks"
}
variable "breaking_commit_author" {
  type    = string
  default = "dev-jsmith"
}
