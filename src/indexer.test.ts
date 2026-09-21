import { describe, it } from "vitest";
import { createTestIndexer } from "envio";
import { TestHelpers } from "envio";
const { Addresses } = TestHelpers;

const CHAIN_ID = 143;
// AUSD is configured with start_block: 101000000 in config.yaml -- any
// simulated AUSD event needs a block number at or past that, or the test
// harness filters it out the same way the real indexer would.
const AUSD_TEST_BLOCK = 106_160_001;

describe("Agent registration", () => {
  it("creates an Agent entity from a Registered event", async (t) => {
    const indexer = createTestIndexer();
    const owner = Addresses.mockAddresses[0]!;

    await indexer.process({
      chains: {
        [CHAIN_ID]: {
          simulate: [
            {
              contract: "IdentityRegistry",
              event: "Registered",
              params: { agentId: 42n, agentURI: "ipfs://test", owner },
            },
          ],
        },
      },
    });

    const agent = await indexer.Agent.getOrThrow("42");
    t.expect(agent.owner, "owner should match the event's owner param").toBe(owner.toLowerCase());
    t.expect(agent.agentURI).toBe("ipfs://test");
  });
});

describe("Cross-agent review overlap", () => {
  it("does not flag a reviewer who has only reviewed one agent", async (t) => {
    const indexer = createTestIndexer();
    const reviewer = Addresses.mockAddresses[0]!;

    await indexer.process({
      chains: {
        [CHAIN_ID]: {
          simulate: [
            {
              contract: "ReputationRegistry",
              event: "NewFeedback",
              params: {
                agentId: 1n,
                clientAddress: reviewer,
                feedbackIndex: 0n,
                value: 90n,
                valueDecimals: 0n,
                indexedTag1: "",
                tag1: "",
                tag2: "",
                endpoint: "",
                feedbackURI: "",
                feedbackHash: "0x" + "00".repeat(32),
              },
            },
          ],
        },
      },
    });

    const overlap = await indexer.CrossAgentOverlap.get(reviewer.toLowerCase());
    t.expect(overlap, "a single-agent reviewer should not create an overlap row").toBeUndefined();

    const rev = await indexer.Reviewer.getOrThrow(reviewer.toLowerCase());
    t.expect(rev.distinctAgentCount).toBe(1);
  });

  it("flags a reviewer once they review a second distinct agent", async (t) => {
    const indexer = createTestIndexer();
    const reviewer = Addresses.mockAddresses[0]!;

    const feedbackOn = (agentId: bigint, feedbackIndex: bigint) => ({
      contract: "ReputationRegistry" as const,
      event: "NewFeedback" as const,
      params: {
        agentId,
        clientAddress: reviewer,
        feedbackIndex,
        value: 90n,
        valueDecimals: 0n,
        indexedTag1: "",
        tag1: "",
        tag2: "",
        endpoint: "",
        feedbackURI: "",
        feedbackHash: "0x" + "00".repeat(32),
      },
    });

    await indexer.process({ chains: { [CHAIN_ID]: { simulate: [feedbackOn(1n, 0n)] } } });
    await indexer.process({ chains: { [CHAIN_ID]: { simulate: [feedbackOn(2n, 0n)] } } });

    const overlap = await indexer.CrossAgentOverlap.getOrThrow(reviewer.toLowerCase());
    t.expect(overlap.agentCount).toBe(2);
    t.expect(overlap.agentIds).toEqual(["1", "2"]);
  });
});

