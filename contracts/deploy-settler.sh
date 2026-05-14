#!/usr/bin/env bash
# Deploy StoaSettler to Arc Testnet. Reads env from ../.env.
set -euo pipefail

cd "$(dirname "$0")"
set -a
# shellcheck disable=SC1091
source ../.env
set +a

export PATH="$HOME/.foundry/bin:$PATH"

forge script script/DeployStoaSettler.s.sol:DeployStoaSettler \
    --rpc-url "$ARC_TESTNET_RPC" \
    --broadcast \
    --slow \
    -vvv
