// On-demand, per-wallet funding-history backfill using HyperSync directly.
//
// WHY THIS EXISTS: the indexer's live AUSD Transfer handler only sees
// transfers from the moment its start_block onward (currently ~300k
// blocks back -- shrunk after an earlier, chain-wide window exceeded
// Envio Cloud's free-tier event quota, since AUSD settles activity
// across all of Monad, not just agent wallets). A blanket "track more
// history for everyone" fix hits the same quota wall harder.
//
// The actual fraud shape this tool exists to catch -- fund a wallet
// quietly, wait, then use it to review later -- specifically defeats a
// short rolling window: the funding happens BEFORE the wallet reveals
// itself as a reviewer, i.e. before it's "known" to watch.
//
// Fix: the moment a wallet is first discovered as a Reviewer (a rare
// event -- there are hundreds of reviewers, not millions of transfers),
// do ONE targeted HyperSync query for that wallet's entire AUSD history,
// as deep as genesis, cached forever via Envio's Effect API so it never
// runs twice for the same wallet. This is cheap precisely because it's
// targeted: one deep query per real reviewer instead of indexing every
// irrelevant AUSD transfer on Monad hoping some matches a reviewer.
import { createEffect, S } from "envio";
import { HypersyncClient, type Query } from "@envio-dev/hypersync-client";

const HYPERSYNC_URL = "https://monad.hypersync.xyz";
const AUSD_ADDRESS = "0x00000000efe302beaa2b3e6e1b18d08d69a9012a";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Both lookups below talk to HyperSync, which needs a token. Without one
// there is nothing useful to do, so they return "found nothing" rather
// than throwing or hanging on a request that cannot succeed. This also
// keeps the test suite offline and deterministic: tests run with no token
// and exercise the handler logic without reaching the network.
function hypersyncToken(): string | undefined {
  const token = process.env.ENVIO_API_TOKEN;
  return token && token.length > 0 ? token : undefined;
}

function addressToTopic(address: string): string {
  return "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function topicToAddress(topic: string): string {
  return "0x" + topic.slice(26);
}

export interface WalletTransferRecord {
  from: string;
  to: string;
  value: string;
  blockNumber: number;
  timestamp: number;
  txHash: string;
  logIndex: number;
}

export const getWalletAusdHistory = createEffect(
  {
    name: "getWalletAusdHistory",
    input: S.string,
    output: S.array(
      S.object((ctx) => ({
        from: ctx.field("from", S.string),
        to: ctx.field("to", S.string),
        value: ctx.field("value", S.string),
        blockNumber: ctx.field("blockNumber", S.number),
        timestamp: ctx.field("timestamp", S.number),
        txHash: ctx.field("txHash", S.string),
        logIndex: ctx.field("logIndex", S.number),
      })),
    ),
    // One-off deep queries triggered by rare "new reviewer" events, not
    // the hot per-transfer path -- a low rate limit is fine and avoids
    // hammering HyperSync if many new reviewers appear in one batch.
    rateLimit: { calls: 3, per: "second" },
    cache: true,
  },
  async ({ input }): Promise<WalletTransferRecord[]> => {
    const token = hypersyncToken();
    if (token === undefined) return [];

    const wallet = input.toLowerCase();
    const walletTopic = addressToTopic(wallet);
    const client = new HypersyncClient({ url: HYPERSYNC_URL, apiToken: token });

    const query: Query = {
      fromBlock: 0,
      logs: [
        // outgoing: wallet is the sender (topic1)
        { address: [AUSD_ADDRESS], topics: [[TRANSFER_TOPIC], [walletTopic]] },
        // incoming: wallet is the recipient (topic2)
        { address: [AUSD_ADDRESS], topics: [[TRANSFER_TOPIC], [], [walletTopic]] },
      ],
      fieldSelection: {
        log: [
          "BlockNumber",
          "LogIndex",
          "TransactionHash",
          "Data",
          "Address",
          "Topic0",
          "Topic1",
          "Topic2",
        ],
        block: ["Number", "Timestamp"],
      },
    };

    const records: WalletTransferRecord[] = [];
    let fromBlock = 0;
    // HyperSync's client.get() is a single paginated call, capped by an
    // internal size/time limit -- res.nextBlock tells us where to resume.
    // Loop until we reach the chain tip (res.nextBlock stops advancing
    // past res.archiveHeight) or hit a hard cap of pages, so one
    // pathologically busy wallet can't hang the effect forever.
    const MAX_PAGES = 50;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await client.get({ ...query, fromBlock });
      const timestampByBlock = new Map<number, number>();
      for (const block of res.data.blocks) {
        if (block.number !== undefined && block.timestamp !== undefined) {
          timestampByBlock.set(block.number, block.timestamp);
        }
      }
      for (const log of res.data.logs) {
        if (!log.topics[1] || !log.topics[2] || !log.data || !log.transactionHash || log.blockNumber === undefined || log.logIndex === undefined) {
          continue;
        }
        records.push({
          from: topicToAddress(log.topics[1]),
          to: topicToAddress(log.topics[2]),
          value: BigInt(log.data).toString(),
          blockNumber: log.blockNumber,
          timestamp: timestampByBlock.get(log.blockNumber) ?? 0,
          txHash: log.transactionHash,
          logIndex: log.logIndex,
        });
      }
      if (res.nextBlock >= (res.archiveHeight ?? res.nextBlock)) break;
      fromBlock = res.nextBlock;
    }

    return records;
  },
);

