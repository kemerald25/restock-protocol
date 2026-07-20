import { useState, useEffect } from "react";
import { ethers } from "ethers";
import deployment from "../../contracts/deployments/base-sepolia.json";
import ClaimTokenArtifact from "../../contracts/artifacts/contracts/ClaimToken.sol/ClaimToken.json";
import { createX402PaymentHeader, type X402Signer } from "../../agent/x402-helper";
import "./App.css";

interface SKU {
  skuId: number;
  name: string;
  variant: string;
  category: string;
  merchant: string;
  maxSupply: number;
  mintedSupply: number;
  redeemedSupply: number;
  lowestListingPrice: string;
  availableUnits: number;
  royaltyBps: number;
}

interface Listing {
  listingId: number;
  seller: string;
  price: string;
  quantity: number;
  status: string;
}

type BuyStep =
  | "idle"
  | "reserving"
  | "awaiting_signature"
  | "settling"
  | "delivering"
  | "polling_balance"
  | "completed"
  | "failed";

export default function App() {
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [signer, setSigner] = useState<ethers.JsonRpcSigner | null>(null);
  const [address, setAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [networkError, setNetworkError] = useState<string>("");

  const [skus, setSkus] = useState<SKU[]>([]);
  const [loadingSkus, setLoadingSkus] = useState<boolean>(false);
  const [selectedSku, setSelectedSku] = useState<SKU | null>(null);

  const [listings, setListings] = useState<Listing[]>([]);
  const [loadingListings, setLoadingListings] = useState<boolean>(false);

  // Buy flow state
  const [buyStep, setBuyStep] = useState<BuyStep>("idle");
  const [reservationId, setReservationId] = useState<string>("");
  const [buyError, setBuyError] = useState<string>("");
  const [claimTokenBalance, setClaimTokenBalance] = useState<string | null>(null);
  const [txHashes, setTxHashes] = useState<{
    payment: string;
    fulfillment: string;
    delivery: string;
  } | null>(null);

  // Load available SKUs
  const fetchSkus = async () => {
    setLoadingSkus(true);
    try {
      const res = await fetch("/api/skus");
      if (!res.ok) throw new Error("Failed to fetch SKUs");
      const data = await res.json();
      setSkus(data.results || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingSkus(false);
    }
  };

  // Load listings for a selected SKU
  const fetchListings = async (skuId: number) => {
    setLoadingListings(true);
    try {
      const res = await fetch(`/api/skus/${skuId}/listings`);
      if (!res.ok) throw new Error("Failed to fetch listings");
      const data = await res.json();
      setListings(data.listings || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingListings(false);
    }
  };

  useEffect(() => {
    fetchSkus();
  }, []);

  useEffect(() => {
    if (selectedSku) {
      fetchListings(selectedSku.skuId);
    } else {
      setListings([]);
    }
  }, [selectedSku]);

  // Connect browser wallet
  const connectWallet = async () => {
    if (!(window as any).ethereum) {
      alert("MetaMask or compatible browser wallet not found!");
      return;
    }
    try {
      const browserProvider = new ethers.BrowserProvider((window as any).ethereum);
      setProvider(browserProvider);

      const accounts = await browserProvider.send("eth_requestAccounts", []);
      const browserSigner = await browserProvider.getSigner();
      setSigner(browserSigner);
      setAddress(accounts[0]);

      const net = await browserProvider.getNetwork();
      const cId = Number(net.chainId);
      setChainId(cId);

      if (cId !== 84532) {
        setNetworkError("Wrong network. Please switch to Base Sepolia (84532).");
      } else {
        setNetworkError("");
      }
    } catch (err) {
      console.error("Wallet connection failed:", err);
    }
  };

  // Auto-connect if already authorized
  useEffect(() => {
    if ((window as any).ethereum) {
      const browserProvider = new ethers.BrowserProvider((window as any).ethereum);
      browserProvider.send("eth_accounts", []).then((accounts) => {
        if (accounts.length > 0) {
          connectWallet();
        }
      });
    }
  }, []);

  // Listen to network/account shifts
  useEffect(() => {
    if ((window as any).ethereum) {
      const handleAccountsChanged = (accounts: string[]) => {
        if (accounts.length > 0) {
          setAddress(accounts[0]);
          connectWallet();
        } else {
          setAddress("");
          setSigner(null);
        }
      };
      const handleChainChanged = () => {
        window.location.reload();
      };

      (window as any).ethereum.on("accountsChanged", handleAccountsChanged);
      (window as any).ethereum.on("chainChanged", handleChainChanged);

      return () => {
        (window as any).ethereum.removeListener("accountsChanged", handleAccountsChanged);
        (window as any).ethereum.removeListener("chainChanged", handleChainChanged);
      };
    }
  }, []);

  const switchNetwork = async () => {
    if (!(window as any).ethereum) return;
    try {
      await (window as any).ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x14a34" }] // 84532
      });
    } catch (err: any) {
      if (err.code === 4902) {
        try {
          await (window as any).ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: "0x14a34",
              chainName: "Base Sepolia",
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: ["https://sepolia.base.org"],
              blockExplorerUrls: ["https://sepolia.basescan.org"]
            }]
          });
        } catch (addError) {
          console.error("Could not add Base Sepolia network:", addError);
        }
      } else {
        console.error("Could not switch network:", err);
      }
    }
  };

  const handleBuy = async (listing: Listing) => {
    if (!signer || !address || !provider) {
      alert("Please connect your wallet first!");
      return;
    }
    if (chainId !== 84532) {
      alert("Please switch network to Base Sepolia!");
      return;
    }

    setBuyStep("reserving");
    setBuyError("");
    setTxHashes(null);
    setClaimTokenBalance(null);

    try {
      // 1. Create Reservation
      const reserveRes = await fetch(`/api/listings/${listing.listingId}/reserve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buyer: address, quantity: 1 })
      });
      if (!reserveRes.ok) {
        const msg = await reserveRes.text();
        throw new Error(`Reservation failed: ${msg}`);
      }
      const reservation = await reserveRes.json();
      setReservationId(reservation.reservationId);

      // 2. Query Pay Route for Challenge
      setBuyStep("awaiting_signature");
      const payChallengeRes = await fetch(`/api/reservations/${reservation.reservationId}/pay`, {
        method: "POST"
      });
      if (payChallengeRes.status !== 402) {
        throw new Error(`Expected 402 Payment Required, got status ${payChallengeRes.status}`);
      }
      const challengeHeader = payChallengeRes.headers.get("payment-required");
      if (!challengeHeader) {
        throw new Error("Missing 'payment-required' challenge header");
      }

      const { decodePaymentRequiredHeader } = await import("@x402/core/http");
      const paymentRequired = decodePaymentRequiredHeader(challengeHeader);

      // 3. EIP-3009 Signature Request
      const clientSigner: X402Signer = {
        address: address.toLowerCase() as `0x${string}`,
        signTypedData: async (typedData: any) => {
          const cleanTypes = { ...typedData.types };
          delete cleanTypes.EIP712Domain;
          const sig = await signer.signTypedData(
            typedData.domain,
            cleanTypes,
            typedData.message
          );
          return sig as `0x${string}`;
        },
        readContract: async (args: any) => {
          const contract = new ethers.Contract(args.address, args.abi, signer);
          return await contract[args.functionName](...args.args);
        }
      };

      const paymentSigHeader = await createX402PaymentHeader(paymentRequired, clientSigner);

      // 4. Submit Signature for Settle/Fulfill/Deliver
      setBuyStep("settling");
      const paySubmitRes = await fetch(`/api/reservations/${reservation.reservationId}/pay`, {
        method: "POST",
        headers: {
          "payment-signature": paymentSigHeader
        }
      });

      if (!paySubmitRes.ok) {
        const msg = await paySubmitRes.text();
        throw new Error(`Payment submission failed: ${msg}`);
      }

      const result = await paySubmitRes.json();
      setTxHashes({
        payment: result.paymentTxHash,
        fulfillment: result.fulfillmentTxHash,
        delivery: result.deliveryTxHash
      });

      // 5. Poll for Balance Synchronization
      setBuyStep("polling_balance");
      const claimTokenAddress = deployment.ClaimToken;
      const claimTokenContract = new ethers.Contract(
        claimTokenAddress,
        ClaimTokenArtifact.abi,
        provider
      );

      let finalBalance = 0n;
      let balanceSynced = false;

      for (let i = 0; i < 15; i++) {
        const bal = await claimTokenContract.balanceOf(address, selectedSku!.skuId);
        if (bal > 0n) {
          finalBalance = bal;
          balanceSynced = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      if (!balanceSynced) {
        console.warn("ClaimToken balance did not sync on RPC within 30s.");
      }
      setClaimTokenBalance(finalBalance.toString());
      setBuyStep("completed");
      fetchSkus(); // Refresh inventory stock
    } catch (err: any) {
      console.error(err);
      setBuyError(err.message || String(err));
      setBuyStep("failed");
    }
  };

  const getExplorerLink = (hash: string) => `https://sepolia.basescan.org/tx/${hash}`;

  const truncateAddress = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  return (
    <div className="app-container">
      <header className="app-header">
        <div>
          <h1 className="app-title">Restock Protocol</h1>
          <p style={{ margin: 0, opacity: 0.7 }}>Reference Client (Phase 4, Part 1)</p>
        </div>
        <div className="wallet-panel">
          {address ? (
            <>
              <span className={`network-badge ${chainId !== 84532 ? "invalid" : ""}`}>
                {chainId === 84532 ? "Base Sepolia" : `Chain ID: ${chainId}`}
              </span>
              <span className="wallet-address" title={address}>
                {truncateAddress(address)}
              </span>
            </>
          ) : (
            <button className="btn-connect" onClick={connectWallet}>
              Connect Wallet
            </button>
          )}
        </div>
      </header>

      {networkError && (
        <div className="warning-banner">
          <span>{networkError}</span>
          <button onClick={switchNetwork}>Switch to Base Sepolia</button>
        </div>
      )}

      <main className="main-grid">
        {/* Left Side: Inventory Browsing */}
        <div>
          <h2 className="section-title">Tokenized Inventory</h2>
          {loadingSkus ? (
            <p>Loading catalog...</p>
          ) : skus.length === 0 ? (
            <p>No tokenized SKUs found in registry.</p>
          ) : (
            <div className="sku-list">
              {skus.map((sku) => (
                <div
                  key={sku.skuId}
                  className={`sku-card ${selectedSku?.skuId === sku.skuId ? "selected" : ""}`}
                  onClick={() => setSelectedSku(sku)}
                >
                  <div className="sku-header">
                    <h3 className="sku-name">
                      {sku.name} <span style={{ fontSize: "14px", fontWeight: "normal" }}>({sku.category})</span>
                    </h3>
                    <span className="sku-price">
                      {sku.lowestListingPrice ? `${sku.lowestListingPrice} USDC` : "No active listings"}
                    </span>
                  </div>
                  <div className="sku-meta">
                    <div>Variant: <strong>{sku.variant || "Default"}</strong></div>
                    <div>
                      Stock:{" "}
                      <span className={`badge ${sku.availableUnits > 0 ? "in-stock" : "out-of-stock"}`}>
                        {sku.availableUnits > 0 ? `${sku.availableUnits} units available` : "Out of stock"}
                      </span>
                    </div>
                    <div>Merchant: <strong style={{ fontSize: "12px", fontFamily: "monospace" }}>{truncateAddress(sku.merchant)}</strong></div>
                    <div>Royalty Bps: <strong>{sku.royaltyBps} bps</strong></div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {selectedSku && (
            <div className="listings-container">
              <h2 className="section-title" style={{ fontSize: "18px" }}>
                Active Listings for {selectedSku.name}
              </h2>
              {loadingListings ? (
                <p>Loading listings...</p>
              ) : listings.length === 0 ? (
                <p>No active seller listings found for this SKU.</p>
              ) : (
                <div>
                  {listings.map((l) => (
                    <div key={l.listingId} className="listing-row">
                      <div className="listing-info">
                        <span className="seller-address">Seller: {truncateAddress(l.seller)}</span>
                        <span style={{ fontSize: "14px" }}>
                          Qty: <strong>{l.quantity}</strong> | Price: <strong>{l.price} USDC</strong>
                        </span>
                      </div>
                      <button
                        className="btn-buy"
                        disabled={l.quantity === 0 || l.status !== "Open" || buyStep !== "idle" && buyStep !== "completed" && buyStep !== "failed"}
                        onClick={() => handleBuy(l)}
                      >
                        Buy 1 Unit
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Side: Interactive Purchase Status Tracker */}
        <div>
          <h2 className="section-title">Purchase Details</h2>
          <div className="tracker-card">
            {buyStep === "idle" ? (
              <p style={{ opacity: 0.7, textAlign: "center", padding: "20px 0" }}>
                Select an active SKU listing and click "Buy" to initiate checkout.
              </p>
            ) : (
              <div>
                <h3 style={{ margin: "0 0 16px 0", fontSize: "16px" }}>Checkout Pipeline</h3>
                {reservationId && (
                  <div style={{ marginBottom: "12px", fontSize: "14px", opacity: 0.8 }}>
                    Reservation ID: <strong>{reservationId}</strong>
                  </div>
                )}
                <div className="steps-list">
                  <div className={`step-item ${buyStep === "reserving" ? "active" : buyStep !== "failed" ? "completed" : ""}`}>
                    <span className="step-dot" />
                    <span>Reserving item inventory on-chain...</span>
                    {buyStep === "reserving" && <span className="spinner" />}
                  </div>

                  <div className={`step-item ${buyStep === "awaiting_signature" ? "active" : ["reserving"].includes(buyStep) ? "" : buyStep !== "failed" ? "completed" : ""}`}>
                    <span className="step-dot" />
                    <span>Awaiting EIP-3009 signature in MetaMask...</span>
                    {buyStep === "awaiting_signature" && <span className="spinner" />}
                  </div>

                  <div className={`step-item ${buyStep === "settling" ? "active" : ["reserving", "awaiting_signature"].includes(buyStep) ? "" : buyStep !== "failed" ? "completed" : ""}`}>
                    <span className="step-dot" />
                    <span>Settling payment & executing fulfillment...</span>
                    {buyStep === "settling" && <span className="spinner" />}
                  </div>

                  <div className={`step-item ${buyStep === "polling_balance" ? "active" : ["reserving", "awaiting_signature", "settling"].includes(buyStep) ? "" : buyStep === "completed" ? "completed" : ""}`}>
                    <span className="step-dot" />
                    <span>Awaiting claim token delivery...</span>
                    {buyStep === "polling_balance" && <span className="spinner" />}
                  </div>
                </div>

                {buyError && <div className="error-message">Error: {buyError}</div>}

                {txHashes && (
                  <div style={{ marginTop: "24px", display: "flex", flexDirection: "column", gap: "8px" }}>
                    <h4 style={{ margin: "0 0 8px 0", fontSize: "14px" }}>Transaction Explorer Links</h4>
                    <div>
                      <span style={{ fontSize: "13px" }}>Payment: </span>
                      <a href={getExplorerLink(txHashes.payment)} target="_blank" rel="noreferrer" className="tx-hash-link">
                        {truncateAddress(txHashes.payment)}
                      </a>
                    </div>
                    <div>
                      <span style={{ fontSize: "13px" }}>Fulfillment: </span>
                      <a href={getExplorerLink(txHashes.fulfillment)} target="_blank" rel="noreferrer" className="tx-hash-link">
                        {truncateAddress(txHashes.fulfillment)}
                      </a>
                    </div>
                    <div>
                      <span style={{ fontSize: "13px" }}>Delivery: </span>
                      <a href={getExplorerLink(txHashes.delivery)} target="_blank" rel="noreferrer" className="tx-hash-link">
                        {truncateAddress(txHashes.delivery)}
                      </a>
                    </div>
                  </div>
                )}

                {buyStep === "completed" && claimTokenBalance && (
                  <div className="success-container">
                    <p className="success-title">Purchase Successful!</p>
                    <p style={{ margin: 0, fontSize: "14px" }}>Claim Tokens are now in your browser wallet.</p>
                    <div className="balance-card">
                      SKU #{selectedSku?.skuId} Balance: <strong>{claimTokenBalance} unit(s)</strong>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
