import {
  indexer,
  type Agent,
  type Reviewer,
  type Feedback,
  type FundingTransfer,
  type CrossAgentOverlap,
  type WalletLabel,
  type DirectedFundingEdge,
  type CircularFunding,
  type FunderFanOut,
} from "envio";

const NANSEN_API_KEY = process.env.NANSEN_API_KEY;
const NANSEN_BASE_URL = "https://api.nansen.ai/v2";

// Ported from headwater/src/core/signals/fanOut.js -- same constants, same
// meaning: a funder paying out to this many distinct recipients over this
// long a span behaves like an exchange/payment processor, not a
// coordinated funder. Circumstantial only, never sufficient alone.
const FAN_OUT_THRESHOLD = 15;
const MIN_FAN_OUT_SPAN_SECONDS = 25 * 60 * 60;

interface NansenWalletData {
  wallet?: {
    label?: string;
    category?: string;
    risk_score?: number;
  };
}

async function getNansenLabel(address: string): Promise<WalletLabel | null> {
  if (!NANSEN_API_KEY) return null;
  try {
    const res = await fetch(`${NANSEN_BASE_URL}/wallet/overview?address=${address}`, {
      headers: { "x-api-key": NANSEN_API_KEY },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as NansenWalletData;
    const wallet = data.wallet;
    if (!wallet) return null;
    return {
      id: address.toLowerCase(),
      address: address.toLowerCase(),
      nansen_label: wallet.label || undefined,
      nansen_category: wallet.category || undefined,
      nansen_risk_score: wallet.risk_score || undefined,
      nansen_checked_at: Math.floor(Date.now() / 1000),
      has_signal_flag: false,
      agreement_status: "no_signal",
    };
  } catch (err) {
    console.log(`Nansen lookup skipped for ${address}`);
    return null;
  }
}

function isLegitimateActor(nansen: WalletLabel | null): boolean {
  if (!nansen) return false;
  const legitimateCategories = ["exchange", "market_maker", "liquidity_pool", "institutional"];
  return legitimateCategories.includes((nansen.nansen_category || "").toLowerCase());
}

async function ensureReviewer(context: any, address: string): Promise<Reviewer> {
  let reviewer = await context.Reviewer.get(address);
  if (reviewer === undefined) {
    reviewer = { id: address, distinctAgentIds: [], distinctAgentCount: 0 };
    context.Reviewer.set(reviewer);
  }
  return reviewer;
}

indexer.onEvent(
  { contract: "IdentityRegistry", event: "Registered" },
  async ({ event, context }) => {
    const agent: Agent = {
      id: event.params.agentId.toString(),
      owner: event.params.owner,
      agentURI: event.params.agentURI,
      registeredAtBlock: event.block.number,
      registeredAtTimestamp: event.block.timestamp,
    };
    context.Agent.set(agent);

    // Screen the new agent's owner wallet against Nansen at registration
    // time -- a live gatekeeping check, not a side-lookup after the fact.
    const ownerNansen = await getNansenLabel(event.params.owner);
    if (ownerNansen) context.WalletLabel.set(ownerNansen);
  },
);

indexer.onEvent(
  { contract: "ReputationRegistry", event: "NewFeedback" },
  async ({ event, context }) => {
    const agentId = event.params.agentId.toString();
    const reviewerAddress = event.params.clientAddress;
    const reviewer = await ensureReviewer(context, reviewerAddress);

    const feedback: Feedback = {
      id: `${agentId}-${reviewerAddress}-${event.params.feedbackIndex.toString()}`,
      agent_id: agentId,
      reviewer_id: reviewerAddress,
      feedbackIndex: event.params.feedbackIndex,
      value: event.params.value,
      valueDecimals: Number(event.params.valueDecimals),
      tag1: event.params.tag1,
      tag2: event.params.tag2,
      revoked: false,
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    };
    context.Feedback.set(feedback);

    if (!reviewer.distinctAgentIds.includes(agentId)) {
      const updatedIds = [...reviewer.distinctAgentIds, agentId];
      context.Reviewer.set({
        ...reviewer,
        distinctAgentIds: updatedIds,
        distinctAgentCount: updatedIds.length,
      });

      if (updatedIds.length > 1) {
        const reviewerNansen = await getNansenLabel(reviewerAddress);
        const overlap: CrossAgentOverlap = {
          id: reviewerAddress,
          reviewer_id: reviewerAddress,
          agentIds: updatedIds,
          agentCount: updatedIds.length,
        };
        context.CrossAgentOverlap.set(overlap);
        if (reviewerNansen) context.WalletLabel.set(reviewerNansen);
      }
    }
  },
);

indexer.onEvent(
  { contract: "ReputationRegistry", event: "FeedbackRevoked" },
  async ({ event, context }) => {
    const agentId = event.params.agentId.toString();
    const reviewerAddress = event.params.clientAddress;
    const id = `${agentId}-${reviewerAddress}-${event.params.feedbackIndex.toString()}`;
    const feedback = await context.Feedback.get(id);
    if (feedback !== undefined) {
      context.Feedback.set({ ...feedback, revoked: true });
    }
  },
);

indexer.onEvent(
  { contract: "AUSD", event: "Transfer" },
  async ({ event, context }) => {
    const fromAddr = event.params.from.toLowerCase();
    const toAddr = event.params.to.toLowerCase();

    await ensureReviewer(context, fromAddr);
    await ensureReviewer(context, toAddr);

    const transfer: FundingTransfer = {
      id: `${event.transaction.hash}-${event.logIndex}`,
      from_id: fromAddr,
      to_id: toAddr,
      value: event.params.value,
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    };
    context.FundingTransfer.set(transfer);

    // --- Circular funding (ported from circularFunding.js) ---
    // O(1) reverse-edge lookup instead of a rescan: has toAddr ever sent
    // to fromAddr before? If so, this transfer completes a real
    // fund-then-return loop.
    const forwardEdgeId = `${fromAddr}-${toAddr}`;
    const reverseEdgeId = `${toAddr}-${fromAddr}`;

    const existingForward = await context.DirectedFundingEdge.get(forwardEdgeId);
    const forwardEdge: DirectedFundingEdge = existingForward
      ? { ...existingForward, transferCount: existingForward.transferCount + 1 }
      : { id: forwardEdgeId, from: fromAddr, to: toAddr, firstTxHash: event.transaction.hash, transferCount: 1 };
    context.DirectedFundingEdge.set(forwardEdge);

    const reverseEdge = await context.DirectedFundingEdge.get(reverseEdgeId);
    if (reverseEdge !== undefined) {
      const pairId = [fromAddr, toAddr].sort().join("-");
      const circular: CircularFunding = {
        id: pairId,
        walletA: fromAddr,
        walletB: toAddr,
        firstDirectionTxHash: reverseEdge.firstTxHash,
        returnTxHash: event.transaction.hash,
        detectedAtBlock: event.block.number,
        detectedAtTimestamp: event.block.timestamp,
      };
      context.CircularFunding.set(circular);
    }

    // --- Funder fan-out (ported from fanOut.js, same thresholds) ---
    const existingFanOut = await context.FunderFanOut.get(fromAddr);
    const recipients = existingFanOut ? [...existingFanOut.recipients] : [];
    if (!recipients.includes(toAddr)) recipients.push(toAddr);
    const firstPaymentTimestamp = existingFanOut
      ? Math.min(existingFanOut.firstPaymentTimestamp, event.block.timestamp)
      : event.block.timestamp;
    const lastPaymentTimestamp = existingFanOut
      ? Math.max(existingFanOut.lastPaymentTimestamp, event.block.timestamp)
      : event.block.timestamp;
    const spanSeconds = lastPaymentTimestamp - firstPaymentTimestamp;
    const thresholdMet = recipients.length >= FAN_OUT_THRESHOLD && spanSeconds >= MIN_FAN_OUT_SPAN_SECONDS;

    context.FunderFanOut.set({
      id: fromAddr,
      funder: fromAddr,
      recipients,
      recipientCount: recipients.length,
      firstPaymentTimestamp,
      lastPaymentTimestamp,
      spanSeconds,
      thresholdMet,
    });

    // Nansen: only store a label for wallets not already known-legitimate,
    // so exchanges/market-makers don't pollute the suspicious-wallet table.
    const nansen = await getNansenLabel(fromAddr);
    if (nansen && !isLegitimateActor(nansen)) {
      context.WalletLabel.set(nansen);
    }
  },
);