describe("Funding transfers and address normalization", () => {
  it("normalizes reviewer and funding-transfer addresses to the same case", async (t) => {
    const indexer = createTestIndexer();
    const wallet = Addresses.mockAddresses[0]!;
    const funder = Addresses.mockAddresses[1]!;

    // Wallet shows up first via a review (mixed-case as emitted on-chain)...
    await indexer.process({
      chains: {
        [CHAIN_ID]: {
          simulate: [
            {
              contract: "ReputationRegistry",
              event: "NewFeedback",
              params: {
                agentId: 1n,
                clientAddress: wallet,
                feedbackIndex: 0n,
                value: 90n,
                valueDecimals: 0n,
                indexedTag1: "",
                tag1: "",
                tag2: "",
                endpoint: "",
                feedbackURI: "",
                feedbackHash: "0x" + "00".repeat(32),
              },
            },
          ],
        },
      },
    });

    // ...then again via a funding transfer. Both paths must resolve to the
    // SAME Reviewer row (this was a real bug: the feedback path used to
    // skip lowercasing while the transfer path didn't).
    await indexer.process({
      chains: {
        [CHAIN_ID]: {
          simulate: [
            {
              contract: "AUSD",
              event: "Transfer",
              params: { from: funder, to: wallet, value: 1_000_000n },
              block: { number: AUSD_TEST_BLOCK },
            },
          ],
        },
      },
    });

    const reviewer = await indexer.Reviewer.getOrThrow(wallet.toLowerCase());
    t.expect(reviewer.distinctAgentCount, "the review from before the transfer must still be there").toBe(1);

    const funderRow = await indexer.Reviewer.getOrThrow(funder.toLowerCase());
    t.expect(funderRow.id).toBe(funder.toLowerCase());
  });

  it("does not count a zero-value transfer as real funding", async (t) => {
    const indexer = createTestIndexer();
    const from = Addresses.mockAddresses[0]!;
    const to = Addresses.mockAddresses[1]!;

    const result = await indexer.process({
      chains: {
        [CHAIN_ID]: {
          simulate: [
            {
              contract: "AUSD",
              event: "Transfer",
              params: { from, to, value: 0n },
              block: { number: AUSD_TEST_BLOCK },
            },
          ],
        },
      },
    });

    void result;
    const fromRow = await indexer.Reviewer.get(from.toLowerCase());
    t.expect(fromRow, "a zero-value transfer should not even register the sender as a Reviewer").toBeUndefined();
  });
});

describe("Circular funding", () => {
  it("flags a wallet pair once funding flows in both directions", async (t) => {
    const indexer = createTestIndexer();
    const walletA = Addresses.mockAddresses[0]!;
    const walletB = Addresses.mockAddresses[1]!;

    await indexer.process({
      chains: {
        [CHAIN_ID]: {
          simulate: [
            {
              contract: "AUSD",
              event: "Transfer",
              params: { from: walletA, to: walletB, value: 1_000_000n },
              block: { number: AUSD_TEST_BLOCK },
              logIndex: 0,
            },
            {
              contract: "AUSD",
              event: "Transfer",
              params: { from: walletB, to: walletA, value: 500_000n },
              block: { number: AUSD_TEST_BLOCK + 1 },
              logIndex: 1,
            },
          ],
        },
      },
    });

    const pairId = [walletA.toLowerCase(), walletB.toLowerCase()].sort().join("-");
    const circular = await indexer.CircularFunding.getOrThrow(pairId);
    const pairAddresses = [circular.walletA, circular.walletB].sort();
    t.expect(pairAddresses, "the flagged pair should be exactly walletA and walletB, regardless of which sent the loop-closing transfer").toEqual(
      [walletA.toLowerCase(), walletB.toLowerCase()].sort()
    );
  });
});

