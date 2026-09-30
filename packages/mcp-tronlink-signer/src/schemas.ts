import { z } from "zod";
import { isTronAddress, type TronNetwork } from "tronlink-signer";

const NetworkSchema = z
  .enum(["mainnet", "nile", "shasta"])
  .optional()
  .describe("Tron network to use (default: mainnet)");

// Tron base58 addresses are 34 chars, start with 'T', and use the base58 alphabet
// (digits 1-9 + letters minus 0, O, I, l). This regex catches the obvious garbage
// at the MCP boundary so the LLM sees a clean validation error instead of a
// TronWeb stack trace four frames deeper. It does NOT verify the base58check
// trailing checksum — TronWeb.isAddress() handles that at the SDK layer.
const TRON_BASE58_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const TronAddressSchema = z
  .string()
  .regex(TRON_BASE58_RE, "must be a Tron base58 address starting with 'T' (34 chars)");

export const SendTrxSchema = z.object({
  to: TronAddressSchema.describe("Recipient Tron address (base58)"),
  amount: z
    .union([
      z.number().positive(),
      z.string().regex(/^\d+(\.\d+)?$/, "Amount must be a non-negative decimal string"),
    ])
    .describe(
      "Amount of TRX to send in human-readable units. Prefer a string (e.g. '1.5') to avoid floating-point precision loss for large amounts; numbers are still accepted for backward compatibility. Max 6 decimal places."
    ),
  network: NetworkSchema,
});

export const SendTrc20Schema = z.object({
  contractAddress: TronAddressSchema.describe("TRC20 token contract address (base58)"),
  to: TronAddressSchema.describe("Recipient Tron address (base58)"),
  amount: z
    .string()
    .describe("Amount of tokens to send in human-readable units (e.g. '1.5' for 1.5 USDT). Decimals conversion is handled automatically."),
  decimals: z
    .number()
    .int()
    .min(0)
    .max(18)
    .optional()
    .describe("Optional. The token's precision is always read from the contract's on-chain decimals(); if provided, this value is checked against it and the send is REFUSED on mismatch (guards against 10^N magnitude errors, e.g. USDD/SUN/JST = 18dp). Omit to use the on-chain value directly."),
  network: NetworkSchema,
});

export const SignMessageSchema = z.object({
  message: z.string().describe("The message to sign"),
  network: NetworkSchema,
});

export const SignTypedDataSchema = z.object({
  typedData: z
    .record(z.string(), z.unknown())
    .describe("EIP-712 typed data object containing domain, types, primaryType and message"),
  network: NetworkSchema,
});

export const SignTransactionSchema = z.object({
  transaction: z
    .record(z.string(), z.unknown())
    .describe("Raw transaction object to sign"),
  broadcast: z
    .boolean()
    .optional()
    .default(false)
    .describe("Whether to broadcast the signed transaction on-chain (default: false)"),
  network: NetworkSchema,
});

export const ConnectWalletSchema = z.object({
  network: NetworkSchema,
});

export const GetBalanceSchema = z.object({
  address: z.string().describe("Tron address to check balance (base58)"),
  network: NetworkSchema,
});

// --- EIP-712 domain validation (MCP strict boundary, H-3) ---
//
// These checks live ONLY on the MCP path. npm/SDK consumers call
// signer.signTypedData() directly and never reach this code, so the SDK's
// public behavior is unchanged (0-migration). The browser approval page
// (web/js/actions.js) deliberately stays lenient for the same reason — it is
// shared with SDK consumers, so it only rejects what TronLink itself rejects.
// The strict, "may reject more than TronLink" validation belongs here.

// Tron chainIds by network — binds domain.chainId to the active chain.
const TRON_CHAIN_IDS: Record<TronNetwork, number> = {
  mainnet: 728126428,
  nile: 3448148188,
  shasta: 2494104990,
};

// Address forms accepted for domain.verifyingContract: Tron base58 (T…),
// Tron hex (41-prefixed, optional 0x), or EVM hex (20-byte 0x…).
const TRON_HEX_ADDR_RE = /^(0x)?41[0-9a-fA-F]{40}$/;
const EVM_HEX_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Strictly validate an EIP-712 typedData.domain before signing (MCP only).
 *
 * H-3 hardening:
 *  - chainId is OPTIONAL (EIP-712 allows chain-agnostic flows: login, off-chain
 *    consent). When present, it MUST be an integer equal to the target network's
 *    Tron chainId — a non-matching value would bind the signature to a different
 *    chain. When omitted, the signature is intentionally chain-agnostic; allow it.
 *  - verifyingContract, when present, MUST be a recognizable address — a
 *    hallucinated / malformed value would silently rebind the signature.
 *
 * Throws Error with an LLM-actionable message on any violation. Called from the
 * sign_typed_data tool handler, which resolves `network` the same way the SDK
 * does (explicit arg, else the signer's configured default).
 */
export function validateTypedDataDomain(
  typedData: Record<string, unknown>,
  network: TronNetwork,
): void {
  const domainVal = (typedData as { domain?: unknown }).domain;
  const domain: Record<string, unknown> =
    domainVal !== null && typeof domainVal === "object"
      ? (domainVal as Record<string, unknown>)
      : {};
  const expectedChainId = TRON_CHAIN_IDS[network];

  // Only validate chainId when the caller actually provided one. Omitting it is
  // a legitimate chain-agnostic signature, so we don't force it here.
  const rawChainId = domain.chainId;
  if (rawChainId !== undefined && rawChainId !== null) {
    const claimedChainId = Number(rawChainId);
    if (!Number.isInteger(claimedChainId)) {
      throw new Error(
        `typedData.domain.chainId must be an integer chainId, got ${JSON.stringify(rawChainId)}`,
      );
    }
    if (claimedChainId !== expectedChainId) {
      throw new Error(
        `typedData.domain.chainId mismatch: got ${claimedChainId}, but ${network} is chainId ` +
          `${expectedChainId}. Refusing to sign for a different chain.`,
      );
    }
  }

  const vc = domain.verifyingContract;
  if (vc !== undefined && vc !== null && vc !== "") {
    // Real validation, not just shape: isTronAddress (TronWeb.isAddress) verifies
    // the base58check checksum — a transposed/typo'd address has a valid charset and
    // length but a bad checksum. The 0x-prefixed hex forms (which TronWeb.isAddress
    // rejects) are exact byte specs with no checksum, so a regex IS the full check.
    const ok =
      typeof vc === "string" &&
      (isTronAddress(vc) || TRON_HEX_ADDR_RE.test(vc) || EVM_HEX_ADDR_RE.test(vc));
    if (!ok) {
      throw new Error(
        `typedData.domain.verifyingContract must be a valid Tron address (base58 with checksum, ` +
          `or 41-hex) or EVM (0x) address, got ${JSON.stringify(vc)}`,
      );
    }
  }
}
