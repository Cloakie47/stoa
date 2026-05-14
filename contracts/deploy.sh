#!/usr/bin/env bash
# Deploy Splitter + TracePin to Arc Testnet. Reads env from ../.env.
set -euo pipefail

cd "$(dirname "$0")"
set -a
# shellcheck disable=SC1091
source ../.env
set +a

export PATH="$HOME/.foundry/bin:$PATH"

forge script script/Deploy.s.sol:Deploy \
    --rpc-url "$ARC_TESTNET_RPC" \
    --broadcast \
    --slow \
    -vvv