describe("Review-timing cadence", () => {
  const BASE_TS = 1_771_091_270;

  // Replays a wallet posting reviews at the given gaps (in seconds) and
  // returns its resulting cadence row.
  const runWithGaps = async (gaps: number[], reviewer: string) => {
    const indexer = createTestIndexer();
    let ts = BASE_TS;
    let index = 0n;

    const feedbackAt = (timestamp: number, feedbackIndex: bigint) => ({
      contract: "ReputationRegistry" as const,
      event: "NewFeedback" as const,
      block: { timestamp },
      params: {
        agentId: 153n,
        clientAddress: reviewer as `0x${string}`,
        feedbackIndex,
        value: 90n,
        valueDecimals: 0n,
        indexedTag1: "",
        tag1: "",
        tag2: "",
        endpoint: "",
        feedbackURI: "",
        feedbackHash: "0x" + "00".repeat(32),
      },
    });

    await indexer.process({
      chains: { [CHAIN_ID]: { simulate: [feedbackAt(ts, index++)] } },
    });
    for (const gap of gaps) {
      ts += gap;
      await indexer.process({
        chains: { [CHAIN_ID]: { simulate: [feedbackAt(ts, index++)] } },
      });
    }

    // Cadence rows are keyed per agent, so the id is agentId-reviewer.
    return indexer.ReviewCadence.getOrThrow(`153-${reviewer.toLowerCase()}`);
  };

  it("flags the machine-like cadence actually observed on-chain", async (t) => {
    // These are the real gaps between the first ten reviews wallet
    // 0xb08e06cf...d91a left on agent 153, read off the live indexer.
    const realBotGaps = [56, 53, 48, 49, 49, 55, 51, 57, 49];
    const cadence = await runWithGaps(realBotGaps, Addresses.mockAddresses[0]!);

    t.expect(cadence.intervalCount).toBe(9);
    t.expect(
      cadence.coefficientOfVariation,
      "near-identical gaps should score far below the 0.35 automation threshold",
    ).toBeLessThan(0.2);
    t.expect(
      cadence.automationSuspected,
      "a wallet posting reviews 48-57s apart, nine times running, should be flagged",
    ).toBe(true);
  });

  it("does not flag ragged, human-looking review gaps", async (t) => {
    // Minutes, then hours, then a day: what real review behaviour looks like.
    const humanGaps = [340, 86_400, 1_200, 43_200, 900, 172_800, 7_200, 600, 259_200];
    const cadence = await runWithGaps(humanGaps, Addresses.mockAddresses[1]!);

    t.expect(cadence.intervalCount).toBe(9);
    t.expect(
      cadence.coefficientOfVariation,
      "wildly varying gaps should score well above the threshold",
    ).toBeGreaterThan(1);
    t.expect(
      cadence.automationSuspected,
      "irregular human timing must never be flagged as automation",
    ).toBe(false);
  });

  it("will not call automation on too few intervals, however uniform", async (t) => {
    // Perfectly uniform, but only three gaps -- far too little to claim
    // a pattern, and exactly the case a naive CV check would false-positive on.
    const cadence = await runWithGaps([60, 60, 60], Addresses.mockAddresses[2]!);

    t.expect(cadence.intervalCount).toBe(3);
    t.expect(cadence.coefficientOfVariation).toBe(0);
    t.expect(
      cadence.automationSuspected,
      "three identical gaps is not enough evidence, despite a perfect CV",
    ).toBe(false);
  });

  it("ignores same-block reviews instead of scoring them as perfect regularity", async (t) => {
    // Six reviews sharing one timestamp produce zero-second gaps. Counting
    // those would drive the CV to zero and manufacture a false flag.
    const cadence = await runWithGaps([0, 0, 0, 0, 0, 0], Addresses.mockAddresses[3]!);

    t.expect(cadence.reviewCount, "every review still counts").toBe(7);
    t.expect(
      cadence.intervalCount,
      "but zero-length gaps are block-granularity artifacts, not timing evidence",
    ).toBe(0);
    t.expect(cadence.automationSuspected).toBe(false);
  });
});

