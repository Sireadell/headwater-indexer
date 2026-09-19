import {
  indexer,
  type Agent,
  type Reviewer,
  type Feedback,
  type FundingTransfer,
  type CrossAgentOverlap,
  type WalletLabel,
} from envio;

const NANSEN_API_KEY = process.env.NANSEN_API_KEY;
const NANSEN_BASE_URL = https://api.nansen.ai/v2;

interface NansenWalletData {
  wallet?: {
    label?: string;
    category?: string;
    risk_score?: number;
    transaction_count?: number;
  };
}

async function getNansenLabel(address: string): Promise<WalletLabel | null> {
  if (!NANSEN_API_KEY) return null;
  try {
    const res = await fetch(`${NANSEN_BASE_URL}/wallet/overview?address=${address}`, {
      headers: { x-api-key: NANSEN_API_KEY },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as NansenWalletData;
    const wallet = data.wallet;
    if (!wallet) return null;

    const label: WalletLabel = {
      id: address.toLowerCase(),
      address: address.toLowerCase(),
      nansen_label: wallet.label || null,
      nansen_category: wallet.category || null,
      nansen_risk_score: wallet.risk_score || null,
      nansen_checked_at: Math.floor(Date.now() / 1000),
      has_signal_flag: false,
      agreement_status: no_signal,
    };
    return label;
  } catch (err) {
    console.log(`Nansen lookup skipped for ${address}`);
    return null;
  }
}

function isLegitimateActor(nansen: WalletLabel | null): boolean {
  if (!nansen) return false;
  const legitimateCategories = [exchange, market_maker, liquidity_pool, institutional];
  return legitimateCategories.includes((nansen.nansen_category || ).toLowerCase());
}

async function ensureReviewer(context: any, address: string): Promise<Reviewer> {
  let reviewer = await context.Reviewer.get(address);
  if (reviewer === undefined) {
    reviewer = {
      id: address,
      distinctAgentIds: [],
      distinctAgentCount: 0,
    };
    context.Reviewer.set(reviewer);
  }
  return reviewer;
}

indexer.onEvent(
  { contract: IdentityRegistry, event: Registered },
  async ({ event, context }) => {
    const agent: Agent = {
      id: event.params.agentId.toString(),
      owner: event.params.owner,
      agentURI: event.params.agentURI,
      registeredAtBlock: event.block.number,
      registeredAtTimestamp: event.block.timestamp,
    };
    context.Agent.set(agent);
  },
);

indexer.onEvent(
  { contract: ReputationRegistry, event: NewFeedback },
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
      valueDecimals: event.params.valueDecimals,
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

        if (reviewerNansen) {
          context.WalletLabel.set(reviewerNansen);
        }
      }
    }
  },
);

indexer.onEvent(
  { contract: ReputationRegistry, event: FeedbackRevoked },
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
  { contract: AUSD, event: Transfer },
  async ({ event, context }) => {
    const fromAddr = event.params.from;
    const toAddr = event.params.to;

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

    const nansen = await getNansenLabel(fromAddr);
    if (nansen && !isLegitimateActor(nansen)) {
      context.WalletLabel.set(nansen);
    }
  },
);
