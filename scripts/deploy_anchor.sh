#!/bin/bash
set -e

# ----- CONFIG -----
KEYPAIR="keypairs/admin.json"
PROGRAM_KEYPAIR="keypairs/program-keypair.json"
CLUSTER="${CLUSTER:-devnet}"

# ----- PRE-DEPLOY SAFETY CHECKS -----
LIB_RS="programs/memeland_airdrop/src/lib.rs"

DEPLOYER_PUBKEY=$(solana-keygen pubkey "$KEYPAIR")
PROGRAM_PUBKEY=$(solana-keygen pubkey "$PROGRAM_KEYPAIR")
CODE_AUTHORITY=$(grep 'INIT_AUTHORITY' "$LIB_RS" | grep -oE '[A-HJ-NP-Za-km-z1-9]{32,44}')
CODE_PROGRAM_ID=$(grep 'declare_id!' "$LIB_RS" | grep -oE '[A-HJ-NP-Za-km-z1-9]{32,44}')

if [ "$DEPLOYER_PUBKEY" != "$CODE_AUTHORITY" ]; then
    echo "❌ DEPLOY BLOCKED: INIT_AUTHORITY does not match the deployer keypair."
    echo "   INIT_AUTHORITY in code: $CODE_AUTHORITY"
    echo "   Deployer pubkey:        $DEPLOYER_PUBKEY"
    exit 1
fi

if [ "$PROGRAM_PUBKEY" != "$CODE_PROGRAM_ID" ]; then
    echo "❌ DEPLOY BLOCKED: declare_id! does not match the program keypair."
    echo "   declare_id! in code:    $CODE_PROGRAM_ID"
    echo "   Program keypair pubkey: $PROGRAM_PUBKEY"
    exit 1
fi

echo "✅ Pre-deploy checks passed:"
echo "   INIT_AUTHORITY matches deployer: $DEPLOYER_PUBKEY"
echo "   declare_id! matches program keypair: $PROGRAM_PUBKEY"

# ----- CONFIGURE SOLANA -----
echo "🔑 Setting keypair and cluster..."
solana config set --keypair $KEYPAIR
solana config set --url $CLUSTER

# ----- ANCHOR DEPLOY -----
echo "🚀 Deploying Anchor program..."
ANCHOR_WALLET=$KEYPAIR anchor deploy --program-name memeland_airdrop --provider.cluster $CLUSTER --provider.wallet $KEYPAIR --program-keypair $PROGRAM_KEYPAIR

# ----- FINAL INFO -----
PROGRAM_ID=$(anchor keys list | grep "Program Id:" | awk '{print $3}')
echo "✅ Deploy completed"
echo "Keypair used: $KEYPAIR"
echo "Cluster: $CLUSTER"
echo "Program ID: $PROGRAM_ID"