describe("Shared funder", () => {
  const feedbackFrom = (reviewer: string, agentId: bigint, feedbackIndex: bigint) => ({
    contract: "ReputationRegistry" as const,
    event: "NewFeedback" as const,
    params: {
      agentId,
      clientAddress: reviewer as `0x${string}`,
      feedbackIndex,
      value: 90n,
      valueDecimals: 0n,
      indexedTag1: "",
      tag1: "",
      tag2: "",
      endpoint: "",
      feedbackURI: "",
      feedbackHash: "0x" + "00".repeat(32),
    },
  });

  const transfer = (from: string, to: string, block: number, logIndex: number) => ({
    contract: "AUSD" as const,
    event: "Transfer" as const,
    params: { from: from as `0x${string}`, to: to as `0x${string}`, value: 5_000_000n },
    block: { number: block },
    logIndex,
  });

  it("flags one wallet that funded two separate reviewers", async (t) => {
    const indexer = createTestIndexer();
    const funder = Addresses.mockAddresses[0]!;
    const reviewerA = Addresses.mockAddresses[1]!;
    const reviewerB = Addresses.mockAddresses[2]!;

    // Both wallets review first, so they are known reviewers by the time
    // the funding lands.
    await indexer.process({
      chains: {
        [CHAIN_ID]: {
          simulate: [feedbackFrom(reviewerA, 1n, 0n), feedbackFrom(reviewerB, 1n, 0n)],
        },
      },
    });
    await indexer.process({
      chains: {
        [CHAIN_ID]: {
          simulate: [
            transfer(funder, reviewerA, AUSD_TEST_BLOCK, 0),
            transfer(funder, reviewerB, AUSD_TEST_BLOCK + 1, 1),
          ],
        },
      },
    });

    const shared = await indexer.SharedFunder.getOrThrow(funder.toLowerCase());
    t.expect(shared.fundedReviewerCount).toBe(2);
    t.expect(
      shared.thresholdMet,
      "one wallet bankrolling two different reviewers is the pattern this exists to catch",
    ).toBe(true);
  });

  it("does not flag a wallet that funded only one reviewer", async (t) => {
    const indexer = createTestIndexer();
    const funder = Addresses.mockAddresses[3]!;
    const reviewer = Addresses.mockAddresses[4]!;

    await indexer.process({
      chains: { [CHAIN_ID]: { simulate: [feedbackFrom(reviewer, 1n, 0n)] } },
    });
    await indexer.process({
      chains: { [CHAIN_ID]: { simulate: [transfer(funder, reviewer, AUSD_TEST_BLOCK, 0)] } },
    });

    const shared = await indexer.SharedFunder.getOrThrow(funder.toLowerCase());
    t.expect(shared.fundedReviewerCount).toBe(1);
    t.expect(
      shared.thresholdMet,
      "funding a single reviewer is ordinary and must not be flagged",
    ).toBe(false);
  });

  it("counts a reviewer once however many times they are paid", async (t) => {
    const indexer = createTestIndexer();
    const funder = Addresses.mockAddresses[5]!;
    const reviewer = Addresses.mockAddresses[6]!;

    await indexer.process({
      chains: { [CHAIN_ID]: { simulate: [feedbackFrom(reviewer, 1n, 0n)] } },
    });
    await indexer.process({
      chains: {
        [CHAIN_ID]: {
          simulate: [
            transfer(funder, reviewer, AUSD_TEST_BLOCK, 0),
            transfer(funder, reviewer, AUSD_TEST_BLOCK + 1, 1),
            transfer(funder, reviewer, AUSD_TEST_BLOCK + 2, 2),
          ],
        },
      },
    });

    const shared = await indexer.SharedFunder.getOrThrow(funder.toLowerCase());
    t.expect(
      shared.fundedReviewerCount,
      "three payments to the same wallet is one funded reviewer, not three",
    ).toBe(1);
    t.expect(shared.thresholdMet).toBe(false);
  });

  it("does not flag an exchange-shaped funder that pays reviewers incidentally", async (t) => {
    const indexer = createTestIndexer();
    const exchange = Addresses.mockAddresses[7]!;
    const reviewerA = Addresses.mockAddresses[8]!;
    const reviewerB = Addresses.mockAddresses[9]!;

    // Registry events go first. The harness rebuilds chain state on every
    // process() call and rejects any contract whose configured start
    // block sits below that state, so leading with AUSD would strand
    // every later call above AUSD's own start block.
    await indexer.process({
      chains: {
        [CHAIN_ID]: {
          simulate: [feedbackFrom(reviewerA, 1n, 0n), feedbackFrom(reviewerB, 1n, 0n)],
        },
      },
    });

    // Genuine fan-out shape: many distinct recipients spread over more
    // than the 25 hours the fan-out signal requires, which is what marks
    // a payment processor rather than a coordinated funder. The two
    // reviewer payments are last in the same batch, so the fan-out
    // verdict already exists when they are evaluated.
    const payouts = Array.from({ length: 20 }, (_, i) => ({
      contract: "AUSD" as const,
      event: "Transfer" as const,
      params: {
        from: exchange as `0x${string}`,
        to: ("0x" + (i + 200).toString(16).padStart(40, "0")) as `0x${string}`,
        value: 5_000_000n,
      },
      block: { number: AUSD_TEST_BLOCK + i, timestamp: 1_789_000_000 + i * 20_000 },
      logIndex: i,
    }));

    await indexer.process({
      chains: {
        [CHAIN_ID]: {
          simulate: [
            ...payouts,
            // Log indices must not collide with the payouts above: events
            // in one batch can share a synthetic transaction hash, and
            // txHash+logIndex is the transfer's identity, so a repeat
            // index would be discarded as an already-processed transfer.
            {
              ...transfer(exchange, reviewerA, AUSD_TEST_BLOCK + 100, 100),
              block: { number: AUSD_TEST_BLOCK + 100, timestamp: 1_789_500_000 },
            },
            {
              ...transfer(exchange, reviewerB, AUSD_TEST_BLOCK + 101, 101),
              block: { number: AUSD_TEST_BLOCK + 101, timestamp: 1_789_500_100 },
            },
          ],
        },
      },
    });

    const fanOut = await indexer.FunderFanOut.getOrThrow(exchange.toLowerCase());
    t.expect(fanOut.thresholdMet, "test setup: this funder must look like an exchange").toBe(true);

    const shared = await indexer.SharedFunder.getOrThrow(exchange.toLowerCase());
    t.expect(shared.fundedReviewerCount, "the funding is still recorded").toBe(2);
    t.expect(shared.exchangeShaped).toBe(true);
    t.expect(
      shared.thresholdMet,
      "an exchange paying two reviewers among hundreds is not coordination",
    ).toBe(false);
  });
});

