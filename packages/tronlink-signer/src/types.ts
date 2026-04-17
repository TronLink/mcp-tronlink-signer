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
  amount: string | number;
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
  /** Wait for on-chain execution result after broadcast. Default: true. Only applies to broadcasting operations. */
  confirm?: boolean;
  /** Max time to wait for confirmation, in ms. Default: 30000. */
  confirmTimeoutMs?: number;
  /**
   * Fires after the transaction has been broadcast to the Tron network
   * (txId in mempool, not yet confirmed on-chain). Use this to start your
   * own monitoring in parallel with the SDK's polling. Callback errors are swallowed.
   */
  onBroadcasted?: (info: { txId: string; signedTransaction: Record<string, unknown> }) => void;
}

export interface WaitForTransactionOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}
