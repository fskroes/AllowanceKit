import type { SellerChannelStorage } from './seller-channels.ts';
import { PAYMENT_CHANNELS_PROGRAM } from './channels.ts';

export interface CleanupAccount {
  data: readonly [string, string];
  owner: string;
}
export interface CleanupSigner {
  getAccountInfo(address: string, network: string, options?: { commitment?: 'processed' | 'confirmed' | 'finalized'; encoding?: 'base64' }): Promise<CleanupAccount | null>;
  getSlot(network: string, commitment?: 'processed' | 'confirmed' | 'finalized'): Promise<bigint>;
}

/**
 * Compatibility for @x402/svm 2.25.0's reversed Sealed/Closing enum. This view
 * belongs only to the cleanup worker; payment verification sees original bytes.
 * Keep the peer pinned until these integration tests pass against its successor.
 */
export function sellerCleanupSigner<T extends CleanupSigner>(signer: T, storage: SellerChannelStorage, rpcUrl?: string): T {
  return {
    ...signer,
    async getAccountInfo(channelId: string, network: string) {
      const account = await signer.getAccountInfo(channelId, network, { commitment: 'finalized', encoding: 'base64' });
      if (account === null) {
        const row = await storage.get(channelId);
        // The library's read API discards context and cannot set minContextSlot.
        // Use a context-bearing RPC read to prove the signed open can no longer
        // land. Voucher expiresAt alone is not the transaction's replay window.
        if (row?.network === network && row.openSlot !== undefined && rpcUrl) {
          const minContextSlot = row.openSlot + 1501;
          if (!Number.isSafeInteger(minContextSlot)) throw new Error('invalid channel replay window');
          const response = await fetch(rpcUrl, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [channelId, { commitment: 'finalized', encoding: 'base64', minContextSlot }] }),
            signal: AbortSignal.timeout(15_000),
          });
          if (!response.ok) throw new Error(`cleanup absence check failed: HTTP ${response.status}`);
          const body = await response.json() as { error?: unknown; result?: { context?: { slot?: number }; value?: unknown } };
          const slot = body.result?.context?.slot;
          if (!body.error && Number.isSafeInteger(slot) && slot! >= minContextSlot && body.result?.value === null) return null;
        }
        throw new Error(`channel ${channelId} is absent without finalized expiry proof; retained for retry`);
      }
      if (account.owner !== PAYMENT_CHANNELS_PROGRAM || account.data[1] !== 'base64') throw new Error('invalid cleanup channel owner or encoding');
      const data = Buffer.from(account.data[0], 'base64');
      if (data.length !== 256 || data[0] !== 1) throw new Error('invalid cleanup channel account');
      if (data[3] === 1) data[3] = 2;
      else if (data[3] === 2) data[3] = 1;
      return { ...account, data: [data.toString('base64'), 'base64'] };
    },
  } as T;
}