describe("Review-timing cadence, per-agent scoping", () => {
  // Regression test for a real miss found in production. Wallet
  // 0xe0554... posted ten reviews on agent 153 at 51-82 second gaps,
  // visibly scripted, but went unflagged because cadence was measured
  // across its whole history: it reviewed six agents, and the long
  // pauses between each agent's burst swamped the regularity inside
  // them. Live scores were 0.16 for agent 153 alone versus 1.73 across
  // all six. The reviews are the real gaps read off the live indexer.
  const agent153Gaps = [79, 66, 51, 59, 76, 82, 62, 79, 58];
  const PAUSE_BETWEEN_AGENTS = 3_000;

  it("flags a scripted burst that a whole-history average would hide", async (t) => {
    const indexer = createTestIndexer();
    const reviewer = Addresses.mockAddresses[0]!;
    let ts = 1_771_091_270;
    let index = 0n;

    const review = (agentId: bigint, timestamp: number, feedbackIndex: bigint) => ({
      contract: "ReputationRegistry" as const,
      event: "NewFeedback" as const,
      block: { timestamp },
      params: {
        agentId,
        clientAddress: reviewer as `0x${string}`,
        feedbackIndex,
        value: 90n,
        valueDecimals: 0n,
        indexedTag1: "",
        tag1: "",
        tag2: "",
        endpoint: "",
        feedbackURI: "",
        feedbackHash: "0x" + "00".repeat(32),
      },
    });

    // Burst on agent 153, a long pause, then the same burst on agent 154:
    // one operator working through a list.
    const events = [review(153n, ts, index++)];
    for (const gap of agent153Gaps) {
      ts += gap;
      events.push(review(153n, ts, index++));
    }
    ts += PAUSE_BETWEEN_AGENTS;
    events.push(review(154n, ts, index++));
    for (const gap of agent153Gaps) {
      ts += gap;
      events.push(review(154n, ts, index++));
    }

    for (const event of events) {
      await indexer.process({ chains: { [CHAIN_ID]: { simulate: [event] } } });
    }

    const on153 = await indexer.ReviewCadence.getOrThrow(`153-${reviewer.toLowerCase()}`);
    const on154 = await indexer.ReviewCadence.getOrThrow(`154-${reviewer.toLowerCase()}`);

    t.expect(on153.intervalCount).toBe(agent153Gaps.length);
    t.expect(
      on153.automationSuspected,
      "the burst on agent 153 is scripted and must be flagged",
    ).toBe(true);
    t.expect(
      on154.automationSuspected,
      "the identical burst on agent 154 must be flagged too",
    ).toBe(true);

    // The pause between the two bursts is longer than any gap inside
    // them. Averaged into one score it would dominate, which is exactly
    // how the production miss happened; per-agent rows never see it.
    t.expect(
      on153.maxIntervalSeconds,
      "no cadence row should have absorbed the cross-agent pause",
    ).toBeLessThan(PAUSE_BETWEEN_AGENTS);
    t.expect(on154.maxIntervalSeconds).toBeLessThan(PAUSE_BETWEEN_AGENTS);
  });

  it("keeps one agent's verdict independent of another's", async (t) => {
    const indexer = createTestIndexer();
    const reviewer = Addresses.mockAddresses[1]!;
    let ts = 1_771_200_000;
    let index = 0n;

    const review = (agentId: bigint, timestamp: number, feedbackIndex: bigint) => ({
      contract: "ReputationRegistry" as const,
      event: "NewFeedback" as const,
      block: { timestamp },
      params: {
        agentId,
        clientAddress: reviewer as `0x${string}`,
        feedbackIndex,
        value: 90n,
        valueDecimals: 0n,
        indexedTag1: "",
        tag1: "",
        tag2: "",
        endpoint: "",
        feedbackURI: "",
        feedbackHash: "0x" + "00".repeat(32),
      },
    });

    // Scripted on agent 200, genuinely irregular on agent 201.
    const events = [review(200n, ts, index++)];
    for (const gap of [60, 61, 59, 60, 62, 58, 61, 60, 59]) {
      ts += gap;
      events.push(review(200n, ts, index++));
    }
    let humanTs = ts;
    events.push(review(201n, humanTs, index++));
    for (const gap of [340, 86_400, 1_200, 43_200, 900, 172_800]) {
      humanTs += gap;
      events.push(review(201n, humanTs, index++));
    }

    for (const event of events) {
      await indexer.process({ chains: { [CHAIN_ID]: { simulate: [event] } } });
    }

    const scripted = await indexer.ReviewCadence.getOrThrow(`200-${reviewer.toLowerCase()}`);
    const human = await indexer.ReviewCadence.getOrThrow(`201-${reviewer.toLowerCase()}`);

    t.expect(scripted.automationSuspected, "the scripted agent must flag").toBe(true);
    t.expect(
      human.automationSuspected,
      "the same wallet reviewing another agent irregularly must not be dragged into a flag",
    ).toBe(false);
  });
});
