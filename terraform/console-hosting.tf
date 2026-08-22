# ═══════════════════════════════════════════════════════════════
#  CONSOLE HOSTING — S3 + CloudFront for the connector console
#
#  Static React (Vite) build, served over HTTPS via CloudFront. The bucket
#  is fully private — CloudFront reaches it through Origin Access Control;
#  nothing in it is ever directly public. The build itself is triggered by
#  Terraform (npm install && npm run build with the deployed config API URL
#  baked in), then synced to S3 and invalidated — so `./deploy.sh` produces
#  a real, hosted console URL, not "run npm run dev on your laptop."
# ═══════════════════════════════════════════════════════════════

resource "aws_s3_bucket" "console" {
  # Account ID suffix for guaranteed global uniqueness (S3 bucket names are
  # unique across ALL AWS accounts, not just this one).
  bucket = "presidio-tracex-console-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "console" {
  bucket                  = aws_s3_bucket.console.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "console" {
  name                              = "presidio-tracex-console-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

resource "aws_cloudfront_distribution" "console" {
  enabled             = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  comment             = "TraceX connector console"

  origin {
    domain_name              = aws_s3_bucket.console.bucket_regional_domain_name
    origin_id                = "console-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.console.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "console-s3"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_optimized.id
  }

  # SPA client-side routing: any path that isn't a real S3 object (e.g.
  # /connectors, /applications) falls back to index.html so React Router
  # handles it client-side instead of showing an S3/CloudFront error page.
  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # No custom domain for the hackathon — CloudFront's own domain + default
  # certificate is real HTTPS, just not a branded URL. Adding a custom
  # domain later means an ACM cert (must be in us-east-1) + Route53 record,
  # both out of scope here.
  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

resource "aws_s3_bucket_policy" "console" {
  bucket = aws_s3_bucket.console.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontRead"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.console.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.console.arn
        }
      }
    }]
  })
}

# ── Build + publish the console on every apply ───────────────────
# Runs with whatever AWS credentials are already deploying the rest of the
# stack (same ones deploy.sh's prereq check already requires) — no separate
# IAM role needed for a local build/upload step.
resource "null_resource" "console_build_deploy" {
  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    working_dir = "${path.module}/../console"
    command     = <<-EOT
      set -e
      npm install --silent
      VITE_CONFIG_API_URL=${aws_apigatewayv2_api.config_api.api_endpoint} npm run build
      aws s3 sync dist/ s3://${aws_s3_bucket.console.id} --delete \
        --cache-control "public, max-age=31536000, immutable" \
        --exclude "index.html" \
        --region ${var.aws_region}
      aws s3 cp dist/index.html s3://${aws_s3_bucket.console.id}/index.html \
        --cache-control "no-cache, no-store, must-revalidate" \
        --region ${var.aws_region}
      aws cloudfront create-invalidation \
        --distribution-id ${aws_cloudfront_distribution.console.id} \
        --paths "/index.html" "/"
    EOT
  }

  depends_on = [
    aws_s3_bucket_policy.console,
    aws_apigatewayv2_api.config_api,
  ]
}
