import { readDB, writeDB } from "../lib/db";
import { generateApiKey } from "../lib/auth";
import { MerchantAccount } from "../types";

const GENESIS_MERCHANT_ID = "mer_genesis_merchant_01";
const GENESIS_WALLET_ADDRESS = "0x345924F66825794e424f9B402756d7015a8dC12E";

export interface GenesisKeysConfig {
  adminKey: string;
  merchantKey: string;
  buyerAgentKey: string;
  generatedAt: number;
}

export function seedGenesis(): GenesisKeysConfig {
  const db = readDB();
  const now = Math.floor(Date.now() / 1000);

  // 1. Seed Merchant Account if missing
  if (!db.merchants[GENESIS_MERCHANT_ID]) {
    console.log(`[Genesis Seed] Creating genesis merchant account ${GENESIS_MERCHANT_ID}...`);
    const genesisMerchant: MerchantAccount = {
      id: GENESIS_MERCHANT_ID,
      legalName: "Genesis Protocol Merchant",
      contactEmail: "genesis@restockprotocol.com",
      verificationStatus: "VERIFIED",
      wallets: [
        {
          address: GENESIS_WALLET_ADDRESS,
          role: "PRIMARY_PAYOUT",
          addedAt: now,
          signatureProof: "GENESIS_BOOTSTRAP_PROOF"
        }
      ],
      trustTier: {
        tierLevel: "TIER_2_ENTERPRISE",
        maxRoyaltyBps: 2500,
        maxActiveSKUs: 9999,
        requiresManualSKUApproval: false
      },
      createdAt: now,
      updatedAt: now
    };
    db.merchants[GENESIS_MERCHANT_ID] = genesisMerchant;
    writeDB(db);
  } else {
    console.log(`[Genesis Seed] Genesis merchant account ${GENESIS_MERCHANT_ID} exists.`);
  }

  // 2. Clean up previous genesis keys in db to avoid key accretion
  const updatedDb = readDB();
  const genesisOwnerIds = new Set(["admin_genesis", GENESIS_MERCHANT_ID, "agent_genesis"]);
  for (const [hash, keyRec] of Object.entries(updatedDb.apiKeys)) {
    if (genesisOwnerIds.has(keyRec.ownerId) && keyRec.name.startsWith("Genesis")) {
      delete updatedDb.apiKeys[hash];
    }
  }
  writeDB(updatedDb);

  // 3. Generate fresh CSPRNG Genesis API Keys matching locked spec scopes
  console.log(`[Genesis Seed] Issuing new CSPRNG genesis API keys...`);

  const adminGen = generateApiKey({
    ownerType: "ADMIN",
    ownerId: "admin_genesis",
    name: "Genesis Admin Key",
    scopes: ["admin:read", "admin:write", "merchant:write", "merchant:keys:write", "buyer:transact", "public:read"],
    rateLimitTier: "UNLIMITED"
  });

  const merchantGen = generateApiKey({
    ownerType: "MERCHANT",
    ownerId: GENESIS_MERCHANT_ID,
    name: "Genesis Merchant Key",
    scopes: ["merchant:read", "merchant:write", "merchant:keys:write", "public:read"],
    rateLimitTier: "ELEVATED"
  });

  const buyerAgentGen = generateApiKey({
    ownerType: "INTEGRATOR",
    ownerId: "agent_genesis",
    name: "Genesis Buyer Agent Key",
    scopes: ["buyer:transact", "public:read"],
    rateLimitTier: "ELEVATED"
  });

  const keysConfig: GenesisKeysConfig = {
    adminKey: adminGen.secret,
    merchantKey: merchantGen.secret,
    buyerAgentKey: buyerAgentGen.secret,
    generatedAt: now
  };

  console.log(`================================================================`);
  console.log(`=== GENESIS API KEYS ISSUED (SAVE SECURELY - PRINTED ONCE) ===`);
  console.log(`Admin Key:       ${adminGen.secret}`);
  console.log(`Merchant Key:    ${merchantGen.secret}`);
  console.log(`Buyer Agent Key: ${buyerAgentGen.secret}`);
  console.log(`================================================================`);

  return keysConfig;
}

// Execute directly if run via CLI
if (require.main === module) {
  seedGenesis();
}
