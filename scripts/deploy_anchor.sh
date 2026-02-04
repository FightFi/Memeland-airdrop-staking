#!/bin/bash
set -e

# ----- CONFIG -----
KEYPAIR="keypairs/admin.json"
CLUSTER="devnet"

# ----- CONFIGURE SOLANA -----
echo "🔑 Setting keypair and cluster..."
solana config set --keypair $KEYPAIR
solana config set --url $CLUSTER

# ----- ANCHOR DEPLOY -----
echo "🚀 Deploying Anchor program..."
ANCHOR_WALLET=$KEYPAIR anchor deploy --provider.cluster $CLUSTER

# ----- FINAL INFO -----
PROGRAM_ID=$(anchor keys list | grep "Program Id:" | awk '{print $3}')
echo "✅ Deploy completed"
echo "Keypair used: $KEYPAIR"
echo "Cluster: $CLUSTER"
echo "Program ID: $PROGRAM_ID"
