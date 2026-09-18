import {
  indexer,
  type Agent,
  type Reviewer,
  type Feedback,
  type FundingTransfer,
  type CrossAgentOverlap,
} from "envio";

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
      valueDecimals: event.params.valueDecimals,
      tag1: event.params.tag1,
      tag2: event.params.tag2,
      revoked: false,
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    };
    context.Feedback.set(feedback);

    // Incrementally maintain the cross-agent overlap aggregate: only do
    // work when this reviewer's agent set actually grows, so repeat
    // feedback on the same agent is cheap.
    if (!reviewer.distinctAgentIds.includes(agentId)) {
      const updatedIds = [...reviewer.distinctAgentIds, agentId];
      context.Reviewer.set({
        ...reviewer,
        distinctAgentIds: updatedIds,
        distinctAgentCount: updatedIds.length,
      });

      if (updatedIds.length > 1) {
        const overlap: CrossAgentOverlap = {
          id: reviewerAddress,
          reviewer_id: reviewerAddress,
          agentIds: updatedIds,
          agentCount: updatedIds.length,
        };
        context.CrossAgentOverlap.set(overlap);
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
    await ensureReviewer(context, event.params.from);
    await ensureReviewer(context, event.params.to);

    const transfer: FundingTransfer = {
      id: `${event.transaction.hash}-${event.logIndex}`,
      from_id: event.params.from,
      to_id: event.params.to,
      value: event.params.value,
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    };
    context.FundingTransfer.set(transfer);
  },
);
