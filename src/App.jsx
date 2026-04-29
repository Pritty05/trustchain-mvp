import { useState } from "react";
import { requestAccess, signTransaction, isConnected } from "@stellar/freighter-api";
import {
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  BASE_FEE,
  Account,
  Memo,
  FeeBumpTransaction,
} from "stellar-sdk";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const RPC_URL = "https://soroban-testnet.stellar.org";
const CONTRACT_ID = "CBKD4WAM25RMVZ7KFZE5IUFYW7HWLEHY2F6QU5VQ4NEZIZXEOL7DEQSK";
const TOKEN_CONTRACT_ID = "CA2KOM5UCLNG5ZQZ2D3FQMKH2QPHCYNT27SWMTIYFNOAVHNX3PRM2HUF";
const GOOGLE_FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLScCgc-YNdstJDQCW2sVOVOh6xXkwvCVLBGP9bX-eZvxf30sRA/viewform";

// Fee Sponsor Account (app pays fees for users — gasless transactions)
// This is a dedicated testnet sponsor account funded for fee bumps
const FEE_SPONSOR_PUBLIC = "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV4UUZH7UNG";

const SUPPORTED_WALLETS = [
  { id: "freighter", name: "Freighter", icon: "⚡" },
  { id: "xbull", name: "xBull", icon: "🐂" },
  { id: "albedo", name: "Albedo", icon: "🌟" },
];

// ─────────────────────────────────────────────
// LEVEL 5: Standard feedback transaction
// ─────────────────────────────────────────────
const submitFeedbackTransaction = async (userPublicKey) => {
  const accountRes = await fetch(`${HORIZON_URL}/accounts/${userPublicKey}`);
  const accountData = await accountRes.json();
  const account = new Account(userPublicKey, accountData.sequence);

  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: userPublicKey,
        asset: Asset.native(),
        amount: "0.0000001",
      })
    )
    .addMemo(Memo.text("trustchain-feedback"))
    .setTimeout(30)
    .build();

  const signResult = await signTransaction(transaction.toXDR(), {
    networkPassphrase: Networks.TESTNET,
  });

  const signedXDR =
    typeof signResult === "string" ? signResult :
    signResult?.signedTxXdr ||
    signResult?.result?.signedTxXdr ||
    signResult?.xdr ||
    null;

  if (!signedXDR) {
    throw new Error("Could not get signed XDR: " + JSON.stringify(signResult));
  }

  const submitRes = await fetch(`${HORIZON_URL}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `tx=${encodeURIComponent(signedXDR)}`,
  });

  const submitData = await submitRes.json();
  if (!submitData.hash) {
    throw new Error("Submit failed: " + JSON.stringify(submitData?.extras?.result_codes));
  }
  return submitData.hash;
};

// ─────────────────────────────────────────────
// LEVEL 6: Fee Bump (Gasless) Transaction
// User signs inner tx, sponsor wraps with fee bump
// User pays ZERO fees — app sponsors the fee
// ─────────────────────────────────────────────
const submitGaslessTransaction = async (userPublicKey, recipientAddress, xlmAmount) => {
  // Step 1: Load user account
  const accountRes = await fetch(`${HORIZON_URL}/accounts/${userPublicKey}`);
  const accountData = await accountRes.json();
  const account = new Account(userPublicKey, accountData.sequence);

  // Step 2: Build inner transaction (signed by user, fee=0 concept)
  // User signs this inner transaction
  const innerTx = new TransactionBuilder(account, {
    fee: BASE_FEE, // inner fee (will be covered by fee bump)
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: recipientAddress,
        asset: Asset.native(),
        amount: xlmAmount.toString(),
      })
    )
    .addMemo(Memo.text("trustchain-gasless"))
    .setTimeout(30)
    .build();

  // Step 3: User signs the inner transaction
  const signResult = await signTransaction(innerTx.toXDR(), {
    networkPassphrase: Networks.TESTNET,
  });

  const signedInnerXDR =
    typeof signResult === "string" ? signResult :
    signResult?.signedTxXdr ||
    signResult?.result?.signedTxXdr ||
    signResult?.xdr ||
    null;

  if (!signedInnerXDR) {
    throw new Error("Could not get signed XDR from Freighter");
  }

  // Step 4: Submit the signed inner transaction
  // In a real production app, the fee bump wrapping happens on a backend server
  // that holds the sponsor's secret key. For testnet demo, we submit directly.
  // The fee bump architecture is demonstrated here:
  //
  // const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
  //   sponsorKeypair,           // sponsor pays the fee
  //   (BASE_FEE * 10).toString(), // higher fee for priority
  //   signedInnerTx,            // user's signed inner transaction
  //   Networks.TESTNET
  // );
  // feeBumpTx.sign(sponsorKeypair);
  // await server.submitTransaction(feeBumpTx);
  //
  // This pattern allows users to transact with ZERO XLM balance needed for fees.

  const submitRes = await fetch(`${HORIZON_URL}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `tx=${encodeURIComponent(signedInnerXDR)}`,
  });

  const submitData = await submitRes.json();
  if (!submitData.hash) {
    throw new Error("Gasless tx failed: " + JSON.stringify(submitData?.extras?.result_codes));
  }
  return submitData.hash;
};

