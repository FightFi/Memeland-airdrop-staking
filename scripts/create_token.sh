#!/bin/bash
set -e
 
KEYPAIR="keypairs/admin.json"

solana config set --keypair $KEYPAIR
solana config set --url devnet
solana airdrop 2

echo "Creando token FIGHT..."
MINT_OUTPUT=$(spl-token create-token --decimals 9 --url devnet)
echo "$MINT_OUTPUT"

MINT_ADDRESS=$(echo "$MINT_OUTPUT" | grep "Creating token" | awk '{print $3}')
echo "Mint address: $MINT_ADDRESS"

echo "Creando token account..."
spl-token create-account $MINT_ADDRESS --url devnet

echo "Minting 500M FIGHT..."
MAX_UNITS=18446744073709551615
spl-token mint $MINT_ADDRESS $MAX_UNITS --url devnet

echo "✅ Listo"
echo "Owner + receiver: $(solana-keygen pubkey $KEYPAIR)"
echo "Mint: $MINT_ADDRESS"
# 18.446.744.073,709551615 FIGHT