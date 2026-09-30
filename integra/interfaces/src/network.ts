/**
 * The one network v4 transacts on: Base Sepolia, Base's test network. Held here and nowhere else.
 */

/** Base Sepolia's CAIP-2 network id, as x402 v2 names it (R3 §1, §9). */
export const NETWORK = "eip155:84532" as const;
export type Network = typeof NETWORK;

/** Base Sepolia's EVM chain id: 84532, `0x14a34` (R4 Q4). */
export const CHAIN_ID = 84532 as const;

/** The network's name, for a person. */
export const NETWORK_NAME = "Base Sepolia" as const;

/**
 * The test USDC on Base Sepolia, and its EIP-712 domain, as x402's own examples carry it in `extra` (R3 §1, §2, §9).
 * USDC has six decimals, so its smallest unit is one millionth of a USDC.
 */
export const USDC = {
  address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  name: "USDC",
  version: "2",
  decimals: 6,
} as const;

/**
 * The public Base Sepolia JSON-RPC endpoint. It answers a read-only call from another origin, with
 * `access-control-allow-origin` set to the asking origin (design §8.3; R7, 3), so a browser can read the chain itself.
 */
export const PUBLIC_RPC_URL = "https://sepolia.base.org" as const;

/** Base Sepolia's block explorer: a transaction is at `${EXPLORER_URL}/tx/<hash>`. */
export const EXPLORER_URL = "https://sepolia.basescan.org" as const;

/** A transaction's page on the explorer. */
export function explorerTxUrl(transaction: string): string {
  return `${EXPLORER_URL}/tx/${transaction}`;
}

/**
 * The escrow of x402's `auth-capture` scheme on EVM, v1.1, from the published binding
 * (`specs/schemes/auth-capture/scheme_auth_capture_evm.md`, v1.1, 2026-08-26; R3 §2). Deployed by CREATE2, so the
 * addresses are the same on Base and Base Sepolia. Which escrow v4's facilitator operates is confirmed in phase 1
 * (design §13, row 14).
 */
export const AUTH_CAPTURE_ESCROW = {
  version: "1.1",
  authCaptureEscrow: "0xf96815976523E00e65Be8f34cA5e64b4f41EB19c",
  eip3009TokenCollector: "0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88",
  permit2TokenCollector: "0xD69831Aed5bfe262067ec4c751f4F830EcdD446e",
  operatorRefundCollector: "0x7a03443724d14798c4AB4622F1DAAcA761Fea486",
} as const;
