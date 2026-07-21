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

export interface TxHistoryItem {
  id: string;
  timestamp: number;
  type: "payment" | "delivery" | "fulfillment" | "redemption" | "listing" | "approval";
  label: string;
  txHash: string;
  status: "success" | "pending" | "failed";
  skuId?: number;
  skuName?: string;
  quantity?: number;
  details?: string;
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

const INITIAL_HISTORY: TxHistoryItem[] = [
  {
    id: "tx-demo-1",
    timestamp: Math.floor(Date.now() / 1000) - 300,
    type: "payment",
    label: "EIP-3009 Payment Settlement (0.01 USDC)",
    txHash: "0x8bd66ba4878c1d9dad9e7bc730bfe25487b55cb53932d05bcafa21699d86e314",
    status: "success",
    skuId: 107,
    skuName: "Aura Max Sneakers",
    quantity: 1
  },
  {
    id: "tx-demo-2",
    timestamp: Math.floor(Date.now() / 1000) - 290,
    type: "delivery",
    label: "ClaimToken Mint & Delivery",
    txHash: "0x3cb478f1f566fbeba0c8881ad88811d0c9d6ea5818e0e9c0591904ae1ba7e1f8",
    status: "success",
    skuId: 107,
    skuName: "Aura Max Sneakers",
    quantity: 1
  },
  {
    id: "tx-demo-3",
    timestamp: Math.floor(Date.now() / 1000) - 120,
    type: "redemption",
    label: "Physical Item Burn & Redemption",
    txHash: "0x63e41fcd6d8c878e36c017da2706fdcc66079f39ada233e9e09d05037220238f",
    status: "success",
    skuId: 113,
    skuName: "Cyberpunk Hoodie",
    quantity: 1
  }
];

export default function App() {
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [signer, setSigner] = useState<ethers.JsonRpcSigner | null>(null);
  const [address, setAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [networkError, setNetworkError] = useState<string>("");

  const [activeTab, setActiveTab] = useState<"catalog" | "merchant" | "portfolio" | "history">("catalog");
  const [skus, setSkus] = useState<SKU[]>([]);
  const [loadingSkus, setLoadingSkus] = useState<boolean>(false);
  const [selectedSku, setSelectedSku] = useState<SKU | null>(null);
  const [myMerchantSkuIds, setMyMerchantSkuIds] = useState<string[]>([]);

  const [listings, setListings] = useState<Listing[]>([]);
  const [loadingListings, setLoadingListings] = useState<boolean>(false);

  // Transaction History
  const [txHistory, setTxHistory] = useState<TxHistoryItem[]>(() => {
    try {
      const saved = localStorage.getItem("restock_tx_history");
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return INITIAL_HISTORY;
  });

  const addTxToHistory = (item: TxHistoryItem) => {
    setTxHistory((prev) => {
      const updated = [item, ...prev.filter((i) => i.txHash.toLowerCase() !== item.txHash.toLowerCase())];
      try {
        localStorage.setItem("restock_tx_history", JSON.stringify(updated));
      } catch (e) {}
      return updated;
    });
  };

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

  const fetchMyMerchantSkus = async () => {
    if (!demoMerchantApiKey) return;
    try {
      const headers: Record<string, string> = {};
      if (demoMerchantApiKey) {
        headers["Authorization"] = `Bearer ${demoMerchantApiKey}`;
      }
      const res = await fetch("/api/merchant/skus", { headers });
      if (res.ok) {
        const data = await res.json();
        setMyMerchantSkuIds(data.skuIds || []);
      }
    } catch (err) {
      console.error("Error fetching merchant owned SKUs:", err);
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

      const candidateIds = new Set<number>(listToQuery.map((s) => Number(s.skuId)));
      for (let i = 1; i <= 60; i++) candidateIds.add(i);

      const idArray = Array.from(candidateIds).sort((a, b) => a - b);
      const accountsArray = idArray.map(() => address);

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

  useEffect(() => {
    if ((activeTab === "portfolio" || activeTab === "merchant") && address && provider) {
      fetchSkus(true);
    }
  }, [activeTab, address, provider]);

  useEffect(() => {
    if (activeTab === "merchant") {
      fetchMyMerchantSkus();
    }
  }, [activeTab, demoMerchantApiKey]);

  // Connect browser wallet with automatic Base Sepolia network switch prompt
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
      const receipt = await tx.wait();
      setIsApproved(true);
      setListingStep("idle");

      addTxToHistory({
        id: `app-${Date.now()}`,
        timestamp: Math.floor(Date.now() / 1000),
        type: "approval",
        label: "Marketplace Contract Approval",
        txHash: receipt.hash,
        status: "success"
      });
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
        throw new Error(data.error ? `${data.error}${data.message ? `: ${data.message}` : ''}` : "Listing creation failed");
      }

      setCreatedListingId(data.listingId ? String(data.listingId) : "Created");
      setListingStep("completed");

      if (data.txHash) {
        addTxToHistory({
          id: `list-${Date.now()}`,
          timestamp: Math.floor(Date.now() / 1000),
          type: "listing",
          label: "Merchant Listing Creation",
          txHash: data.txHash,
          status: "success",
          skuId: showListModal.skuId,
          skuName: showListModal.name,
          quantity: listQuantity,
          details: `${listPrice} USDC`
        });
      }

      fetchSkus();
      if (selectedSku) fetchListings(selectedSku.skuId);
      fetchMyBalances();
    } catch (err: any) {
      console.error(err);
      setListError(err.message || String(err));
      setListingStep("failed");
    }
  };

  // Catalog Filter state
  const [stockFilter, setStockFilter] = useState<"all" | "in_stock" | "out_of_stock">("all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Direct SKU creation state (Merchant tab)
  const [newSkuName, setNewSkuName] = useState<string>("");
  const [newSkuCategory, setNewSkuCategory] = useState<string>("sneakers");
  const [newSkuVariant, setNewSkuVariant] = useState<string>("V1");
  const [newSkuMaxSupply, setNewSkuMaxSupply] = useState<number>(100);
  const [newSkuBasisValue, setNewSkuBasisValue] = useState<string>("10.00");
  const [newSkuRoyaltyBps, setNewSkuRoyaltyBps] = useState<number>(250);
  const [newSkuMetadataURI, setNewSkuMetadataURI] = useState<string>("");
  const [merchantFilter, setMerchantFilter] = useState<"my_wallet" | "all">("my_wallet");
  const [skuCreateStatus, setSkuCreateStatus] = useState<string>("");

  // Create SKU via POST /merchant/skus
  const handleCreateSku = async () => {
    if (!newSkuName.trim()) return alert("Please enter a SKU name");
    setSkuCreateStatus("Submitting SKU to merchant portal...");
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (demoMerchantApiKey) {
        headers["Authorization"] = `Bearer ${demoMerchantApiKey}`;
      }
      const res = await fetch("/api/merchant/skus", {
        method: "POST",
        headers,
        body: JSON.stringify({
          maxSupply: Number(newSkuMaxSupply),
          royaltyBps: Number(newSkuRoyaltyBps),
          initialBasisValue: newSkuBasisValue,
          metadataURI: newSkuMetadataURI.trim() || `ipfs://bafkreid${Date.now()}/${encodeURIComponent(newSkuName.toLowerCase().replace(/\s+/g, '-'))}.json`,
          name: newSkuName.trim(),
          category: newSkuCategory.trim(),
          variant: newSkuVariant.trim()
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ? `${data.error}${data.message ? `: ${data.message}` : ''}` : "SKU creation failed");

      setSkuCreateStatus(`Success! Created SKU ID #${data.skuId || data.request?.id || data.id || 'Pending Approval'}`);
      setNewSkuName("");
      fetchSkus();
      fetchMyMerchantSkus();
    } catch (err: any) {
      console.error(err);
      setSkuCreateStatus(`Error: ${err.message || String(err)}`);
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
      const shippingRef = await canonicalizeAndHashAddress(shippingAddress);

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

      addTxToHistory({
        id: `red-${Date.now()}`,
        timestamp: Math.floor(Date.now() / 1000),
        type: "redemption",
        label: "Physical Item Burn & Redemption",
        txHash: receipt.hash,
        status: "success",
        skuId: showRedeemModal.skuId,
        skuName: showRedeemModal.name,
        quantity: redeemQuantity
      });

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

      if (result.paymentTxHash) {
        addTxToHistory({
          id: `pay-${Date.now()}`,
          timestamp: Math.floor(Date.now() / 1000),
          type: "payment",
          label: `EIP-3009 Payment Settlement (${listing.price} USDC)`,
          txHash: result.paymentTxHash,
          status: "success",
          skuId: selectedSku?.skuId,
          skuName: selectedSku?.name,
          quantity: 1
        });
      }
      if (result.deliveryTxHash) {
        addTxToHistory({
          id: `del-${Date.now()}`,
          timestamp: Math.floor(Date.now() / 1000),
          type: "delivery",
          label: "ClaimToken Mint & Delivery",
          txHash: result.deliveryTxHash,
          status: "success",
          skuId: selectedSku?.skuId,
          skuName: selectedSku?.name,
          quantity: 1
        });
      }

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
      metadataURI: ""
    }))
  ];

  return (
    <div className="app-container">
      {/* Top Header Navigation Bar */}
      <header className="app-header">
        <div className="brand-wrapper">
          <div className="brand-logo">R</div>
          <div>
            <h1 className="app-title">Restock Protocol</h1>
            <div className="app-subtitle">Backend-Mediated RWA Tokenization</div>
          </div>
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

      {/* Main Navigation Tabs */}
      <div className="nav-tabs">
        <button
          className={`nav-tab ${activeTab === "catalog" ? "active" : ""}`}
          onClick={() => setActiveTab("catalog")}
        >
          <span>🛒 Browse Catalog & Buy</span>
        </button>
        <button
          className={`nav-tab ${activeTab === "merchant" ? "active" : ""}`}
          onClick={() => setActiveTab("merchant")}
        >
          <span>🏬 Merchant Studio</span>
        </button>
        <button
          className={`nav-tab ${activeTab === "portfolio" ? "active" : ""}`}
          onClick={() => setActiveTab("portfolio")}
        >
          <span>🎒 My Claim Tokens</span>
          {address && allHeldSkus.length > 0 && (
            <span className="tab-badge">{allHeldSkus.length}</span>
          )}
        </button>
        <button
          className={`nav-tab ${activeTab === "history" ? "active" : ""}`}
          onClick={() => setActiveTab("history")}
        >
          <span>📜 Tx History</span>
          <span className="tab-badge">{txHistory.length}</span>
        </button>
      </div>

      {/* TAB 1: BROWSE CATALOG & BUY */}
      {activeTab === "catalog" && (
        <main className="main-grid">
          <div>
            <div className="section-title">
              <span>Tokenized Inventory</span>
              <button className="btn-secondary" style={{ fontSize: "12px", padding: "4px 10px" }} onClick={() => fetchSkus()}>
                ↻ Refresh
              </button>
            </div>

            {/* Stock & Search Filter Bar */}
            <div style={{ display: "flex", gap: "12px", marginBottom: "20px", flexWrap: "wrap", alignItems: "center" }}>
              <input
                type="text"
                className="form-input"
                style={{ flex: 1, minWidth: "200px", padding: "8px 12px", fontSize: "14px" }}
                placeholder="🔍 Search SKU name or category..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <div style={{ display: "flex", gap: "4px", background: "var(--bg-card)", padding: "4px", borderRadius: "10px", border: "1px solid var(--border)" }}>
                <button
                  className="btn-secondary"
                  style={{ fontSize: "12px", padding: "6px 12px", background: stockFilter === "all" ? "var(--accent-purple)" : "transparent", color: stockFilter === "all" ? "white" : "var(--text-secondary)", borderColor: "transparent" }}
                  onClick={() => setStockFilter("all")}
                >
                  All SKUs ({skus.length})
                </button>
                <button
                  className="btn-secondary"
                  style={{ fontSize: "12px", padding: "6px 12px", background: stockFilter === "in_stock" ? "var(--accent-emerald)" : "transparent", color: stockFilter === "in_stock" ? "white" : "var(--text-secondary)", borderColor: "transparent" }}
                  onClick={() => setStockFilter("in_stock")}
                >
                  In Stock ({skus.filter(s => s.availableUnits > 0).length})
                </button>
                <button
                  className="btn-secondary"
                  style={{ fontSize: "12px", padding: "6px 12px", background: stockFilter === "out_of_stock" ? "#f43f5e" : "transparent", color: stockFilter === "out_of_stock" ? "white" : "var(--text-secondary)", borderColor: "transparent" }}
                  onClick={() => setStockFilter("out_of_stock")}
                >
                  Out of Stock ({skus.filter(s => s.availableUnits === 0).length})
                </button>
              </div>
            </div>

            {loadingSkus ? (
              <p style={{ color: "var(--text-muted)", padding: "20px 0" }}>Loading catalog...</p>
            ) : skus.length === 0 ? (
              <p style={{ color: "var(--text-muted)", padding: "20px 0" }}>No tokenized SKUs found in registry.</p>
            ) : (
              <div className="sku-list">
                {skus
                  .filter((sku) => {
                    const matchesSearch = sku.name.toLowerCase().includes(searchQuery.toLowerCase()) || sku.category.toLowerCase().includes(searchQuery.toLowerCase());
                    if (!matchesSearch) return false;
                    if (stockFilter === "in_stock") return sku.availableUnits > 0;
                    if (stockFilter === "out_of_stock") return sku.availableUnits === 0;
                    return true;
                  })
                  .map((sku) => (
                    <div
                      key={sku.skuId}
                      className={`sku-card ${selectedSku?.skuId === sku.skuId ? "selected" : ""}`}
                      onClick={() => setSelectedSku(sku)}
                    >
                      <span className="sku-card-tag">{sku.category}</span>
                      <div className="sku-header">
                        <h3 className="sku-name">{sku.name}</h3>
                        <span className="sku-price">
                          {sku.lowestListingPrice ? `${sku.lowestListingPrice} USDC` : "Unlisted"}
                        </span>
                      </div>
                      <div className="sku-meta">
                        <div className="meta-row">
                          <span>Variant: <strong>{sku.variant || "Default"}</strong></span>
                          <span className={`badge ${sku.availableUnits > 0 ? "in-stock" : "out-of-stock"}`}>
                            {sku.availableUnits > 0 ? `${sku.availableUnits} in stock` : "Out of stock"}
                          </span>
                        </div>
                        <div className="meta-row">
                          <span>Merchant: <strong style={{ fontFamily: "var(--font-mono)", fontSize: "11px" }}>{truncateAddress(sku.merchant)}</strong></span>
                          <span>Royalty: <strong>{sku.royaltyBps} bps</strong></span>
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            )}

            {selectedSku && (
              <div className="listings-container">
                <h3 className="section-title" style={{ fontSize: "16px" }}>
                  Active Marketplace Listings for {selectedSku.name}
                </h3>
                {loadingListings ? (
                  <p style={{ color: "var(--text-muted)" }}>Loading listings...</p>
                ) : listings.length === 0 ? (
                  <p style={{ color: "var(--text-muted)" }}>No active seller listings found for this SKU.</p>
                ) : (
                  <div>
                    {listings.map((l) => (
                      <div key={l.listingId} className="listing-row">
                        <div className="listing-info">
                          <span className="seller-address">Seller: {truncateAddress(l.seller)}</span>
                          <span style={{ fontSize: "14px", color: "var(--text-primary)" }}>
                            Qty: <strong>{l.quantity}</strong> | Price: <strong style={{ color: "#34d399" }}>{l.price} USDC</strong>
                          </span>
                        </div>
                        <button
                          className="btn-buy"
                          disabled={l.quantity === 0 || l.status !== "Open" || (buyStep !== "idle" && buyStep !== "completed" && buyStep !== "failed")}
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

          {/* Checkout & Pipeline Status Tracker */}
          <div>
            <h2 className="section-title">Checkout Pipeline</h2>
            <div className="tracker-card">
              {buyStep === "idle" ? (
                <p style={{ color: "var(--text-muted)", textAlign: "center", padding: "30px 0" }}>
                  Select an active SKU listing and click "Buy" to initiate payment.
                </p>
              ) : (
                <div>
                  {reservationId && (
                    <div style={{ marginBottom: "16px", fontSize: "13px", color: "var(--text-secondary)" }}>
                      Reservation ID: <strong style={{ fontFamily: "var(--font-mono)" }}>#{reservationId}</strong>
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
                      <span>Settling x402 payment & delivering ClaimToken...</span>
                      {buyStep === "settling" && <span className="spinner" />}
                    </div>

                    <div className={`step-item ${buyStep === "polling_balance" ? "active" : buyStep === "completed" ? "completed" : ""}`}>
                      <span className="step-dot" />
                      <span>Verifying ClaimToken balance on Base Sepolia...</span>
                      {buyStep === "polling_balance" && <span className="spinner" />}
                    </div>
                  </div>

                  {buyError && <div style={{ color: "#fb7185", background: "rgba(244, 63, 94, 0.1)", padding: "12px", borderRadius: "8px", marginTop: "16px", fontSize: "13px" }}>Error: {buyError}</div>}

                  {txHashes && (
                    <div style={{ marginTop: "20px", display: "flex", flexDirection: "column", gap: "8px" }}>
                      <div style={{ fontSize: "12px", fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)" }}>Broadcast Explorer Links</div>
                      {txHashes.payment && (
                        <a href={getExplorerLink(txHashes.payment)} target="_blank" rel="noreferrer" className="basescan-link">
                          🔗 EIP-3009 Payment Tx ↗
                        </a>
                      )}
                      {txHashes.delivery && (
                        <a href={getExplorerLink(txHashes.delivery)} target="_blank" rel="noreferrer" className="basescan-link">
                          🔗 ClaimToken Delivery Tx ↗
                        </a>
                      )}
                    </div>
                  )}

                  {buyStep === "completed" && claimTokenBalance && (
                    <div style={{ background: "rgba(16, 185, 129, 0.1)", border: "1px solid rgba(16, 185, 129, 0.25)", padding: "16px", borderRadius: "12px", marginTop: "20px", textAlign: "center" }}>
                      <div style={{ color: "#34d399", fontWeight: 800, fontSize: "16px", marginBottom: "4px" }}>Purchase Successful!</div>
                      <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>Claim Tokens are now held in your browser wallet.</div>
                      <div style={{ background: "var(--bg-dark)", padding: "10px", borderRadius: "8px", marginTop: "12px", fontSize: "14px", fontWeight: "700" }}>
                        SKU #{selectedSku?.skuId} Balance: {claimTokenBalance} unit(s)
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </main>
      )}

      {/* TAB 2: MERCHANT STUDIO */}
      {activeTab === "merchant" && (
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: "24px" }}>
          <div className="tracker-card">
            <h2 className="section-title">Create New Tokenized SKU</h2>
            <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "20px" }}>
              Mediated through <code>POST /merchant/skus</code> with Trust-Tier enforcement.
            </div>

            <div className="form-group">
              <label>SKU Title / Name</label>
              <input type="text" className="form-input" placeholder="e.g. Rare Vintage Jacket" value={newSkuName} onChange={(e) => setNewSkuName(e.target.value)} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <div className="form-group">
                <label>Category</label>
                <input type="text" className="form-input" value={newSkuCategory} onChange={(e) => setNewSkuCategory(e.target.value)} />
              </div>
              <div className="form-group">
                <label>Variant / Edition</label>
                <input type="text" className="form-input" value={newSkuVariant} onChange={(e) => setNewSkuVariant(e.target.value)} />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px" }}>
              <div className="form-group">
                <label>Max Supply</label>
                <input type="number" className="form-input" value={newSkuMaxSupply} onChange={(e) => setNewSkuMaxSupply(Number(e.target.value))} />
              </div>
              <div className="form-group">
                <label>Basis Value ($)</label>
                <input type="text" className="form-input" value={newSkuBasisValue} onChange={(e) => setNewSkuBasisValue(e.target.value)} />
              </div>
              <div className="form-group">
                <label>Royalty (bps)</label>
                <input type="number" className="form-input" value={newSkuRoyaltyBps} onChange={(e) => setNewSkuRoyaltyBps(Number(e.target.value))} />
              </div>
            </div>

            <div className="form-group">
              <label>Metadata URI</label>
              <input type="text" className="form-input" value={newSkuMetadataURI} onChange={(e) => setNewSkuMetadataURI(e.target.value)} placeholder="https://api.restock.protocol/metadata/item.json" />
            </div>

            <button className="btn-action" style={{ width: "100%", padding: "12px", marginTop: "8px" }} onClick={handleCreateSku}>
              Register SKU
            </button>

            {skuCreateStatus && (
              <div style={{ marginTop: "16px", padding: "12px", borderRadius: "8px", background: "var(--bg-dark)", border: "1px solid var(--border)", fontSize: "13px" }}>
                {skuCreateStatus}
              </div>
            )}
          </div>

          <div className="tracker-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h2 className="section-title" style={{ margin: 0 }}>Merchant Inventory</h2>
              <div style={{ display: "flex", gap: "4px", background: "var(--bg-dark)", padding: "3px", borderRadius: "8px", border: "1px solid var(--border)" }}>
                <button
                  className="btn-secondary"
                  style={{ fontSize: "11px", padding: "4px 8px", background: merchantFilter === "my_wallet" ? "var(--accent-purple)" : "transparent", color: merchantFilter === "my_wallet" ? "white" : "var(--text-secondary)", borderColor: "transparent" }}
                  onClick={() => setMerchantFilter("my_wallet")}
                >
                  My Wallet
                </button>
                <button
                  className="btn-secondary"
                  style={{ fontSize: "11px", padding: "4px 8px", background: merchantFilter === "all" ? "var(--accent-purple)" : "transparent", color: merchantFilter === "all" ? "white" : "var(--text-secondary)", borderColor: "transparent" }}
                  onClick={() => setMerchantFilter("all")}
                >
                  All Merchants
                </button>
              </div>
            </div>

            {(() => {
              const displayedMerchantSkus = skus.filter((sku) => {
                if (merchantFilter === "my_wallet") {
                  const isOwnedOnChain = address && sku.merchant.toLowerCase() === address.toLowerCase();
                  const isOwnedInDb = myMerchantSkuIds.includes(String(sku.skuId));
                  return isOwnedOnChain || isOwnedInDb;
                }
                return true;
              });

              if (displayedMerchantSkus.length === 0) {
                return (
                  <div style={{ textAlign: "center", padding: "30px 10px", color: "var(--text-muted)", fontSize: "13px" }}>
                    {merchantFilter === "my_wallet" && address ? (
                      <div>
                        No SKUs found for merchant wallet <code>{truncateAddress(address)}</code>.
                        <div style={{ marginTop: "10px" }}>
                          <button className="btn-secondary" style={{ fontSize: "12px" }} onClick={() => setMerchantFilter("all")}>
                            Show All Merchant SKUs ({skus.length})
                          </button>
                        </div>
                      </div>
                    ) : (
                      "No registered SKUs found."
                    )}
                  </div>
                );
              }

              return (
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  {displayedMerchantSkus.map((sku) => (
                    <div key={sku.skuId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px", background: "var(--bg-dark)", borderRadius: "10px", border: "1px solid var(--border)" }}>
                      <div>
                        <div style={{ fontWeight: "700" }}>{sku.name} <span style={{ fontSize: "11px", opacity: 0.7 }}>(#{sku.skuId})</span></div>
                        <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Stock: {sku.availableUnits} / {sku.maxSupply} | Price: {sku.lowestListingPrice || "N/A"} USDC</div>
                      </div>
                      <button className="btn-secondary" style={{ fontSize: "12px", padding: "6px 12px" }} onClick={() => openListModal(sku)}>
                        + List Item
                      </button>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* TAB 3: PORTFOLIO & MY TOKENS */}
      {activeTab === "portfolio" && (
        <div>
          <div className="history-header">
            <h2 className="section-title" style={{ margin: 0 }}>My Held Claim Tokens</h2>
            <button className="btn-secondary" onClick={() => fetchSkus()} disabled={loadingBalances}>
              {loadingBalances ? "Syncing..." : "↻ Refresh Balances"}
            </button>
          </div>

          {!address ? (
            <div className="tracker-card" style={{ textAlign: "center", padding: "40px" }}>
              <p style={{ color: "var(--text-secondary)", marginBottom: "16px" }}>Please connect your browser wallet to view your held tokens.</p>
              <button className="btn-connect" onClick={connectWallet}>Connect Wallet</button>
            </div>
          ) : allHeldSkus.length === 0 ? (
            <div className="tracker-card" style={{ padding: "40px", textAlign: "center" }}>
              <p style={{ fontSize: "16px", margin: "0 0 12px", color: "var(--text-primary)" }}>No Claim Tokens held by {truncateAddress(address)}.</p>
              <p style={{ color: "var(--text-muted)", margin: 0 }}>Browse the catalog and complete a purchase to acquire Claim Tokens.</p>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "20px" }}>
              {allHeldSkus.map((sku) => {
                const bal = myBalances[Number(sku.skuId)] || 0;
                return (
                  <div key={sku.skuId} className="sku-card" style={{ cursor: "default" }}>
                    <div className="sku-header">
                      <h3 className="sku-name">{sku.name}</h3>
                      <span className="badge in-stock">Held: {bal} unit(s)</span>
                    </div>
                    <div className="sku-meta" style={{ marginBottom: "16px" }}>
                      <div className="meta-row"><span>SKU ID:</span> <strong>#{sku.skuId}</strong></div>
                      <div className="meta-row"><span>Category:</span> <strong>{sku.category}</strong></div>
                      <div className="meta-row"><span>Variant:</span> <strong>{sku.variant || "Default"}</strong></div>
                    </div>

                    <div style={{ display: "flex", gap: "10px" }}>
                      <button className="btn-action" style={{ flex: 1 }} onClick={() => openListModal(sku)}>
                        List for Sale
                      </button>
                      <button className="btn-secondary" style={{ flex: 1 }} onClick={() => openRedeemModal(sku)}>
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

      {/* TAB 4: TRANSACTION HISTORY & ACTIVITY LOG */}
      {activeTab === "history" && (
        <div className="history-container">
          <div className="history-header">
            <div>
              <h2 className="section-title" style={{ margin: 0 }}>On-Chain Transaction History</h2>
              <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "4px" }}>
                Inspect live EIP-3009 payment settlements, claim token deliveries, and redemptions on BaseScan.
              </div>
            </div>
            <button className="btn-secondary" style={{ fontSize: "12px", padding: "6px 12px" }} onClick={() => { localStorage.removeItem("restock_tx_history"); setTxHistory(INITIAL_HISTORY); }}>
              Reset History
            </button>
          </div>

          <div className="history-list">
            {txHistory.map((tx) => (
              <div key={tx.id} className="history-item">
                <div className="history-item-left">
                  <div className={`history-type-icon ${tx.type}`}>
                    {tx.type === "payment" ? "💳" : tx.type === "delivery" ? "🎁" : tx.type === "redemption" ? "🔥" : tx.type === "listing" ? "🏪" : "⚙️"}
                  </div>
                  <div>
                    <div className="history-title">{tx.label}</div>
                    <div className="history-meta">
                      {tx.skuName && <span>SKU: {tx.skuName} (#{tx.skuId})</span>}
                      <span>Qty: {tx.quantity || 1}</span>
                      <span>{new Date(tx.timestamp * 1000).toLocaleTimeString()}</span>
                    </div>
                  </div>
                </div>

                <div className="history-item-right">
                  <a href={getExplorerLink(tx.txHash)} target="_blank" rel="noreferrer" className="basescan-link">
                    BaseScan Tx ↗
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* LISTING CREATION MODAL */}
      {showListModal && (
        <div className="modal-overlay" onClick={() => setShowListModal(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 16px", fontSize: "18px" }}>
              List {showListModal.name} for Sale
            </h3>

            {listingStep === "completed" ? (
              <div style={{ textAlign: "center", padding: "20px 0" }}>
                <div style={{ color: "#34d399", fontWeight: "800", fontSize: "18px", marginBottom: "8px" }}>Listing Created!</div>
                <div style={{ fontSize: "14px", color: "var(--text-secondary)" }}>Listing ID: #{createdListingId}</div>
                <button className="btn-action" style={{ marginTop: "20px" }} onClick={() => setShowListModal(null)}>
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
                  <p style={{ color: "var(--text-muted)" }}>Checking Marketplace ERC-1155 approval status...</p>
                ) : !isApproved ? (
                  <div>
                    <div style={{ background: "rgba(59, 130, 246, 0.1)", border: "1px solid rgba(59, 130, 246, 0.25)", color: "#60a5fa", padding: "12px", borderRadius: "10px", fontSize: "13px", marginBottom: "16px" }}>
                      <strong>Approval Needed:</strong> Approves the Marketplace contract to transfer your tokens when sold.
                    </div>
                    {listError && <div style={{ color: "#fb7185", marginBottom: "12px", fontSize: "13px" }}>Error: {listError}</div>}
                    <div style={{ display: "flex", gap: "12px" }}>
                      <button className="btn-action" disabled={listingStep === "approving"} onClick={handleApproveMarketplace}>
                        {listingStep === "approving" ? "Approving in Wallet..." : "Approve Marketplace"}
                      </button>
                      <button className="btn-secondary" onClick={() => setShowListModal(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <p style={{ color: "#34d399", fontSize: "13px", marginBottom: "16px" }}>
                      ✓ Marketplace approved for token transfers.
                    </p>
                    {listError && <div style={{ color: "#fb7185", marginBottom: "12px", fontSize: "13px" }}>Error: {listError}</div>}
                    <div style={{ display: "flex", gap: "12px" }}>
                      <button className="btn-action" disabled={listingStep === "submitting"} onClick={handleCreateListing}>
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
            <h3 style={{ margin: "0 0 16px", fontSize: "18px" }}>
              Redeem {showRedeemModal.name}
            </h3>

            {redeemStep === "completed" && redemptionResult ? (
              <div style={{ textAlign: "center", padding: "20px 0" }}>
                <div style={{ color: "#34d399", fontWeight: "800", fontSize: "18px", marginBottom: "8px" }}>Redemption Submitted!</div>
                <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "4px" }}>
                  Redemption ID: <strong>{redemptionResult.redemptionId}</strong>
                </div>
                <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "16px" }}>
                  Fulfillment Status: <strong>{redemptionResult.fulfillmentStatus}</strong>
                </div>
                <a href={getExplorerLink(redemptionResult.txHash)} target="_blank" rel="noreferrer" className="basescan-link" style={{ display: "inline-flex", justifyContent: "center" }}>
                  View On-Chain Tx on BaseScan ↗
                </a>
                <div style={{ marginTop: "20px" }}>
                  <button className="btn-action" onClick={() => setShowRedeemModal(null)}>Done</button>
                </div>
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

                {redeemError && <div style={{ color: "#fb7185", marginBottom: "12px", fontSize: "13px" }}>Error: {redeemError}</div>}

                <div style={{ display: "flex", gap: "12px" }}>
                  <button className="btn-action" disabled={redeemStep !== "idle" && redeemStep !== "failed"} onClick={handleRedeem}>
                    Submit Redemption
                  </button>
                  <button className="btn-secondary" disabled={redeemStep !== "idle" && redeemStep !== "failed" && redeemStep !== "completed"} onClick={() => setShowRedeemModal(null)}>
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
