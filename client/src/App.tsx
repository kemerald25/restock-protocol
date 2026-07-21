import { useState, useEffect } from "react";
import { ethers } from "ethers";
import deployment from "../../contracts/deployments/base-sepolia.json";
import ClaimTokenArtifact from "../../contracts/artifacts/contracts/ClaimToken.sol/ClaimToken.json";
import { createX402PaymentHeader, type X402Signer } from "../../agent/x402-helper";
import { canonicalizeAndHashAddress } from "./lib/utils";
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

const demoBuyerApiKey = import.meta.env.VITE_DEMO_BUYER_API_KEY || "";
const demoMerchantApiKey = import.meta.env.VITE_DEMO_MERCHANT_API_KEY || "";

export default function App() {
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [signer, setSigner] = useState<ethers.JsonRpcSigner | null>(null);
  const [address, setAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [networkError, setNetworkError] = useState<string>("");

  const [activeTab, setActiveTab] = useState<"catalog" | "portfolio">("catalog");
  const [skus, setSkus] = useState<SKU[]>([]);
  const [loadingSkus, setLoadingSkus] = useState<boolean>(false);
  const [selectedSku, setSelectedSku] = useState<SKU | null>(null);

  const [listings, setListings] = useState<Listing[]>([]);
  const [loadingListings, setLoadingListings] = useState<boolean>(false);

  // Portfolio state
  const [myBalances, setMyBalances] = useState<{ [skuId: number]: number }>({});
  const [loadingBalances, setLoadingBalances] = useState<boolean>(false);

  // Listing creation state
  const [showListModal, setShowListModal] = useState<SKU | null>(null);
  const [listQuantity, setListQuantity] = useState<number>(1);
  const [listPrice, setListPrice] = useState<string>("0.01");
  const [isApproved, setIsApproved] = useState<boolean>(false);
  const [checkingApproval, setCheckingApproval] = useState<boolean>(false);
  const [listingStep, setListingStep] = useState<"idle" | "approving" | "submitting" | "completed" | "failed">("idle");
  const [listError, setListError] = useState<string>("");
  const [createdListingId, setCreatedListingId] = useState<string>("");

  // Redemption state
  const [showRedeemModal, setShowRedeemModal] = useState<SKU | null>(null);
  const [redeemQuantity, setRedeemQuantity] = useState<number>(1);
  const [shippingAddress, setShippingAddress] = useState<string>("123 Web3 Boulevard, San Francisco, CA 94103, US");
  const [redeemStep, setRedeemStep] = useState<"idle" | "hashing" | "redeeming_onchain" | "submitting_backend" | "completed" | "failed">("idle");
  const [redeemError, setRedeemError] = useState<string>("");
  const [redemptionResult, setRedemptionResult] = useState<{ redemptionId: string; fulfillmentStatus: string; txHash: string } | null>(null);

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
  const fetchSkus = async (silent = false) => {
    if (!silent && skus.length === 0) setLoadingSkus(true);
    try {
      const res = await fetch("/api/skus");
      if (!res.ok) throw new Error("Failed to fetch SKUs");
      const data = await res.json();
      const loadedSkus = data.results || [];
      setSkus(loadedSkus);
      if (address && provider) {
        fetchMyBalances(loadedSkus, silent);
      }
      return loadedSkus;
    } catch (err) {
      console.error(err);
      return [];
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

  // Fetch ClaimToken balances for connected wallet using ERC-1155 balanceOfBatch
  const fetchMyBalances = async (skuList?: SKU[], silent = false) => {
    if (!address || !provider) return;
    const listToQuery = skuList && skuList.length > 0 ? skuList : skus;
    if (!silent && Object.keys(myBalances).length === 0) setLoadingBalances(true);
    try {
      const claimTokenContract = new ethers.Contract(
        deployment.ClaimToken,
        ClaimTokenArtifact.abi,
        provider
      );

      // Collect candidate IDs 1..60 plus any catalog SKU IDs
      const candidateIds = new Set<number>(listToQuery.map((s) => Number(s.skuId)));
      for (let i = 1; i <= 60; i++) candidateIds.add(i);

      const idArray = Array.from(candidateIds).sort((a, b) => a - b);
      const accountsArray = idArray.map(() => address);

      // Execute a single batch RPC query to avoid MetaMask rate limiting
      const rawBalances = await claimTokenContract.balanceOfBatch(accountsArray, idArray);
      const balances: { [skuId: number]: number } = {};

      idArray.forEach((skuId, idx) => {
        const numBal = Number(rawBalances[idx] || 0);
        if (numBal > 0) {
          balances[skuId] = numBal;
        }
      });

      setMyBalances(balances);
    } catch (err) {
      console.error("Error fetching my balances via balanceOfBatch:", err);
    } finally {
      setLoadingBalances(false);
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

  useEffect(() => {
    if (address && provider && skus.length > 0) {
      fetchMyBalances();
    }
  }, [address, provider]);

  // Sync balances silently when activeTab switches to portfolio
  useEffect(() => {
    if (activeTab === "portfolio" && address && provider) {
      fetchSkus(true);
    }
  }, [activeTab, address, provider]);

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
        setNetworkError("Wrong network. Requesting switch to Base Sepolia (84532)...");
        await switchNetwork();
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

  // --- LISTING CREATION FLOW ---
  const openListModal = async (sku: SKU) => {
    setShowListModal(sku);
    setListQuantity(1);
    setListPrice("0.01");
    setListingStep("idle");
    setListError("");
    setCreatedListingId("");

    if (address && provider) {
      setCheckingApproval(true);
      try {
        const claimTokenContract = new ethers.Contract(
          deployment.ClaimToken,
          ClaimTokenArtifact.abi,
          provider
        );
        const approved = await claimTokenContract.isApprovedForAll(address, deployment.Marketplace);
        setIsApproved(Boolean(approved));
      } catch (e) {
        console.error("Error checking Marketplace approval:", e);
      } finally {
        setCheckingApproval(false);
      }
    }
  };

  const handleApproveMarketplace = async () => {
    if (!signer) return;
    setListingStep("approving");
    setListError("");
    try {
      const claimTokenContract = new ethers.Contract(
        deployment.ClaimToken,
        ClaimTokenArtifact.abi,
        signer
      );
      const tx = await claimTokenContract.setApprovalForAll(deployment.Marketplace, true);
      await tx.wait();
      setIsApproved(true);
      setListingStep("idle");
    } catch (err: any) {
      console.error(err);
      setListError(err.reason || err.message || String(err));
      setListingStep("failed");
    }
  };

  const handleCreateListing = async () => {
    if (!signer || !showListModal) return;
    setListingStep("submitting");
    setListError("");
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json"
      };
      if (demoMerchantApiKey) {
        headers["Authorization"] = `Bearer ${demoMerchantApiKey}`;
      }
      const res = await fetch("/api/merchant/listings", {
        method: "POST",
        headers,
        body: JSON.stringify({
          skuId: showListModal.skuId,
          quantity: listQuantity,
          pricePerUnit: listPrice
        })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || data.error || "Failed to create listing via merchant API");
      }

      setCreatedListingId(data.listingId ? String(data.listingId) : "Created");
      setListingStep("completed");
      fetchSkus();
      if (selectedSku) fetchListings(selectedSku.skuId);
      fetchMyBalances();
    } catch (err: any) {
      console.error(err);
      setListError(err.message || String(err));
      setListingStep("failed");
    }
  };

  // --- REDEMPTION FLOW ---
  const openRedeemModal = (sku: SKU) => {
    setShowRedeemModal(sku);
    setRedeemQuantity(1);
    setRedeemStep("idle");
    setRedeemError("");
    setRedemptionResult(null);
  };

  const handleRedeem = async () => {
    if (!signer || !address || !showRedeemModal) return;
    if (!shippingAddress.trim()) {
      setRedeemError("Please enter a valid shipping address.");
      return;
    }

    setRedeemStep("hashing");
    setRedeemError("");
    setRedemptionResult(null);

    try {
      // 1. Pre-flight shippingRef calculation
      const shippingRef = await canonicalizeAndHashAddress(shippingAddress);

      // 2. Call ClaimToken.redeem on-chain from holder wallet
      setRedeemStep("redeeming_onchain");
      const claimTokenContract = new ethers.Contract(
        deployment.ClaimToken,
        ClaimTokenArtifact.abi,
        signer
      );
      const tx = await claimTokenContract.redeem(
        showRedeemModal.skuId,
        redeemQuantity,
        shippingRef
      );
      const receipt = await tx.wait();

      // 3. Submit to Backend for Verification
      setRedeemStep("submitting_backend");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (demoBuyerApiKey) {
        headers["Authorization"] = `Bearer ${demoBuyerApiKey}`;
      }
      const res = await fetch(`/api/skus/${showRedeemModal.skuId}/redeem`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          holder: address,
          quantity: Number(redeemQuantity),
          txHash: receipt.hash,
          shippingAddress: shippingAddress,
          shippingRef: shippingRef
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ? `${data.error}${data.details ? `: ${data.details}` : ''}` : "Redemption backend verification failed");
      }

      setRedemptionResult({
        redemptionId: data.redemptionId,
        fulfillmentStatus: data.fulfillmentStatus,
        txHash: data.txHash || receipt.hash
      });
      setRedeemStep("completed");
      fetchSkus();
      fetchMyBalances();
    } catch (err: any) {
      console.error(err);
      setRedeemError(err.message || String(err));
      setRedeemStep("failed");
    }
  };

  // --- BUY FLOW ---
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
      const reserveHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (demoBuyerApiKey) {
        reserveHeaders["Authorization"] = `Bearer ${demoBuyerApiKey}`;
      }
      const reserveRes = await fetch(`/api/listings/${listing.listingId}/reserve`, {
        method: "POST",
        headers: reserveHeaders,
        body: JSON.stringify({ buyer: address, quantity: 1 })
      });
      if (!reserveRes.ok) {
        const msg = await reserveRes.text();
        throw new Error(`Reservation failed: ${msg}`);
      }
      const reservation = await reserveRes.json();
      setReservationId(reservation.reservationId);

      setBuyStep("awaiting_signature");
      const payChallengeHeaders: Record<string, string> = {};
      if (demoBuyerApiKey) {
        payChallengeHeaders["Authorization"] = `Bearer ${demoBuyerApiKey}`;
      }
      const payChallengeRes = await fetch(`/api/reservations/${reservation.reservationId}/pay`, {
        method: "POST",
        headers: payChallengeHeaders
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

      setBuyStep("settling");
      const submitHeaders: Record<string, string> = {
        "payment-signature": paymentSigHeader
      };
      if (demoBuyerApiKey) {
        submitHeaders["Authorization"] = `Bearer ${demoBuyerApiKey}`;
      }
      const paySubmitRes = await fetch(`/api/reservations/${reservation.reservationId}/pay`, {
        method: "POST",
        headers: submitHeaders
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
      const updated = await fetchSkus();
      await fetchMyBalances(updated);
    } catch (err: any) {
      console.error(err);
      setBuyError(err.message || String(err));
      setBuyStep("failed");
    }
  };

  const getExplorerLink = (hash: string) => `https://sepolia.basescan.org/tx/${hash}`;
  const truncateAddress = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  const heldSkus = skus.filter((sku) => (myBalances[Number(sku.skuId)] || 0) > 0);
  const extraHeldIds = Object.keys(myBalances)
    .map(Number)
    .filter((id) => (myBalances[id] || 0) > 0 && !skus.some((s) => Number(s.skuId) === id));

  const allHeldSkus: SKU[] = [
    ...heldSkus,
    ...extraHeldIds.map((id) => ({
      skuId: id,
      name: `SKU #${id}`,
      variant: "Default",
      category: "uncategorized",
      merchant: "0x0000000000000000000000000000000000000000",
      maxSupply: 100,
      mintedSupply: 1,
      redeemedSupply: 0,
      availableUnits: 0,
      basisValue: "0.00",
      lowestListingPrice: "N/A",
      royaltyBps: 0,
      metadataURI: "",
    })),
  ];

  return (
    <div className="app-container">
      <header className="app-header">
        <div>
          <h1 className="app-title">Restock Protocol</h1>
          <p style={{ margin: 0, opacity: 0.7 }}>Reference Client (Phase 4, Part 2)</p>
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

      {/* Navigation Tabs */}
      <div className="nav-tabs">
        <button
          className={`nav-tab ${activeTab === "catalog" ? "active" : ""}`}
          onClick={() => setActiveTab("catalog")}
        >
          Browse Catalog & Buy
        </button>
        <button
          className={`nav-tab ${activeTab === "portfolio" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("portfolio");
            if (address && provider) fetchSkus();
          }}
        >
          My Tokens & Portfolio {address && allHeldSkus.length > 0 && `(${allHeldSkus.length})`}
        </button>
      </div>

      {activeTab === "catalog" ? (
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
      ) : (
        /* PORTFOLIO TAB ("My Tokens") */
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", borderBottom: "2px solid var(--border)", paddingBottom: "8px" }}>
            <h2 style={{ margin: 0, fontSize: "20px" }}>My Held Claim Tokens</h2>
            {address && (
              <button
                className="btn-secondary"
                style={{ fontSize: "13px", padding: "6px 12px" }}
                onClick={() => fetchSkus()}
                disabled={loadingBalances}
              >
                {loadingBalances ? "Syncing..." : "↻ Refresh Balances"}
              </button>
            )}
          </div>

          {!address ? (
            <div className="tracker-card" style={{ textAlign: "center", padding: "40px" }}>
              <p>Please connect your browser wallet to view your held tokens.</p>
              <button className="btn-connect" onClick={connectWallet}>Connect Wallet</button>
            </div>
          ) : loadingBalances && Object.keys(myBalances).length === 0 ? (
            <p>Querying ClaimToken balances on-chain...</p>
          ) : allHeldSkus.length === 0 ? (
            <div className="tracker-card" style={{ padding: "40px", textAlign: "center" }}>
              <p style={{ fontSize: "16px", margin: "0 0 12px" }}>No Claim Tokens held by {truncateAddress(address)}.</p>
              <p style={{ opacity: 0.7, margin: 0 }}>Browse the catalog and complete a purchase to acquire Claim Tokens.</p>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "20px" }}>
              {allHeldSkus.map((sku) => {
                const bal = myBalances[Number(sku.skuId)] || 0;
                return (
                  <div key={sku.skuId} className="sku-card" style={{ cursor: "default" }}>
                    <div className="sku-header">
                      <h3 className="sku-name">{sku.name}</h3>
                      <span className="badge in-stock" style={{ fontSize: "14px", padding: "4px 8px" }}>
                        Held: {bal} unit(s)
                      </span>
                    </div>
                    <div className="sku-meta" style={{ marginBottom: "20px" }}>
                      <div>SKU ID: <strong>#{sku.skuId}</strong></div>
                      <div>Category: <strong>{sku.category}</strong></div>
                      <div>Variant: <strong>{sku.variant || "Default"}</strong></div>
                      <div>Merchant: <strong style={{ fontSize: "12px" }}>{truncateAddress(sku.merchant)}</strong></div>
                    </div>

                    <div style={{ display: "flex", gap: "12px" }}>
                      <button
                        className="btn-action"
                        style={{ flex: 1 }}
                        onClick={() => openListModal(sku)}
                      >
                        List for Sale
                      </button>
                      <button
                        className="btn-secondary"
                        style={{ flex: 1 }}
                        onClick={() => openRedeemModal(sku)}
                      >
                        Redeem Item
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* LISTING CREATION MODAL */}
      {showListModal && (
        <div className="modal-overlay" onClick={() => setShowListModal(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 16px", fontSize: "20px" }}>
              List {showListModal.name} for Sale
            </h3>

            {listingStep === "completed" ? (
              <div className="success-container">
                <p className="success-title">Listing Created Successfully!</p>
                <p>Listing ID <strong>#{createdListingId}</strong> is now live on-chain in the Marketplace.</p>
                <button
                  className="btn-action"
                  style={{ marginTop: "16px" }}
                  onClick={() => setShowListModal(null)}
                >
                  Done
                </button>
              </div>
            ) : (
              <div>
                <div className="form-group">
                  <label>Quantity to List (Max: {myBalances[showListModal.skuId] || 0}):</label>
                  <input
                    type="number"
                    min="1"
                    max={myBalances[showListModal.skuId] || 1}
                    className="form-input"
                    value={listQuantity}
                    onChange={(e) => setListQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                  />
                </div>

                <div className="form-group">
                  <label>Price Per Unit (USDC):</label>
                  <input
                    type="text"
                    className="form-input"
                    value={listPrice}
                    onChange={(e) => setListPrice(e.target.value)}
                  />
                </div>

                {checkingApproval ? (
                  <p>Checking Marketplace ERC-1155 approval status...</p>
                ) : !isApproved ? (
                  <div>
                    <div className="info-box">
                      <strong>Approval Needed:</strong> This lets the Marketplace transfer your tokens if your listing sells — required once per wallet, not per listing.
                    </div>
                    {listError && <div className="error-message">Error: {listError}</div>}
                    <div style={{ display: "flex", gap: "12px", marginTop: "20px" }}>
                      <button
                        className="btn-action"
                        disabled={listingStep === "approving"}
                        onClick={handleApproveMarketplace}
                      >
                        {listingStep === "approving" ? "Approving in Wallet..." : "Approve Marketplace"}
                      </button>
                      <button className="btn-secondary" onClick={() => setShowListModal(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <p style={{ color: "#10b981", fontSize: "14px", marginBottom: "16px" }}>
                      ✓ Marketplace approved for token transfers.
                    </p>
                    {listError && <div className="error-message">Error: {listError}</div>}
                    <div style={{ display: "flex", gap: "12px", marginTop: "20px" }}>
                      <button
                        className="btn-action"
                        disabled={listingStep === "submitting"}
                        onClick={handleCreateListing}
                      >
                        {listingStep === "submitting" ? "Submitting Transaction..." : "Create Listing"}
                      </button>
                      <button className="btn-secondary" onClick={() => setShowListModal(null)}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* REDEMPTION MODAL */}
      {showRedeemModal && (
        <div className="modal-overlay" onClick={() => setShowRedeemModal(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 16px", fontSize: "20px" }}>
              Redeem {showRedeemModal.name}
            </h3>

            {redeemStep === "completed" && redemptionResult ? (
              <div className="success-container">
                <p className="success-title">Redemption Recorded Successfully!</p>
                <p style={{ fontSize: "14px" }}>
                  Redemption ID: <strong>{redemptionResult.redemptionId}</strong>
                </p>
                <p style={{ fontSize: "14px" }}>
                  Fulfillment Status: <strong>{redemptionResult.fulfillmentStatus}</strong>
                </p>
                <div>
                  <a
                    href={getExplorerLink(redemptionResult.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="tx-hash-link"
                  >
                    View On-Chain Tx: {truncateAddress(redemptionResult.txHash)}
                  </a>
                </div>
                <button
                  className="btn-action"
                  style={{ marginTop: "16px" }}
                  onClick={() => setShowRedeemModal(null)}
                >
                  Done
                </button>
              </div>
            ) : (
              <div>
                <div className="form-group">
                  <label>Quantity to Redeem (Max: {myBalances[showRedeemModal.skuId] || 0}):</label>
                  <input
                    type="number"
                    min="1"
                    max={myBalances[showRedeemModal.skuId] || 1}
                    className="form-input"
                    value={redeemQuantity}
                    onChange={(e) => setRedeemQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                  />
                </div>

                <div className="form-group">
                  <label>Physical Shipping Address:</label>
                  <textarea
                    rows={3}
                    className="form-textarea"
                    value={shippingAddress}
                    onChange={(e) => setShippingAddress(e.target.value)}
                  />
                </div>

                <div className="steps-list" style={{ marginBottom: "20px" }}>
                  <div className={`step-item ${redeemStep === "hashing" ? "active" : redeemStep !== "idle" && redeemStep !== "failed" ? "completed" : ""}`}>
                    <span className="step-dot" />
                    <span>Computing canonical shipping reference...</span>
                    {redeemStep === "hashing" && <span className="spinner" />}
                  </div>
                  <div className={`step-item ${redeemStep === "redeeming_onchain" ? "active" : ["hashing"].includes(redeemStep) ? "" : redeemStep !== "idle" && redeemStep !== "failed" ? "completed" : ""}`}>
                    <span className="step-dot" />
                    <span>Redeeming ClaimToken on-chain...</span>
                    {redeemStep === "redeeming_onchain" && <span className="spinner" />}
                  </div>
                  <div className={`step-item ${redeemStep === "submitting_backend" ? "active" : ["hashing", "redeeming_onchain"].includes(redeemStep) ? "" : redeemStep === "completed" ? "completed" : ""}`}>
                    <span className="step-dot" />
                    <span>Verifying & recording redemption on backend...</span>
                    {redeemStep === "submitting_backend" && <span className="spinner" />}
                  </div>
                </div>

                {redeemError && <div className="error-message">Error: {redeemError}</div>}

                <div style={{ display: "flex", gap: "12px", marginTop: "20px" }}>
                  <button
                    className="btn-action"
                    disabled={redeemStep !== "idle" && redeemStep !== "failed"}
                    onClick={handleRedeem}
                  >
                    Submit Redemption
                  </button>
                  <button
                    className="btn-secondary"
                    disabled={redeemStep !== "idle" && redeemStep !== "failed" && redeemStep !== "completed"}
                    onClick={() => setShowRedeemModal(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
