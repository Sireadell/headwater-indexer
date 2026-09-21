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
  type ReviewCadence,
  type SharedFunder,
  type WalletBirth,
  type WalletFunder,
  type FunderProfile,
} from "envio";
import { getWalletOrigin, type WalletOrigin } from "../effects/walletHistory";

const NANSEN_API_KEY = process.env.NANSEN_API_KEY;
const NANSEN_BASE_URL = "https://api.nansen.ai/v2";

// Ported from headwater/src/core/signals/fanOut.js -- same constants, same
// meaning: a funder paying out to this many distinct recipients over this
// long a span behaves like an exchange/payment processor, not a
// coordinated funder. Circumstantial only, never sufficient alone.
const FAN_OUT_THRESHOLD = 15;
const MIN_FAN_OUT_SPAN_SECONDS = 25 * 60 * 60;

// Edge case: a real high-volume funder (an actual exchange) can accumulate
// thousands of distinct recipients. Keep counting recipientCount exactly,
// but cap the stored recipients array so one hot wallet can't blow up row
// size. recipientCount, not array length, is authoritative for the
// threshold check.
const MAX_STORED_RECIPIENTS = 200;

// Review-timing cadence thresholds.
//
// A genuine reviewer's gaps between reviews are ragged: minutes, then
// hours, then days. A script's gaps are nearly identical. The
// coefficient of variation (stddev / mean) measures exactly that
// raggedness, and it is scale-free -- a bot firing every 50 seconds and
// one firing every 50 minutes both score near zero, while human
// behaviour sits well above 1.0.
//
// MIN_CADENCE_INTERVALS guards against calling automation on a handful
// of points, where a tight spread can happen by chance.
// A funder paying two or more distinct reviewers is the shape this
// signal exists to catch. Two is deliberately low: the other funding
// signals already cover the high-volume end, and the coordinated case
// this targets is small by design -- a handful of wallets is enough to
// swing an agent's reputation.
// A funder paying this many distinct wallets is distributing, not
// coordinating. Measured against live Monad data: one wallet had funded
// 1,984 reviewer wallets with ordinary non-dust amounts, 99% of every
// funding relationship in the index. Grouping by shared funder without
// excluding that would flag every agent on the chain.
//
// Set well above any plausible coordinated ring and well below faucet
// scale, so a real operator funding a dozen wallets still surfaces.
const DISTRIBUTOR_WALLET_THRESHOLD = 25;

const MIN_SHARED_FUNDER_REVIEWERS = 2;
const MAX_STORED_FUNDED_REVIEWERS = 200;

const MIN_CADENCE_INTERVALS = 5;
const MAX_CADENCE_CV = 0.35;

interface NansenWalletData {
  wallet?: {
    label?: string;
    category?: string;
    risk_score?: number;
  };
}

