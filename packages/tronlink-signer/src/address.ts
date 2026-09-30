// @ts-ignore - tronweb types are complex
import { TronWeb } from "tronweb";

/**
 * True if `value` is a valid Tron address — base58 (verified by its base58check
 * checksum) or 41-prefixed hex. Backed by TronWeb.isAddress so callers don't
 * reimplement checksum validation. Note: TronWeb.isAddress rejects 0x-prefixed
 * forms, so this returns false for "0x41…" / EVM-style "0x…" inputs.
 */
export function isTronAddress(value: string): boolean {
  // @ts-ignore - TronWeb.isAddress is a static helper
  return typeof value === "string" && TronWeb.isAddress(value);
}
