#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORBIDDEN='^[[:space:]]*resource[[:space:]]+"aws_(vpc|subnet|route|route_table|route_table_association|nat_gateway|internet_gateway|egress_only_internet_gateway|vpc_peering_connection)"'

if grep -ERn "$FORBIDDEN" "$ROOT/terraform"; then
  echo "ERROR: TraceX is not authorized to create or manage network infrastructure."
  echo "Use data sources for path-labs-innovation-sprint-vpc and its existing private subnets."
  exit 1
fi

echo "✓ Network authority check passed: no VPC/subnet/route/NAT/IGW resources are managed by TraceX"
