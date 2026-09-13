import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SOLANA_NETWORKS,
  solanaSigner,
  encodePaymentSolanaExact,
  encodePaymentSolanaUpto,
  usdcBalanceMicroSolana,
} from "../src/solana.ts";
import { PAYMENT_CHANNELS_PROGRAM } from "../src/channels.ts";
import { selectOffer } from "../src/live.ts";
import type { AcceptsEntry } from "../src/types.ts";
import type { UnsignedPayment } from "../src/payer.ts";
import {
  getBase58Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  decompileTransactionMessage,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getTransferCheckedInstructionDataDecoder,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

const MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MAINNET_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

// A valid Ed25519 keypair as a 64-byte Solana secret (seed || public key).
function makeSecret(): Uint8Array {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  const pub = spki.subarray(spki.length - 32);
  return Uint8Array.from(Buffer.concat([seed, pub]));
}

function randomAddress(): string {
  return getBase58Decoder().decode(new Uint8Array(crypto.randomBytes(32)));
}

// A canned SPL mint account (82 bytes, 6 decimals, initialized, owned by the
// classic token program) so `createPaymentPayload`'s single mint read needs no
// network. Only `getAccountInfo` is expected — the blockhash is pinned.
function stubMintFetch(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const parsed = JSON.parse(init.body);
    const call = Array.isArray(parsed) ? parsed[0] : parsed;
    if (call.method !== "getAccountInfo")
      throw new Error(`hermetic test saw an unexpected RPC call: ${call.method}`);
    const data = new Uint8Array(82);
    data[44] = 6; // decimals
    data[45] = 1; // isInitialized
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: call.id,
        result: {
          context: { slot: 1 },
          value: {
            data: [Buffer.from(data).toString("base64"), "base64"],
            executable: false,
            lamports: 1461600,
            owner: SPL_TOKEN,
            rentEpoch: 0,
            space: 82,
          },
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as never;
  return () => {
    globalThis.fetch = real;
  };
}

function devnetOffer(overrides: Partial<AcceptsEntry> = {}): AcceptsEntry {
  return {
    scheme: "exact",
    network: DEVNET_CAIP2,
    amount: "12345",
    asset: DEVNET_MINT,
    payTo: randomAddress(),
    maxTimeoutSeconds: 300,
    extra: { feePayer: randomAddress(), recentBlockhash: getBase58Decoder().decode(new Uint8Array(crypto.randomBytes(32))) },
    ...overrides,
  };
}

function unsignedFrom(offer: AcceptsEntry, x402Version: number, address: string): UnsignedPayment {
  return {
    x402Version,
    scheme: offer.scheme,
    network: offer.network,
    resource: offer.resource ?? "https://seller.example/data",
    from: address,
    payTo: offer.payTo ?? "",
    amount: offer.amount ?? offer.maxAmountRequired ?? "0",
    nonce: "n",
    timestamp: Date.now(),
    requirements: offer,
    acceptedOffer: offer,
  };
}

test("SOLANA_NETWORKS resolves both CAIP-2 ids and v1 names to the right mints", () => {
  for (const key of [MAINNET_CAIP2, "solana"]) {
    assert.equal(SOLANA_NETWORKS[key].mint, MAINNET_MINT, `${key} mint`);
    assert.equal(SOLANA_NETWORKS[key].tokenProgram, SPL_TOKEN);
  }
  for (const key of [DEVNET_CAIP2, "solana-devnet"]) {
    assert.equal(SOLANA_NETWORKS[key].mint, DEVNET_MINT, `${key} mint`);
  }
  assert.equal(SOLANA_NETWORKS["solana"].caip2, MAINNET_CAIP2);
  assert.equal(SOLANA_NETWORKS["solana-devnet"].caip2, DEVNET_CAIP2);
});

test("the bad `EQnzfwaE` devnet id never appears in the module ids or its output", async () => {
  assert.doesNotMatch(JSON.stringify(SOLANA_NETWORKS), /EQnzfwaE/);
  const src = fs.readFileSync(fileURLToPath(new URL("../src/solana.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(src, /EQnzfwaE/, "src/solana.ts must not contain the bad devnet id");

  const restore = stubMintFetch();
  try {
    const signer = solanaSigner(makeSecret());
    const offer = devnetOffer();
    const header = await encodePaymentSolanaExact(signer, unsignedFrom(offer, 2, signer.address), {
      rpcUrl: "https://api.devnet.solana.com",
    });
    assert.doesNotMatch(Buffer.from(header, "base64").toString("utf8"), /EQnzfwaE/);
  } finally {
    restore();
  }
});

test("selectOffer picks the cheapest Solana exact offer whose asset is the cluster's USDC mint", () => {
  const payTo = randomAddress();
  const offers: AcceptsEntry[] = [
    // EVM Base offer — different family, must be ignored on a Solana agent.
    { scheme: "exact", network: "eip155:84532", amount: "1", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: "0xdead" },
    // Solana MAINNET offer — same family, different cluster, must be ignored.
    { scheme: "exact", network: MAINNET_CAIP2, amount: "1", asset: MAINNET_MINT, payTo },
    // Solana devnet, wrong asset — rejected.
    { scheme: "exact", network: DEVNET_CAIP2, amount: "1", asset: "So11111111111111111111111111111111111111112", payTo },
    // Solana devnet, correct mint — the two candidates; cheaper wins.
    { scheme: "exact", network: DEVNET_CAIP2, amount: "5000", asset: DEVNET_MINT, payTo },
    { scheme: "exact", network: "solana-devnet", amount: "3000", asset: DEVNET_MINT, payTo },
  ];
  const picked = selectOffer(offers, "solana-devnet");
  assert.ok(picked, "expected a Solana devnet offer to be selected");
  assert.equal(picked.amount, "3000");
  assert.equal(picked.asset, DEVNET_MINT);

  // The same mixed list on a Base agent still resolves the Base offer — no EVM regression.
  const evm = selectOffer(offers, "base-sepolia");
  assert.ok(evm, "expected the Base offer to still be selected on an EVM agent");
  assert.equal(evm.network, "eip155:84532");
});

test("v2 exact header echoes `accepted` verbatim and carries the transaction", async () => {
  const restore = stubMintFetch();
  try {
    const signer = solanaSigner(makeSecret());
    const offer = devnetOffer();
    const header = await encodePaymentSolanaExact(signer, unsignedFrom(offer, 2, signer.address), {
      rpcUrl: "https://api.devnet.solana.com",
    });
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    assert.equal(decoded.x402Version, 2);
    assert.deepEqual(decoded.accepted, offer, "the seller offer must be echoed verbatim");
    assert.equal(typeof decoded.payload.transaction, "string");
    assert.ok(decoded.payload.transaction.length > 0);
  } finally {
    restore();
  }
});

test("v1 exact header carries the flat shape and the transaction", async () => {
  const restore = stubMintFetch();
  try {
    const signer = solanaSigner(makeSecret());
    const offer = devnetOffer({ network: "solana-devnet", resource: "https://seller.example/data" });
    const header = await encodePaymentSolanaExact(signer, unsignedFrom(offer, 1, signer.address), {
      rpcUrl: "https://api.devnet.solana.com",
    });
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    assert.equal(decoded.x402Version, 1);
    assert.equal(decoded.scheme, "exact");
    assert.equal(decoded.network, "solana-devnet");
    assert.equal(decoded.resource.url, "https://seller.example/data");
    assert.equal(typeof decoded.payload.transaction, "string");
  } finally {
    restore();
  }
});

test("the decoded exact transaction: 2 signatures, payer signed, feePayer unsigned, TransferChecked to the seller ATA for the exact amount", async () => {
  const restore = stubMintFetch();
  try {
    const signer = solanaSigner(makeSecret());
    const feePayer = randomAddress();
    const payTo = randomAddress();
    const blockhash = getBase58Decoder().decode(new Uint8Array(crypto.randomBytes(32)));
    const offer: AcceptsEntry = {
      scheme: "exact",
      network: DEVNET_CAIP2,
      amount: "12345",
      asset: DEVNET_MINT,
      payTo,
      maxTimeoutSeconds: 300,
      extra: { feePayer, recentBlockhash: blockhash },
    };
    const header = await encodePaymentSolanaExact(signer, unsignedFrom(offer, 2, signer.address), {
      rpcUrl: "https://api.devnet.solana.com",
    });
    const b64 = JSON.parse(Buffer.from(header, "base64").toString("utf8")).payload.transaction;

    const wire = new Uint8Array(getBase64Encoder().encode(b64));
    const tx = getTransactionDecoder().decode(wire);

    // Two required signatures: the feePayer (unsigned) and the payer (signed).
    const sigs = tx.signatures as Record<string, Uint8Array | null>;
    assert.equal(Object.keys(sigs).length, 2, "expected exactly two required signatures");
    assert.equal(sigs[feePayer], null, "feePayer must be left unsigned");
    assert.ok(sigs[signer.address] != null, "payer must have signed");
    assert.equal((sigs[signer.address] as Uint8Array).length, 64, "payer signature is 64 bytes");

    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    assert.equal(compiled.header.numSignerAccounts, 2, "message header requires two signers");
    const message = decompileTransactionMessage(compiled);
    assert.equal((message.feePayer as { address: string }).address, feePayer);

    // Find the TransferChecked (classic SPL token program).
    const transfer = message.instructions.find((ix: { programAddress: string }) => ix.programAddress === SPL_TOKEN);
    assert.ok(transfer, "a TransferChecked instruction must be present");
    const data = getTransferCheckedInstructionDataDecoder().decode(transfer.data as Uint8Array);
    assert.equal(data.discriminator, 12, "instruction 12 is TransferChecked");
    assert.equal(data.amount, 12345n, "must transfer the exact amount");
    assert.equal(data.decimals, 6, "USDC is 6 decimals");

    // Destination is the seller's associated token account for the mint.
    const [expectedAta] = await findAssociatedTokenPda({
      mint: DEVNET_MINT as never,
      owner: payTo as never,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const accounts = transfer.accounts as Array<{ address: string }>;
    // getTransferCheckedInstruction order: [source, mint, destination, authority].
    assert.equal(accounts[1].address, DEVNET_MINT, "second account is the mint");
    assert.equal(accounts[2].address, expectedAta, "third account is the seller ATA");
    assert.equal(accounts[3].address, signer.address, "authority is the payer");

    // Memo instruction is present (nonce), proving the full exact shape was built.
    assert.ok(
      message.instructions.some((ix: { programAddress: string }) => ix.programAddress === MEMO_PROGRAM),
      "the exact transaction carries a memo",
    );
  } finally {
    restore();
  }
});

// An `upto` offer whose `extra` pins the blockhash and slot, so the buyer's
// `open` scheme makes zero RPC calls (docs/SOLANA-ARCHITECTURE.md §4.3, SOL-05).
function uptoOffer(overrides: Partial<AcceptsEntry> = {}): AcceptsEntry {
  return {
    scheme: "upto",
    network: DEVNET_CAIP2,
    amount: "100000",
    maxAmountRequired: "100000",
    asset: DEVNET_MINT,
    payTo: randomAddress(),
    maxTimeoutSeconds: 300,
    extra: {
      paymentFlow: "escrow",
      feePayer: randomAddress(),
      receiverAuthorizer: randomAddress(),
      withdrawDelay: 900,
      tokenProgram: SPL_TOKEN,
      recentBlockhash: getBase58Decoder().decode(new Uint8Array(crypto.randomBytes(32))),
      recentSlot: 123456789,
      lastValidBlockHeight: 123456999,
    },
    ...overrides,
  };
}

// Fails the test loudly if any network call happens — proves the encode is
// hermetic when the seller pins the blockhash/slot.
function forbidFetch(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    throw new Error(`upto open made an unexpected network call to ${url} — blockhash/slot were pinned, so it must not`);
  }) as never;
  return () => {
    globalThis.fetch = real;
  };
}

test("encodePaymentSolanaUpto builds the open envelope and channel facts with zero RPC when blockhash/slot are pinned", async () => {
  const restore = forbidFetch();
  try {
    const signer = solanaSigner(makeSecret());
    const offer = uptoOffer();
    const { header, channel } = await encodePaymentSolanaUpto(
      signer,
      unsignedFrom(offer, 2, signer.address),
      { rpcUrl: "https://api.devnet.solana.com" },
    );

    // The channel facts the buyer records before the send.
    assert.equal(channel.depositMicro, 100000n, "deposit is the ceiling");
    assert.equal(channel.withdrawDelay, 900);
    assert.equal(channel.payer, signer.address);
    assert.equal(channel.payee, (offer.extra as { feePayer: string }).feePayer, "payee is the seller feePayer");
    assert.equal(channel.authorizedSigner, (offer.extra as { receiverAuthorizer: string }).receiverAuthorizer);
    assert.equal(channel.mint, DEVNET_MINT);
    assert.ok(channel.channelId.length > 0, "a channelId (PDA) was derived");
    assert.ok(channel.expiresAt > 0, "a non-zero expiry");

    // The X-PAYMENT envelope the self-facilitated seller reads.
    const env = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    assert.equal(env.x402Version, 2);
    assert.deepEqual(env.accepted, offer, "the seller offer is echoed verbatim");
    assert.equal(env.payload.channelId, channel.channelId);
    assert.equal(String(env.payload.deposit ?? env.payload.maxAmount), "100000", "deposit == maxAmount == ceiling");
    assert.equal(typeof env.payload.openTransaction, "string");
    assert.ok(env.payload.openTransaction.length > 0);
  } finally {
    restore();
  }
});

test("the decoded upto open transaction: 2 signatures, payer signed, feePayer unsigned, an open to the channels program", async () => {
  const restore = forbidFetch();
  try {
    const signer = solanaSigner(makeSecret());
    const feePayer = randomAddress();
    const offer = uptoOffer({ extra: { ...uptoOffer().extra, feePayer } });
    const { header } = await encodePaymentSolanaUpto(signer, unsignedFrom(offer, 2, signer.address));
    const b64 = JSON.parse(Buffer.from(header, "base64").toString("utf8")).payload.openTransaction;

    const wire = new Uint8Array(getBase64Encoder().encode(b64));
    const tx = getTransactionDecoder().decode(wire);
    const sigs = tx.signatures as Record<string, Uint8Array | null>;
    assert.equal(Object.keys(sigs).length, 2, "feePayer + payer");
    assert.equal(sigs[feePayer], null, "feePayer is left unsigned for the seller to co-sign");
    assert.ok(sigs[signer.address] != null, "payer signed the open");

    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const message = decompileTransactionMessage(compiled);
    assert.equal((message.feePayer as { address: string }).address, feePayer);
    assert.ok(
      message.instructions.some((ix: { programAddress: string }) => ix.programAddress === PAYMENT_CHANNELS_PROGRAM),
      "an instruction to the payment-channels program is present",
    );
  } finally {
    restore();
  }
});

test("encodePaymentSolanaUpto refuses an offer missing the seller's self-facilitation keys", async () => {
  const signer = solanaSigner(makeSecret());
  const noFee = uptoOffer({ extra: { receiverAuthorizer: randomAddress() } });
  await assert.rejects(
    () => encodePaymentSolanaUpto(signer, unsignedFrom(noFee, 2, signer.address)),
    /feePayer/,
  );
});

test("selectOffer weighs exact against upto by the per-call cap and preferScheme (§4.2)", () => {
  const payTo = randomAddress();
  const feePayer = randomAddress();
  const receiverAuthorizer = randomAddress();
  const exact: AcceptsEntry = { scheme: "exact", network: DEVNET_CAIP2, amount: "80000", asset: DEVNET_MINT, payTo };
  const upto: AcceptsEntry = {
    scheme: "upto",
    network: DEVNET_CAIP2,
    amount: "100000",
    asset: DEVNET_MINT,
    payTo,
    extra: { feePayer, receiverAuthorizer, withdrawDelay: 900 },
  };
  const offers = [exact, upto];

  // Default: exact wins when its price is at or below the per-call cap.
  assert.equal(selectOffer(offers, "solana-devnet", { perCallMaxMicro: 100000n })?.scheme, "exact");
  // Exact over the cap → fall back to upto (whose ceiling the policy still checks).
  assert.equal(selectOffer(offers, "solana-devnet", { perCallMaxMicro: 50000n })?.scheme, "upto");
  // Explicit override in either direction.
  assert.equal(selectOffer(offers, "solana-devnet", { preferScheme: "upto" })?.scheme, "upto");
  assert.equal(selectOffer(offers, "solana-devnet", { preferScheme: "exact", perCallMaxMicro: 1n })?.scheme, "exact");

  // An upto offer with no self-facilitation keys is unbuildable and dropped.
  const brokenUpto: AcceptsEntry = { scheme: "upto", network: DEVNET_CAIP2, amount: "100000", asset: DEVNET_MINT, payTo };
  assert.equal(selectOffer([brokenUpto], "solana-devnet", { preferScheme: "upto" }), undefined);
});

test("usdcBalanceMicroSolana sums matching token accounts over plain JSON-RPC", async () => {
  const real = globalThis.fetch;
  const owner = randomAddress();
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const call = JSON.parse(init.body);
    assert.equal(call.method, "getTokenAccountsByOwner");
    assert.equal(call.params[0], owner);
    assert.equal(call.params[1].mint, DEVNET_MINT);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: call.id,
        result: {
          context: { slot: 1 },
          value: [
            { account: { data: { parsed: { info: { tokenAmount: { amount: "1500000" } } } } } },
            { account: { data: { parsed: { info: { tokenAmount: { amount: "500000" } } } } } },
          ],
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as never;
  try {
    const bal = await usdcBalanceMicroSolana("https://api.devnet.solana.com", DEVNET_MINT, owner);
    assert.equal(bal, 2_000_000n, "two accounts, summed in micro-USDC");
  } finally {
    globalThis.fetch = real;
  }

  // No matching account → zero, not an error.
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const call = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: { context: { slot: 1 }, value: [] } }), {
      headers: { "content-type": "application/json" },
    });
  }) as never;
  try {
    const bal = await usdcBalanceMicroSolana("https://api.devnet.solana.com", DEVNET_MINT, randomAddress());
    assert.equal(bal, 0n);
  } finally {
    globalThis.fetch = real;
  }
});
