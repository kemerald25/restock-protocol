require('dotenv').config();
const { ethers } = require('ethers');

async function main() {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL;
  const key = process.env.MERCHANT_PRIVATE_KEY;

  if (!rpcUrl || !key) {
    console.error('Missing BASE_SEPOLIA_RPC_URL or MERCHANT_PRIVATE_KEY in .env');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const sender = new ethers.Wallet(key, provider);

  console.log('Sending from:', sender.address);

  const tx = await sender.sendTransaction({
    to: '0xD25e361679d00a46D440E21483237Aca3d28480A',
    value: ethers.parseEther('0.00005'),
  });

  console.log('Sent. Tx hash:', tx.hash);
  await tx.wait();
  console.log('Confirmed.');
}

main().catch(console.error);