// When a wallet first appeared on chain, and who paid into it.
//
// Both answers come from one scan because they need the same data. A
// separate pass would double the HyperSync cost per wallet for nothing.
//
// WALLET BIRTH: wallets provisioned together by one operator tend to be
// born together, minutes apart, then held until needed. Independent
// reviewers have no reason to share a birthday. "Born" means the
// earliest block the address appears in any transaction, either
// direction: a fresh EOA cannot send before it has been funded for gas,
// so its first appearance is as a recipient.
//
// NATIVE FUNDERS: who sent this wallet its native balance. Two lessons
// carried over from telegraph-sentinel's fundingRelationship.js, both
// of which were caught against live data there:
//
//   1. This path sees NATIVE transfers only. For an ERC-20 transfer the
//      transaction's `to` is the token contract, never the recipient, so
//      token funding is invisible here by construction. The AUSD side is
//      covered separately from getWalletAusdHistory rather than pretended
//      at here.
//
//   2. The earliest funder is often not the real one. A trivial gas
//      top-up arrives first and, if collapsed to a single winner, hides
//      whoever actually capitalised the wallet. So every inbound funder
//      is returned, each marked dust or not, and the caller decides.
//      Threshold is 0.01 native, which comfortably covers real gas
//      funding (typically 0.001-0.01) without needing a price oracle.
const NATIVE_DUST_THRESHOLD_WEI = 10_000_000_000_000_000n;

export interface WalletOrigin {
  firstSeenBlock: number;
  firstSeenTimestamp: number;
  funders: {
    funder: string;
    blockNumber: number;
    timestamp: number;
    valueWei: string;
    isDust: boolean;
  }[];
}

export const getWalletOrigin = createEffect(
  {
    name: "getWalletOrigin",
    input: S.string,
    output: S.nullable(
      S.object((ctx) => ({
        firstSeenBlock: ctx.field("firstSeenBlock", S.number),
        firstSeenTimestamp: ctx.field("firstSeenTimestamp", S.number),
        funders: ctx.field(
          "funders",
          S.array(
            S.object((f) => ({
              funder: f.field("funder", S.string),
              blockNumber: f.field("blockNumber", S.number),
              timestamp: f.field("timestamp", S.number),
              valueWei: f.field("valueWei", S.string),
              isDust: f.field("isDust", S.boolean),
            })),
          ),
        ),
      })),
    ),
    rateLimit: { calls: 3, per: "second" },
    cache: true,
  },
  async ({ input }): Promise<WalletOrigin | null> => {
    const token = hypersyncToken();
    if (token === undefined) return null;

    const wallet = input.toLowerCase();
    const client = new HypersyncClient({ url: HYPERSYNC_URL, apiToken: token });

    const query: Query = {
      fromBlock: 0,
      transactions: [{ from: [wallet] }, { to: [wallet] }],
      fieldSelection: {
        transaction: ["BlockNumber", "From", "To", "Value"],
        block: ["Number", "Timestamp"],
      },
    };

    let fromBlock = 0;
    let firstSeenBlock = Number.MAX_SAFE_INTEGER;
    let firstSeenTimestamp = 0;
    // Deduped by funder, keeping each one's earliest payment: a funder
    // that paid a wallet fifty times is one funding relationship.
    const byFunder = new Map<string, WalletOrigin["funders"][number]>();

    const MAX_PAGES = 50;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await client.get({ ...query, fromBlock });

      const timestampByBlock = new Map<number, number>();
      for (const block of res.data.blocks) {
        if (block.number !== undefined && block.timestamp !== undefined) {
          timestampByBlock.set(block.number, block.timestamp);
        }
      }

      for (const tx of res.data.transactions) {
        if (tx.blockNumber === undefined) continue;
        const timestamp = timestampByBlock.get(tx.blockNumber) ?? 0;

        if (tx.blockNumber < firstSeenBlock) {
          firstSeenBlock = tx.blockNumber;
          firstSeenTimestamp = timestamp;
        }

        // Inbound only, and only where value actually moved.
        const to = tx.to?.toLowerCase();
        const from = tx.from?.toLowerCase();
        if (to !== wallet || from === undefined || from === wallet) continue;

        let valueWei: bigint;
        try {
          valueWei = BigInt(tx.value ?? "0");
        } catch {
          continue;
        }
        if (valueWei <= 0n) continue;

        const existing = byFunder.get(from);
        if (existing === undefined || timestamp < existing.timestamp) {
          byFunder.set(from, {
            funder: from,
            blockNumber: tx.blockNumber,
            timestamp,
            valueWei: valueWei.toString(),
            isDust: valueWei < NATIVE_DUST_THRESHOLD_WEI,
          });
        }
      }

      if (res.nextBlock >= (res.archiveHeight ?? res.nextBlock)) break;
      fromBlock = res.nextBlock;
    }

    // No transaction at all. Returning null keeps that distinct from
    // "born at block zero", which would read as the oldest wallet on the
    // chain and cluster falsely with every other unknown.
    if (firstSeenBlock === Number.MAX_SAFE_INTEGER) return null;

    return {
      firstSeenBlock,
      firstSeenTimestamp,
      funders: Array.from(byFunder.values()).sort((a, b) => a.timestamp - b.timestamp),
    };
  },
);
