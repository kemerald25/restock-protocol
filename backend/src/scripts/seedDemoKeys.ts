import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { generateApiKey } from "../lib/auth";

dotenv.config();

function updateEnvFile(filePath: string, updates: Record<string, string>) {
  let content = "";
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, "utf8");
  }

  for (const [key, val] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${val}`);
    } else {
      if (content && !content.endsWith("\n")) content += "\n";
      content += `${key}=${val}\n`;
    }
  }

  fs.writeFileSync(filePath, content, "utf8");
}

export function seedDemoKeys() {
  // 1. Issue Demo Buyer Key (buyer:transact, public:read)
  const buyerKeyRes = generateApiKey({
    ownerType: "INTEGRATOR",
    ownerId: "buyer_demo",
    name: "Demo Buyer Operational Key",
    scopes: ["buyer:transact", "public:read"],
    rateLimitTier: "DEFAULT"
  });

  // 2. Issue Demo Merchant Key (merchant:read, merchant:write, public:read - NO merchant:keys:write)
  const merchantKeyRes = generateApiKey({
    ownerType: "MERCHANT",
    ownerId: "mer_genesis_merchant_01",
    name: "Demo Merchant Operational Key",
    scopes: ["merchant:read", "merchant:write", "public:read"],
    rateLimitTier: "DEFAULT"
  });

  const rootEnvPath = path.join(__dirname, "../../../.env");
  const backendEnvPath = path.join(__dirname, "../../.env");
  const clientEnvPath = path.join(__dirname, "../../../client/.env");
  const agentEnvPath = path.join(__dirname, "../../../agent/.env");

  updateEnvFile(rootEnvPath, {
    DEMO_BUYER_API_KEY: buyerKeyRes.secret,
    DEMO_MERCHANT_API_KEY: merchantKeyRes.secret
  });

  updateEnvFile(backendEnvPath, {
    DEMO_BUYER_API_KEY: buyerKeyRes.secret,
    DEMO_MERCHANT_API_KEY: merchantKeyRes.secret
  });

  updateEnvFile(clientEnvPath, {
    VITE_DEMO_BUYER_API_KEY: buyerKeyRes.secret,
    VITE_DEMO_MERCHANT_API_KEY: merchantKeyRes.secret
  });

  updateEnvFile(agentEnvPath, {
    DEMO_BUYER_API_KEY: buyerKeyRes.secret
  });

  console.log("Successfully seeded dedicated demo keys:");
  console.log(`- Demo Buyer Key Issued: ${buyerKeyRes.record.maskedKey} (Scopes: ${buyerKeyRes.record.scopes.join(", ")})`);
  console.log(`- Demo Merchant Key Issued: ${merchantKeyRes.record.maskedKey} (Scopes: ${merchantKeyRes.record.scopes.join(", ")})`);
  console.log("- Saved secrets to .env, backend/.env, client/.env, and agent/.env");

  return {
    buyerKey: buyerKeyRes.secret,
    merchantKey: merchantKeyRes.secret
  };
}

if (require.main === module) {
  seedDemoKeys();
}
