export type TronNetwork = "mainnet" | "nile" | "shasta";

export interface NetworkConfig {
  name: string;
  fullHost: string;
  explorerUrl: string;
}

export type PendingRequestType =
  | "connect"
  | "send_trx"
  | "send_trc20"
  | "sign_message"
  | "sign_typed_data"
  | "sign_transaction";

export interface PendingRequest<T = unknown> {
  id: string;
  type: PendingRequestType;
  data: T;
  network: TronNetwork;
  createdAt: number;
}

export interface ConnectData {}

export interface SendTrxData {
  to: string;
  amount: number;
}

export interface SendTrc20Data {
  contractAddress: string;
  to: string;
  amount: string;
  decimals: number;
}

export interface SignMessageData {
  message: string;
}

export interface SignTypedDataData {
  typedData: Record<string, unknown>;
}

export interface SignTransactionData {
  transaction: Record<string, unknown>;
  broadcast?: boolean;
}

export interface AppConfig {
  network: TronNetwork;
  httpPort: number;
  apiKey?: string;
}

export interface SignerOptions {
  signal?: AbortSignal;
}
