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
    const wallet = input.toLowerCase();
    const walletTopic = addressToTopic(wallet);
    const client = new HypersyncClient({
      url: HYPERSYNC_URL,
      apiToken: process.env.ENVIO_API_TOKEN!,
    });

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
