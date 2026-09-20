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
                valueDecimals: 0,
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
        valueDecimals: 0,
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
                valueDecimals: 0,
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
              logIndex: 0,
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
