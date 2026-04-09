import { z } from "zod";

const NetworkSchema = z
  .enum(["mainnet", "nile", "shasta"])
  .optional()
  .describe("Tron network to use (default: mainnet)");

export const SendTrxSchema = z.object({
  to: z.string().describe("Recipient Tron address (base58)"),
  amount: z.number().positive().describe("Amount of TRX to send"),
  network: NetworkSchema,
});

export const SendTrc20Schema = z.object({
  contractAddress: z.string().describe("TRC20 token contract address (base58)"),
  to: z.string().describe("Recipient Tron address (base58)"),
  amount: z
    .string()
    .describe("Amount of tokens to send (in smallest unit before decimals)"),
  decimals: z
    .number()
    .int()
    .min(0)
    .max(18)
    .optional()
    .default(6)
    .describe("Token decimals (default: 6, e.g. USDT)"),
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
  network: NetworkSchema,
});

export const ConnectWalletSchema = z.object({
  network: NetworkSchema,
});

export const GetBalanceSchema = z.object({
  address: z.string().describe("Tron address to check balance (base58)"),
  network: NetworkSchema,
});
