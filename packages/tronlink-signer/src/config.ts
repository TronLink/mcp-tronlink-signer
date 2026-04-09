import type { TronNetwork, NetworkConfig, AppConfig } from "./types.js";

export const NETWORKS: Record<TronNetwork, NetworkConfig> = {
  mainnet: {
    name: "Mainnet",
    fullHost: "https://api.trongrid.io",
    explorerUrl: "https://tronscan.org",
  },
  nile: {
    name: "Nile Testnet",
    fullHost: "https://nile.trongrid.io",
    explorerUrl: "https://nile.tronscan.org",
  },
  shasta: {
    name: "Shasta Testnet",
    fullHost: "https://api.shasta.trongrid.io",
    explorerUrl: "https://shasta.tronscan.org",
  },
};

export const DEFAULT_HTTP_PORT = 3386;
export const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export function loadConfig(): AppConfig {
  const network = (process.env.TRON_NETWORK || "mainnet") as TronNetwork;
  if (!NETWORKS[network]) {
    throw new Error(
      `Invalid TRON_NETWORK: ${network}. Must be one of: ${Object.keys(NETWORKS).join(", ")}`
    );
  }
  const httpPort = process.env.TRON_HTTP_PORT
    ? parseInt(process.env.TRON_HTTP_PORT, 10)
    : DEFAULT_HTTP_PORT;
  return {
    network,
    httpPort,
    apiKey: process.env.TRON_API_KEY,
  };
}
