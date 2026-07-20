import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ethers } from 'ethers'
import './index.css'
import App from './App.tsx'

const mockPrivateKey = import.meta.env.VITE_MOCK_PRIVATE_KEY
const rpcUrl = import.meta.env.VITE_BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org"

if (window.location.search.includes("mock_wallet=true") && mockPrivateKey) {
  console.log("[Mock Wallet] Injecting mock window.ethereum...");
  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const wallet = new ethers.Wallet(mockPrivateKey, provider)

  const mockEthereum = {
    isMetaMask: true,
    request: async ({ method, params }: any) => {
      console.log(`[Mock Wallet Request] Method: ${method}`, params);
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [wallet.address];
        case "eth_chainId":
          return "0x14a34"; // 84532
        case "wallet_switchEthereumChain":
          return null;
        case "eth_signTypedData_v4": {
          const typedData = JSON.parse(params[1]);
          const cleanTypes = { ...typedData.types };
          delete cleanTypes.EIP712Domain;
          const sig = await wallet.signTypedData(
            typedData.domain,
            cleanTypes,
            typedData.message
          );
          return sig;
        }
        default:
          return await provider.send(method, params || []);
      }
    },
    on: (event: string, _callback: any) => {
      console.log(`[Mock Wallet Event Listen] Event: ${event}`);
    },
    removeListener: (event: string, _callback: any) => {
      console.log(`[Mock Wallet Event Remove] Event: ${event}`);
    }
  };

  (window as any).ethereum = mockEthereum;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
