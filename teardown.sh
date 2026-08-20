#!/bin/bash
set -e
cd "$(dirname "$0")/terraform"
echo -e "\n⚠️  Destroying ALL resources...\n"
terraform destroy
echo -e "\n✓ All resources destroyed.\n"