async function fetchNansenLabel(address: string): Promise<WalletLabel | null> {
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
      id: address,
      address,
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

// Edge case fix: cache Nansen lookups through the indexed WalletLabel
// table instead of hitting the API on every single transfer from the same
// wallet. During historical backfill a busy wallet can appear in
// thousands of transfers; without this, that's thousands of redundant API
// calls that can stall the sync or exhaust rate limits.
async function getNansenLabelCached(context: any, address: string): Promise<WalletLabel | null> {
  const existing = await context.WalletLabel.get(address);
  if (existing !== undefined) return existing;
  const fresh = await fetchNansenLabel(address);
  return fresh;
}

function isLegitimateActor(nansen: WalletLabel | null): boolean {
  if (!nansen) return false;
  const legitimateCategories = ["exchange", "market_maker", "liquidity_pool", "institutional"];
  return legitimateCategories.includes((nansen.nansen_category || "").toLowerCase());
}

// Edge case fix: every address that becomes an entity id or gets compared
// across events must be normalized the same way everywhere. Previously
// the AUSD Transfer handler lowercased addresses but the NewFeedback
// handler did not, so the same wallet could silently split into two
// different Reviewer rows depending on which event created it first --
// breaking the exact cross-signal correlation (funding + reviews) the
// product depends on.
function norm(address: string): string {
  return address.toLowerCase();
}

// Shared by the live AUSD Transfer handler AND the per-wallet historical
// backfill (see effects/walletHistory.ts) so a backfilled transfer from
// months ago gets exactly the same circular-funding / fan-out / Nansen
// treatment as one observed live.
async function processFundingTransfer(
  context: any,
  fromAddrRaw: string,
  toAddrRaw: string,
  value: bigint,
  blockNumber: number,
  timestamp: number,
  txHash: string,
  logIndex: number,
): Promise<void> {
  const fromAddr = norm(fromAddrRaw);
  const toAddr = norm(toAddrRaw);

  // Edge case fix: zero-value transfers are not real funding. The
  // ported circularFunding.js signal requires a strictly positive value
  // for exactly this reason (a zero-value contract call is not proof of
  // a real transfer). Without this check, a no-op transfer could
  // trigger a false circular-funding or fan-out flag.
  if (value <= 0n) return;

  await ensureReviewer(context, fromAddr);
  await ensureReviewer(context, toAddr);

  const transferId = `${txHash}-${logIndex}`;
  const existingTransfer = await context.FundingTransfer.get(transferId);
  if (existingTransfer !== undefined) return; // already processed (live path already saw it)

  const transfer: FundingTransfer = {
    id: transferId,
    from_id: fromAddr,
    to_id: toAddr,
    value,
    blockNumber,
    timestamp,
    txHash,
  };
  context.FundingTransfer.set(transfer);

  // --- Circular funding (ported from circularFunding.js) ---
  const forwardEdgeId = `${fromAddr}-${toAddr}`;
  const reverseEdgeId = `${toAddr}-${fromAddr}`;

  const existingForward = await context.DirectedFundingEdge.get(forwardEdgeId);
  const forwardEdge: DirectedFundingEdge = existingForward
    ? { ...existingForward, transferCount: existingForward.transferCount + 1 }
    : { id: forwardEdgeId, from: fromAddr, to: toAddr, firstTxHash: txHash, transferCount: 1 };
  context.DirectedFundingEdge.set(forwardEdge);

  const reverseEdge = await context.DirectedFundingEdge.get(reverseEdgeId);
  if (reverseEdge !== undefined) {
    // Edge case fix: a normal exchange deposit/withdrawal cycle between
    // the same two wallets looks identical to real circular funding on
    // this signal alone. Skip the flag if either side is a
    // Nansen-confirmed legitimate actor, same filter already applied to
    // FunderFanOut and WalletLabel.
    const fromNansen = await getNansenLabelCached(context, fromAddr);
    const toNansen = await getNansenLabelCached(context, toAddr);
    if (!isLegitimateActor(fromNansen) && !isLegitimateActor(toNansen)) {
      const pairId = [fromAddr, toAddr].sort().join("-");
      const circular: CircularFunding = {
        id: pairId,
        walletA: fromAddr,
        walletB: toAddr,
        firstDirectionTxHash: reverseEdge.firstTxHash,
        returnTxHash: txHash,
        detectedAtBlock: blockNumber,
        detectedAtTimestamp: timestamp,
      };
      context.CircularFunding.set(circular);
    }
  }

  // --- Funder fan-out (ported from fanOut.js, same thresholds) ---
  const existingFanOut = await context.FunderFanOut.get(fromAddr);
  const priorCount = existingFanOut ? existingFanOut.recipientCount : 0;
  const alreadyStored = existingFanOut ? existingFanOut.recipients.includes(toAddr) : false;

  const recipients = existingFanOut ? [...existingFanOut.recipients] : [];
  if (!alreadyStored && recipients.length < MAX_STORED_RECIPIENTS) {
    recipients.push(toAddr);
  }
  // recipientCount stays authoritative even once the stored array caps out.
  const recipientCount = alreadyStored ? priorCount : priorCount + 1;

  const firstPaymentTimestamp = existingFanOut
    ? Math.min(existingFanOut.firstPaymentTimestamp, timestamp)
    : timestamp;
  const lastPaymentTimestamp = existingFanOut
    ? Math.max(existingFanOut.lastPaymentTimestamp, timestamp)
    : timestamp;
  const spanSeconds = lastPaymentTimestamp - firstPaymentTimestamp;
  const thresholdMet = recipientCount >= FAN_OUT_THRESHOLD && spanSeconds >= MIN_FAN_OUT_SPAN_SECONDS;

  context.FunderFanOut.set({
    id: fromAddr,
    funder: fromAddr,
    recipients,
    recipientCount,
    firstPaymentTimestamp,
    lastPaymentTimestamp,
    spanSeconds,
    thresholdMet,
  });

  // If the recipient has already left feedback, this transfer is someone
  // funding a reviewer. The mirror case -- funded first, reviewed later --
  // is handled by the backfill path instead.
  const recipient = await context.Reviewer.get(toAddr);
  if (recipient !== undefined && recipient.distinctAgentCount > 0) {
    await registerFundedReviewer(context, fromAddr, toAddr, timestamp);
  }

  // Nansen: only store a label for wallets not already known-legitimate,
  // so exchanges/market-makers don't pollute the suspicious-wallet table.
  // Cached lookup avoids re-calling Nansen for a wallet already checked.
  const nansen = await getNansenLabelCached(context, fromAddr);
  if (nansen && !isLegitimateActor(nansen)) {
    context.WalletLabel.set(nansen);
  }
}

// Writes one wallet-funder edge, and keeps that funder's distinct-wallet
// count current. Counting happens here rather than at read time because
// the dashboard only ever sees one agent's handful of wallets and cannot
// tell a coordinator from a faucet from that alone. The distinction is
// global, so it has to be computed where the global view exists.
async function recordFunderEdge(
  context: any,
  wallet: string,
  funder: string,
  row: {
    firstFundedBlock: number;
    firstFundedTimestamp: number;
    valueRaw: string;
    source: string;
    isDust: boolean;
  },
): Promise<void> {
  const id = `${wallet}-${funder}`;
  const already = await context.WalletFunder.get(id);

  context.WalletFunder.set({ id, wallet, funder, ...row });

  // Only a newly seen pair moves the count. A funder that paid the same
  // wallet fifty times has funded one wallet.
  if (already !== undefined) return;

  const profile = await context.FunderProfile.get(funder);
  const distinctWalletsFunded = (profile ? profile.distinctWalletsFunded : 0) + 1;
  context.FunderProfile.set({
    id: funder,
    funder,
    distinctWalletsFunded,
    distributorShaped: distinctWalletsFunded >= DISTRIBUTOR_WALLET_THRESHOLD,
  });
}

// Records when a reviewer wallet first appeared on chain, and who paid
// into it. Runs once per wallet at the moment it is first seen
// reviewing; the underlying lookup is cached so a redeploy does not
// re-query it.
async function recordWalletOrigin(
  context: any,
  reviewerAddress: string,
): Promise<void> {
  const wallet = norm(reviewerAddress);
  const existing = await context.WalletBirth.get(wallet);
  if (existing !== undefined) return;

  let origin: WalletOrigin | null = null;
  try {
    origin = await context.effect(getWalletOrigin, wallet);
  } catch (err) {
    // A failed lookup must write nothing, or a transient error would be
    // baked in permanently as a birth at block zero.
    console.log(`Wallet origin lookup skipped for ${wallet}`);
    return;
  }

  context.WalletBirth.set({
    id: wallet,
    wallet,
    firstSeenBlock: origin ? origin.firstSeenBlock : 0,
    firstSeenTimestamp: origin ? origin.firstSeenTimestamp : 0,
    foundActivity: origin !== null,
  });

  // Native funders, as found above.
  if (origin) {
    for (const f of origin.funders) {
      await recordFunderEdge(context, wallet, f.funder, {
        firstFundedBlock: f.blockNumber,
        firstFundedTimestamp: f.timestamp,
        valueRaw: f.valueWei,
        source: "native",
        isDust: f.isDust,
      });
    }
  }

}


// Records that `funder` paid `reviewerAddress`, a wallet known to have
// left feedback. Called from both directions so ordering does not
// matter: the backfill path covers wallets funded before they ever
// reviewed, and the live transfer path covers wallets funded after.
async function registerFundedReviewer(
  context: any,
  funderRaw: string,
  reviewerRaw: string,
  timestamp: number,
): Promise<void> {
  const funder = norm(funderRaw);
  const reviewer = norm(reviewerRaw);

  // A wallet moving its own money between its own addresses is not
  // someone funding a reviewer.
  if (funder === reviewer) return;

  const existing = await context.SharedFunder.get(funder);

  // Count each funded reviewer once, however many times they were paid.
  // Ten transfers to one wallet is one funded reviewer, not ten.
  if (existing !== undefined && existing.fundedReviewers.includes(reviewer)) {
    context.SharedFunder.set({
      ...existing,
      firstFundingTimestamp: Math.min(existing.firstFundingTimestamp, timestamp),
      lastFundingTimestamp: Math.max(existing.lastFundingTimestamp, timestamp),
    });
    return;
  }

  const fundedReviewers = existing ? [...existing.fundedReviewers] : [];
  if (fundedReviewers.length < MAX_STORED_FUNDED_REVIEWERS) {
    fundedReviewers.push(reviewer);
  }
  // Stays exact past the array cap, same approach as FunderFanOut.
  const fundedReviewerCount = (existing ? existing.fundedReviewerCount : 0) + 1;

  // An exchange pays thousands of wallets, some of whom happen to review
  // agents. Flagging that would be a false positive on the largest,
  // most visible funders on the chain. The external label service that
  // was meant to catch this is not operational, so the indexer's own
  // fan-out result stands in: a funder already shaped like a payment
  // processor is recorded but not flagged.
  const fanOut = await context.FunderFanOut.get(funder);
  const exchangeShaped = fanOut !== undefined && fanOut.thresholdMet;

  context.SharedFunder.set({
    id: funder,
    funder,
    fundedReviewers,
    fundedReviewerCount,
    firstFundingTimestamp: existing
      ? Math.min(existing.firstFundingTimestamp, timestamp)
      : timestamp,
    lastFundingTimestamp: existing
      ? Math.max(existing.lastFundingTimestamp, timestamp)
      : timestamp,
    exchangeShaped,
    thresholdMet:
      fundedReviewerCount >= MIN_SHARED_FUNDER_REVIEWERS && !exchangeShaped,
  });
}

// Updates a reviewer's running review-timing statistics with one new
// feedback event. Kept as running sums (count, sum, sum of squares) so
// the per-event cost stays O(1) and no unbounded timestamp array is
// stored -- a single wallet in the live data already has 19 reviews on
// one agent alone.
async function updateReviewCadence(
  context: any,
  agentId: string,
  reviewerAddress: string,
  timestamp: number,
): Promise<void> {
  // Keyed per agent, not per wallet: a scripted burst on one agent is
  // separated from the next by a long pause while the operator moves on,
  // and averaging those pauses in hides the regularity inside each burst.
  const cadenceId = `${agentId}-${reviewerAddress}`;
  const existing = await context.ReviewCadence.get(cadenceId);

  if (existing === undefined) {
    // First review seen for this wallet: no interval exists yet, so
    // there is nothing to measure until the next one arrives.
    context.ReviewCadence.set({
      id: cadenceId,
      agent_id: agentId,
      reviewer_id: reviewerAddress,
      lastReviewTimestamp: timestamp,
      reviewCount: 1,
      intervalCount: 0,
      intervalSumSeconds: 0,
      intervalSumSquares: 0,
      meanIntervalSeconds: 0,
      stdDevSeconds: 0,
      coefficientOfVariation: 0,
      minIntervalSeconds: 0,
      maxIntervalSeconds: 0,
      automationSuspected: false,
    });
    return;
  }

  const interval = timestamp - existing.lastReviewTimestamp;

  // Two reviews in the same block carry the same timestamp, giving a
  // zero interval that is an artifact of block granularity rather than
  // real timing. Counting those would drag the mean toward zero and
  // manufacture a low CV, so the review is counted but the interval is
  // not measured.
  if (interval <= 0) {
    context.ReviewCadence.set({
      ...existing,
      reviewCount: existing.reviewCount + 1,
    });
    return;
  }

  const intervalCount = existing.intervalCount + 1;
  const intervalSumSeconds = existing.intervalSumSeconds + interval;
  const intervalSumSquares = existing.intervalSumSquares + interval * interval;

  const mean = intervalSumSeconds / intervalCount;
  // Clamped at zero: the sum-of-squares form of variance can land a hair
  // below zero through floating-point rounding when every interval is
  // near-identical, which is exactly the automated case this detects.
  const variance = Math.max(0, intervalSumSquares / intervalCount - mean * mean);
  const stdDev = Math.sqrt(variance);
  const coefficientOfVariation = mean > 0 ? stdDev / mean : 0;

  context.ReviewCadence.set({
    id: cadenceId,
    agent_id: agentId,
    reviewer_id: reviewerAddress,
    lastReviewTimestamp: timestamp,
    reviewCount: existing.reviewCount + 1,
    intervalCount,
    intervalSumSeconds,
    intervalSumSquares,
    meanIntervalSeconds: mean,
    stdDevSeconds: stdDev,
    coefficientOfVariation,
    minIntervalSeconds:
      existing.intervalCount === 0
        ? interval
        : Math.min(existing.minIntervalSeconds, interval),
    maxIntervalSeconds: Math.max(existing.maxIntervalSeconds, interval),
    automationSuspected:
      intervalCount >= MIN_CADENCE_INTERVALS &&
      coefficientOfVariation <= MAX_CADENCE_CV,
  });
}

async function ensureReviewer(context: any, address: string): Promise<Reviewer> {
  const id = norm(address);
  let reviewer = await context.Reviewer.get(id);
  if (reviewer === undefined) {
    reviewer = { id, distinctAgentIds: [], distinctAgentCount: 0 };
    context.Reviewer.set(reviewer);
  }
  return reviewer;
}


indexer.onEvent(
  { contract: "IdentityRegistry", event: "Registered" },
  async ({ event, context }) => {
    const ownerAddr = norm(event.params.owner);
    const agent: Agent = {
      id: event.params.agentId.toString(),
      owner: ownerAddr,
      agentURI: event.params.agentURI,
      registeredAtBlock: event.block.number,
      registeredAtTimestamp: event.block.timestamp,
    };
    context.Agent.set(agent);

    // Screen the new agent's owner wallet against Nansen at registration
    // time -- a live gatekeeping check, not a side-lookup after the fact.
    const ownerNansen = await getNansenLabelCached(context, ownerAddr);
    if (ownerNansen) context.WalletLabel.set(ownerNansen);
  },
);

indexer.onEvent(
  { contract: "ReputationRegistry", event: "NewFeedback" },
  async ({ event, context }) => {
    const agentId = event.params.agentId.toString();
    const reviewerAddress = norm(event.params.clientAddress);
    const isNewReviewer = (await context.Reviewer.get(reviewerAddress)) === undefined;
    await ensureReviewer(context, reviewerAddress);

    // The fraud shape this tool exists to catch -- fund a wallet quietly,
    // wait, then review with it later -- defeats any short rolling
    // window, because the funding happens BEFORE the wallet is known to
    // watch. So the moment a wallet is first seen reviewing, its full
    // history is pulled directly via HyperSync, cached so it never
    // repeats for that wallet.
    //
    // This previously ALSO deep-scanned each reviewer's entire AUSD
    // history. That was removed after measuring it: across 4,476
    // reviewers it returned zero results, because reviewers on this
    // registry do not transact in AUSD. Spot-checked directly against
    // HyperSync to confirm genuine absence rather than a bug. It cost
    // one of the two rate-limited deep queries per wallet, roughly half
    // of total sync time, for nothing. Live AUSD indexing still runs, so
    // token funding is still caught going forward; only the fruitless
    // historical rescan is gone.
    if (isNewReviewer) {
      await recordWalletOrigin(context, reviewerAddress);
    }

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

    await updateReviewCadence(context, agentId, reviewerAddress, event.block.timestamp);

    // Re-read: the backfill above may have created FundingTransfer rows
    // touching this reviewer, but distinctAgentIds only changes here.
    const currentReviewer = await context.Reviewer.getOrThrow(reviewerAddress);
    if (!currentReviewer.distinctAgentIds.includes(agentId)) {
      const updatedIds = [...currentReviewer.distinctAgentIds, agentId];
      context.Reviewer.set({
        ...currentReviewer,
        distinctAgentIds: updatedIds,
        distinctAgentCount: updatedIds.length,
      });

      if (updatedIds.length > 1) {
        const reviewerNansen = await getNansenLabelCached(context, reviewerAddress);
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
    const reviewerAddress = norm(event.params.clientAddress);
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
    await processFundingTransfer(
      context,
      event.params.from,
      event.params.to,
      event.params.value,
      event.block.number,
      event.block.timestamp,
      event.transaction.hash,
      event.logIndex,
    );
  },
);
