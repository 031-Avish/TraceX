variable "aws_region" { default = "us-east-1" }

# ── Azure AI Foundry / Azure OpenAI ──
variable "azure_openai_endpoint" {
  type        = string
  description = "Azure AI Foundry endpoint, e.g. https://<resource>.openai.azure.com"
}
variable "azure_openai_api_key" {
  type      = string
  sensitive = true
}
variable "azure_openai_deployment" {
  type        = string
  description = "The deployment name you created in Azure AI Foundry (not the base model name)"
}
variable "azure_openai_api_version" {
  type    = string
  default = "2024-08-01-preview"
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
# After running scripts/setup-github-repo.sh, it prints the SHA.
# Paste it here so the demo app logs the REAL SHA.
variable "breaking_commit_sha" {
  type        = string
  description = "Short SHA of the breaking commit in your GitHub repo"
  default     = "a3f8b2c" # placeholder — update with real SHA
}

variable "breaking_commit_msg" {
  type    = string
  default = "refactor: payment service cleanup - remove legacy null checks"
}

variable "breaking_commit_author" {
  type    = string
  default = "dev-jsmith"
}