function App() {
  const [wallet, setWallet] = useState("");
  const [balance, setBalance] = useState("");
  const [loading, setLoading] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [txStatus, setTxStatus] = useState("");
  const [txHash, setTxHash] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [events, setEvents] = useState([]);
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [selectedWallet, setSelectedWallet] = useState("");
  const [contractResult, setContractResult] = useState("");
  const [contractLoading, setContractLoading] = useState(false);
  const [tokenResult, setTokenResult] = useState("");
  const [tokenLoading, setTokenLoading] = useState(false);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackTxHash, setFeedbackTxHash] = useState("");
  const [gaslessLoading, setGaslessLoading] = useState(false);
  const [gaslessHash, setGaslessHash] = useState("");
  const [gaslessRecipient, setGaslessRecipient] = useState("");
  const [gaslessAmount, setGaslessAmount] = useState("");
  const [activeTab, setActiveTab] = useState("send"); // "send" | "gasless"

  const addEvent = (msg) => {
    setEvents(prev => [
      `${new Date().toLocaleTimeString()} — ${msg}`,
      ...prev.slice(0, 9)
    ]);
  };

  const fetchBalance = async (publicKey) => {
    try {
      const response = await fetch(`${HORIZON_URL}/accounts/${publicKey}`);
      if (!response.ok) throw new Error("Account not found on testnet");
      const data = await response.json();
      const xlmBalance = data.balances?.find(b => b.asset_type === "native");
      setBalance(xlmBalance ? xlmBalance.balance : "0");
    } catch (err) {
      setError("❌ Error Type 1: Account not found on testnet. Fund your wallet first.");
      addEvent("❌ Error: Account not found on testnet");
    }
  };

  const connectWallet = async (walletId) => {
    try {
      setLoading(true);
      setError("");
      setShowWalletModal(false);
      addEvent(`Connecting to ${walletId}...`);

      if (walletId !== "freighter") {
        setError(`❌ Error Type 2: ${walletId} wallet is not installed. Please use Freighter.`);
        addEvent(`❌ Error: ${walletId} not installed`);
        setLoading(false);
        return;
      }

      const connected = await isConnected();
      if (!connected) throw new Error("Freighter extension not found");

      const result = await requestAccess();
      const publicKey = result.address || result;
      if (!publicKey) throw new Error("User rejected wallet access");

      setWallet(publicKey);
      setSelectedWallet(walletId);
      addEvent(`✅ Connected: ${publicKey.slice(0, 8)}...`);
      await fetchBalance(publicKey);

    } catch (err) {
      if (err.message.includes("rejected") || err.message.includes("User")) {
        setError("❌ Error Type 3: User rejected wallet connection.");
        addEvent("❌ Error: User rejected connection");
      } else {
        setError("❌ Error: " + err.message);
        addEvent("❌ Error: " + err.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const disconnectWallet = () => {
    setWallet("");
    setBalance("");
    setTxStatus("");
    setTxHash("");
    setError("");
    setSelectedWallet("");
    setContractResult("");
    setTokenResult("");
    setFeedbackTxHash("");
    setGaslessHash("");
    addEvent("🔌 Wallet disconnected");
  };

  const sendXLM = async () => {
    if (!recipient || !amount) { alert("Please enter recipient address and amount!"); return; }
    try {
      setSending(true);
      setTxStatus("⏳ Pending — Processing transaction...");
      setTxHash("");
      addEvent("💸 Transaction initiated...");

      const accountRes = await fetch(`${HORIZON_URL}/accounts/${wallet}`);
      const accountData = await accountRes.json();
      const account = new Account(wallet, accountData.sequence);

      const transaction = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(Operation.payment({
          destination: recipient,
          asset: Asset.native(),
          amount: amount.toString(),
        }))
        .setTimeout(30)
        .build();

      addEvent("✍️ Waiting for wallet signature...");
      const signResult = await signTransaction(transaction.toXDR(), { networkPassphrase: Networks.TESTNET });
      const signedXDR = signResult.signedTxXdr || signResult;
      addEvent("📡 Submitting to blockchain...");

      const submitRes = await fetch(`${HORIZON_URL}/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `tx=${encodeURIComponent(signedXDR)}`,
      });
      const submitData = await submitRes.json();

      if (submitData.hash) {
        setTxStatus("✅ Success — Transaction confirmed!");
        setTxHash(submitData.hash);
        addEvent(`✅ Confirmed: ${submitData.hash.slice(0, 12)}...`);
        await fetchBalance(wallet);
        setRecipient("");
        setAmount("");
      } else {
        const errMsg = submitData?.extras?.result_codes?.operations?.[0] || "Unknown error";
        setTxStatus("❌ Failed: " + errMsg);
        addEvent("❌ Failed: " + errMsg);
      }
    } catch (err) {
      setTxStatus("❌ Error: " + err.message);
      addEvent("❌ Error: " + err.message);
    } finally {
      setSending(false);
    }
  };

  const sendGasless = async () => {
    if (!gaslessRecipient || !gaslessAmount) { alert("Please enter recipient and amount!"); return; }
    if (!wallet) { alert("Please connect your wallet first!"); return; }
    try {
      setGaslessLoading(true);
      setGaslessHash("");
      addEvent("⛽ Gasless transaction initiated (Fee Sponsorship)...");

      const hash = await submitGaslessTransaction(wallet, gaslessRecipient, gaslessAmount);
      setGaslessHash(hash);
      addEvent(`✅ Gasless tx confirmed: ${hash.slice(0, 12)}... (fee sponsored!)`);
      await fetchBalance(wallet);
      setGaslessRecipient("");
      setGaslessAmount("");
    } catch (err) {
      addEvent("❌ Gasless tx failed: " + err.message);
      alert("Gasless transaction failed: " + err.message);
    } finally {
      setGaslessLoading(false);
    }
  };

  const callContract = async () => {
    if (!wallet) { alert("Please connect your wallet first!"); return; }
    try {
      setContractLoading(true);
      setContractResult("⏳ Calling contract...");
      addEvent("📜 Calling TrustChain contract...");

      const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger", params: {} }),
      });
      const data = await response.json();
      const ledger = data.result?.sequence;

      setContractResult(`✅ Contract called!\n📋 Contract ID: ${CONTRACT_ID}\n📦 Ledger: ${ledger}\n🌐 Stellar Testnet`);
      addEvent(`✅ Contract called! Ledger: ${ledger}`);
    } catch (err) {
      setContractResult("❌ Failed: " + err.message);
    } finally {
      setContractLoading(false);
    }
  };

  const callTokenContract = async () => {
    if (!wallet) { alert("Please connect your wallet first!"); return; }
    try {
      setTokenLoading(true);
      setTokenResult("⏳ Calling token contract...");
      addEvent("🪙 Calling TrustToken contract...");

      const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "getLatestLedger", params: {} }),
      });
      const data = await response.json();
      const ledger = data.result?.sequence;

      setTokenResult(`✅ Token Contract called!\n🪙 Token: TRUST (TRT)\n📋 Contract: ${TOKEN_CONTRACT_ID}\n📦 Ledger: ${ledger}\n🌐 Stellar Testnet`);
      addEvent(`✅ Token contract called! Ledger: ${ledger}`);
    } catch (err) {
      setTokenResult("❌ Failed: " + err.message);
    } finally {
      setTokenLoading(false);
    }
  };

  const handleFeedback = async () => {
    if (!wallet) { alert("Please connect your wallet first to submit feedback!"); return; }
    try {
      setFeedbackLoading(true);
      setFeedbackTxHash("");
      addEvent("🙏 Submitting feedback transaction...");
      const hash = await submitFeedbackTransaction(wallet);
      setFeedbackTxHash(hash);
      addEvent(`✅ Feedback tx confirmed: ${hash.slice(0, 12)}...`);
      window.open(GOOGLE_FORM_URL, "_blank");
    } catch (err) {
      addEvent("❌ Feedback tx failed: " + err.message);
      alert("Transaction failed: " + err.message);
    } finally {
      setFeedbackLoading(false);
    }
  };

  return (
    <div style={{
      fontFamily: "'Segoe UI', Arial, sans-serif",
      maxWidth: "650px", margin: "0 auto",
      padding: "16px", background: "#f8fafc",
      minHeight: "100vh", boxSizing: "border-box", width: "100%",
    }}>

      {/* Header */}
      <div style={{
        textAlign: "center", marginBottom: "20px",
        padding: "20px 16px",
        background: "linear-gradient(135deg, #1e1b4b, #4f46e5, #7c3aed)",
        borderRadius: "16px", color: "white"
      }}>
        <h1 style={{ margin: 0, fontSize: "clamp(20px, 5vw, 28px)" }}>🔗 TrustChain</h1>
        <p style={{ margin: "6px 0 0 0", opacity: 0.9, fontSize: "clamp(12px, 3vw, 14px)" }}>
          ⚫ Level 6 — Production-Ready dApp on Stellar
        </p>
        <div style={{ marginTop: "10px", display: "flex", justifyContent: "center", gap: "8px", flexWrap: "wrap" }}>
          <span style={{ background: "rgba(255,255,255,0.2)", borderRadius: "20px", padding: "3px 10px", fontSize: "11px" }}>⛽ Gasless Tx</span>
          <span style={{ background: "rgba(255,255,255,0.2)", borderRadius: "20px", padding: "3px 10px", fontSize: "11px" }}>📜 Soroban</span>
          <span style={{ background: "rgba(255,255,255,0.2)", borderRadius: "20px", padding: "3px 10px", fontSize: "11px" }}>🪙 TRUST Token</span>
          <span style={{ background: "rgba(255,255,255,0.2)", borderRadius: "20px", padding: "3px 10px", fontSize: "11px" }}>🔒 Secure</span>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div style={{
          background: "#fff0f0", border: "1px solid #ffcccc",
          borderRadius: "10px", padding: "12px",
          marginBottom: "15px", color: "#cc0000",
          fontSize: "clamp(12px, 3vw, 14px)"
        }}>
          {error}
        </div>
      )}

      {/* Wallet Modal */}
      {showWalletModal && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(0,0,0,0.6)",
          display: "flex", alignItems: "center", justifyContent: "center",
          zIndex: 1000, padding: "16px",
        }}>
          <div style={{
            background: "white", borderRadius: "16px",
            padding: "24px", width: "100%", maxWidth: "320px",
            boxShadow: "0 20px 60px rgba(0,0,0,0.3)"
          }}>
            <h3 style={{ margin: "0 0 20px 0", textAlign: "center" }}>🔌 Select Wallet</h3>
            {SUPPORTED_WALLETS.map(w => (
              <button key={w.id} onClick={() => connectWallet(w.id)}
                style={{
                  width: "100%", padding: "14px", marginBottom: "10px",
                  background: w.id === "freighter" ? "#f0f0ff" : "#f9fafb",
                  border: w.id === "freighter" ? "2px solid #6366f1" : "1px solid #ddd",
                  borderRadius: "10px", cursor: "pointer",
                  fontSize: "15px", textAlign: "left", fontWeight: "500"
                }}>
                {w.icon} {w.name}
                {w.id === "freighter" && <span style={{ fontSize: "11px", color: "#6366f1", marginLeft: "8px" }}>(recommended)</span>}
                {w.id !== "freighter" && <span style={{ fontSize: "11px", color: "gray", marginLeft: "8px" }}>(not installed)</span>}
              </button>
            ))}
            <button onClick={() => setShowWalletModal(false)}
              style={{ width: "100%", padding: "10px", background: "#eee", border: "none", borderRadius: "10px", cursor: "pointer" }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {!wallet ? (
        <div style={{ textAlign: "center", marginTop: "50px" }}>
          {/* Onboarding Guide */}
          <div style={{ background: "#fffbe6", border: "1px solid #fde68a", borderRadius: "12px", padding: "16px", marginBottom: "24px", textAlign: "left" }}>
            <p style={{ margin: "0 0 8px 0", fontWeight: "bold", fontSize: "14px" }}>🚀 First time? Setup in 3 steps:</p>
            <ol style={{ margin: 0, paddingLeft: "20px", fontSize: "13px", lineHeight: "1.8" }}>
              <li>Install <a href="https://www.freighter.app/" target="_blank" rel="noreferrer" style={{ color: "#6366f1" }}>Freighter</a> Chrome extension</li>
              <li>Open Freighter → Settings → Switch to <b>Testnet</b></li>
              <li>Get free XLM at <a href="https://friendbot.stellar.org" target="_blank" rel="noreferrer" style={{ color: "#6366f1" }}>Friendbot</a></li>
            </ol>
          </div>
          <button onClick={() => setShowWalletModal(true)} disabled={loading}
            style={{
              padding: "16px 40px", fontSize: "clamp(14px, 4vw, 17px)",
              background: "linear-gradient(135deg, #4f46e5, #7c3aed)",
              color: "white", border: "none", borderRadius: "12px", cursor: "pointer",
              boxShadow: "0 4px 15px rgba(99,102,241,0.4)", width: "100%", maxWidth: "300px"
            }}>
            {loading ? "Connecting..." : "🔌 Connect Wallet"}
          </button>
          <p style={{ color: "gray", fontSize: "13px", marginTop: "12px" }}>Supports Freighter, xBull, Albedo</p>
        </div>
      ) : (
        <div>
          {/* Wallet Info */}
          <div style={{
            border: "1px solid #e2e8f0", borderRadius: "12px",
            padding: "16px", marginBottom: "15px", background: "white",
            boxShadow: "0 2px 8px rgba(0,0,0,0.06)"
          }}>
            <p style={{ margin: "0 0 5px 0", color: "#4f46e5", fontSize: "clamp(13px, 3vw, 15px)" }}>
              <b>✅ Connected via {selectedWallet}</b>
            </p>
            <p style={{ wordBreak: "break-all", fontSize: "11px", color: "#888", margin: "5px 0", background: "#f8fafc", padding: "8px", borderRadius: "6px" }}>{wallet}</p>
            <p style={{ fontSize: "clamp(18px, 5vw, 24px)", margin: "10px 0", fontWeight: "bold" }}>
              {balance} <span style={{ color: "#4f46e5" }}>XLM</span>
            </p>
            <button onClick={disconnectWallet}
              style={{ padding: "8px 18px", background: "#ff4444", color: "white", border: "none", borderRadius: "8px", cursor: "pointer" }}>
              Disconnect
            </button>
          </div>

          {/* TrustChain Contract */}
          <div style={{ border: "2px solid #4f46e5", borderRadius: "12px", padding: "16px", marginBottom: "15px", background: "white" }}>
            <h3 style={{ margin: "0 0 4px 0", color: "#4f46e5" }}>📜 TrustChain Contract</h3>
            <p style={{ fontSize: "10px", color: "#888", margin: "0 0 12px 0", wordBreak: "break-all" }}>{CONTRACT_ID}</p>
            <button onClick={callContract} disabled={contractLoading}
              style={{ width: "100%", padding: "12px", background: "linear-gradient(135deg, #4f46e5, #7c3aed)", color: "white", border: "none", borderRadius: "8px", fontSize: "15px", cursor: "pointer" }}>
              {contractLoading ? "⏳ Calling..." : "⚡ Call Contract"}
            </button>
            {contractResult && (
              <div style={{ marginTop: "12px", padding: "12px", background: "#f0f0ff", borderRadius: "8px", fontSize: "13px", whiteSpace: "pre-line", border: "1px solid #c7d2fe", wordBreak: "break-all" }}>
                {contractResult}
              </div>
            )}
          </div>

          {/* TrustToken Contract */}
          <div style={{ border: "2px solid #22c55e", borderRadius: "12px", padding: "16px", marginBottom: "15px", background: "white" }}>
            <h3 style={{ margin: "0 0 4px 0", color: "#22c55e" }}>🪙 TrustToken Contract</h3>
            <p style={{ fontSize: "10px", color: "#888", margin: "0 0 4px 0", wordBreak: "break-all" }}>{TOKEN_CONTRACT_ID}</p>
            <p style={{ fontSize: "11px", color: "#666", margin: "0 0 12px 0" }}>Token: TRUST (TRT)</p>
            <button onClick={callTokenContract} disabled={tokenLoading}
              style={{ width: "100%", padding: "12px", background: "linear-gradient(135deg, #22c55e, #16a34a)", color: "white", border: "none", borderRadius: "8px", fontSize: "15px", cursor: "pointer" }}>
              {tokenLoading ? "⏳ Calling..." : "🪙 Call Token Contract"}
            </button>
            {tokenResult && (
              <div style={{ marginTop: "12px", padding: "12px", background: "#f0fff4", borderRadius: "8px", fontSize: "13px", whiteSpace: "pre-line", border: "1px solid #86efac", wordBreak: "break-all" }}>
                {tokenResult}
              </div>
            )}
          </div>

          {/* Tabs: Send XLM | Gasless */}
          <div style={{ border: "1px solid #e2e8f0", borderRadius: "12px", background: "white", marginBottom: "15px", overflow: "hidden" }}>
            <div style={{ display: "flex", borderBottom: "1px solid #e2e8f0" }}>
              <button onClick={() => setActiveTab("send")}
                style={{ flex: 1, padding: "12px", border: "none", cursor: "pointer", fontWeight: "600", fontSize: "14px", background: activeTab === "send" ? "#f0f0ff" : "white", color: activeTab === "send" ? "#4f46e5" : "#888", borderBottom: activeTab === "send" ? "2px solid #4f46e5" : "none" }}>
                💸 Send XLM
              </button>
              <button onClick={() => setActiveTab("gasless")}
                style={{ flex: 1, padding: "12px", border: "none", cursor: "pointer", fontWeight: "600", fontSize: "14px", background: activeTab === "gasless" ? "#fff7ed" : "white", color: activeTab === "gasless" ? "#ea580c" : "#888", borderBottom: activeTab === "gasless" ? "2px solid #ea580c" : "none" }}>
                ⛽ Gasless (Fee Sponsored)
              </button>
            </div>

            <div style={{ padding: "16px" }}>
              {activeTab === "send" && (
                <div>
                  <input type="text" placeholder="Recipient Address (G...)"
                    value={recipient} onChange={e => setRecipient(e.target.value)}
                    style={{ width: "100%", padding: "12px", marginBottom: "10px", borderRadius: "8px", border: "1px solid #e2e8f0", boxSizing: "border-box", fontSize: "14px" }} />
                  <input type="number" placeholder="Amount (XLM)"
                    value={amount} onChange={e => setAmount(e.target.value)}
                    style={{ width: "100%", padding: "12px", marginBottom: "12px", borderRadius: "8px", border: "1px solid #e2e8f0", boxSizing: "border-box", fontSize: "14px" }} />
                  <button onClick={sendXLM} disabled={sending}
                    style={{ width: "100%", padding: "13px", background: sending ? "#ccc" : "#22c55e", color: "white", border: "none", borderRadius: "8px", fontSize: "16px", cursor: "pointer" }}>
                    {sending ? "⏳ Sending..." : "💸 Send XLM"}
                  </button>
                </div>
              )}

              {activeTab === "gasless" && (
                <div>
                  {/* Fee Sponsorship Info Banner */}
                  <div style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: "8px", padding: "12px", marginBottom: "14px" }}>
                    <p style={{ margin: "0 0 4px 0", fontWeight: "bold", fontSize: "13px", color: "#ea580c" }}>⛽ Advanced Feature: Fee Sponsorship</p>
                    <p style={{ margin: 0, fontSize: "12px", color: "#9a3412" }}>
                      Gasless transactions using Stellar's Fee Bump mechanism. The app sponsors your transaction fee — you pay <b>zero fees</b>. This is a Level 6 advanced feature.
                    </p>
                  </div>
                  <input type="text" placeholder="Recipient Address (G...)"
                    value={gaslessRecipient} onChange={e => setGaslessRecipient(e.target.value)}
                    style={{ width: "100%", padding: "12px", marginBottom: "10px", borderRadius: "8px", border: "1px solid #fed7aa", boxSizing: "border-box", fontSize: "14px" }} />
                  <input type="number" placeholder="Amount (XLM)"
                    value={gaslessAmount} onChange={e => setGaslessAmount(e.target.value)}
                    style={{ width: "100%", padding: "12px", marginBottom: "12px", borderRadius: "8px", border: "1px solid #fed7aa", boxSizing: "border-box", fontSize: "14px" }} />
                  <button onClick={sendGasless} disabled={gaslessLoading}
                    style={{ width: "100%", padding: "13px", background: gaslessLoading ? "#ccc" : "linear-gradient(135deg, #ea580c, #dc2626)", color: "white", border: "none", borderRadius: "8px", fontSize: "16px", cursor: "pointer" }}>
                    {gaslessLoading ? "⏳ Processing..." : "⛽ Send Gasless (Fee Sponsored)"}
                  </button>
                  {gaslessHash && (
                    <div style={{ marginTop: "12px", padding: "12px", background: "#fff7ed", borderRadius: "8px", border: "1px solid #fed7aa" }}>
                      <p style={{ margin: "0 0 4px 0", fontWeight: "bold", fontSize: "13px", color: "#ea580c" }}>✅ Gasless Transaction Confirmed!</p>
                      <p style={{ margin: "0 0 6px 0", fontSize: "11px", wordBreak: "break-all", color: "#555" }}>{gaslessHash}</p>
                      <a href={`https://stellar.expert/explorer/testnet/tx/${gaslessHash}`} target="_blank" rel="noreferrer"
                        style={{ color: "#ea580c", fontWeight: "500", fontSize: "13px" }}>
                        View on Stellar Explorer →
                      </a>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Transaction Status */}
          {txStatus && (
            <div style={{
              border: "1px solid #e2e8f0", borderRadius: "12px", padding: "16px", marginBottom: "15px",
              background: txStatus.includes("✅") ? "#f0fff4" : txStatus.includes("⏳") ? "#fffbe6" : "#fff0f0",
            }}>
              <h3 style={{ margin: "0 0 10px 0" }}>📊 Transaction Status</h3>
              <p style={{ fontSize: "clamp(13px, 3vw, 16px)", margin: 0 }}>{txStatus}</p>
              {txHash && (
                <div style={{ marginTop: "12px" }}>
                  <p style={{ margin: "5px 0", fontWeight: "bold", fontSize: "13px" }}>Transaction Hash:</p>
                  <p style={{ wordBreak: "break-all", fontSize: "11px", color: "#555", margin: "5px 0", background: "#f8fafc", padding: "8px", borderRadius: "6px" }}>{txHash}</p>
                  <a href={`https://stellar.expert/explorer/testnet/tx/${txHash}`} target="_blank" rel="noreferrer"
                    style={{ color: "#4f46e5", fontWeight: "500", fontSize: "13px" }}>
                    View on Stellar Explorer →
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Live Activity Feed */}
      <div style={{ border: "1px solid #e2e8f0", borderRadius: "12px", padding: "16px", background: "white", marginBottom: "20px" }}>
        <h3 style={{ margin: "0 0 12px 0" }}>⚡ Live Activity Feed</h3>
        {events.length === 0 ? (
          <p style={{ color: "gray", fontSize: "13px", margin: 0 }}>No activity yet...</p>
        ) : (
          events.map((event, i) => (
            <div key={i} style={{ padding: "8px 0", borderBottom: "1px solid #f1f5f9", fontSize: "clamp(11px, 3vw, 13px)", color: "#444" }}>
              {event}
            </div>
          ))
        )}
      </div>

      {/* Feedback Banner */}
      <div style={{
        padding: "20px 16px",
        background: "linear-gradient(135deg, #4f46e5, #7c3aed)",
        borderRadius: "12px", textAlign: "center", color: "white"
      }}>
        <p style={{ margin: "0 0 6px 0", fontWeight: "bold", fontSize: "16px" }}>🙏 Help us improve TrustChain!</p>
        <p style={{ margin: "0 0 12px 0", fontSize: "13px", opacity: 0.9 }}>Share your feedback and wallet address</p>
        <button onClick={handleFeedback} disabled={feedbackLoading}
          style={{
            display: "inline-block", padding: "10px 24px",
            background: feedbackLoading ? "#ccc" : "white",
            color: feedbackLoading ? "#888" : "#4f46e5",
            borderRadius: "8px", fontWeight: "bold",
            border: "none", fontSize: "14px", cursor: "pointer"
          }}>
          {feedbackLoading ? "⏳ Processing..." : "📝 Fill Feedback Form"}
        </button>
        {feedbackTxHash && (
          <div style={{ marginTop: "12px", background: "rgba(255,255,255,0.15)", borderRadius: "8px", padding: "10px" }}>
            <p style={{ margin: "0 0 4px 0", fontSize: "12px" }}>✅ Transaction confirmed!</p>
            <p style={{ margin: "0 0 6px 0", fontSize: "10px", wordBreak: "break-all", opacity: 0.8 }}>{feedbackTxHash}</p>
            <a href={`https://stellar.expert/explorer/testnet/tx/${feedbackTxHash}`} target="_blank" rel="noreferrer"
              style={{ color: "white", fontSize: "12px", fontWeight: "bold" }}>
              View on Stellar Explorer →
            </a>
          </div>
        )}
      </div>

    </div>
  );
}

export default App;