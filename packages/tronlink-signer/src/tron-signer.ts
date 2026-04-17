// @ts-ignore - tronweb types are complex
import { TronWeb } from "tronweb";
import { PendingStore } from "./pending-store.js";
import { HttpServer } from "./http-server.js";
import { openApprovalPage, getLastHeartbeat } from "./browser.js";
import { NETWORKS, loadConfig } from "./config.js";
import type { AppConfig, TronNetwork, SendTrxData, SendTrc20Data, SignMessageData, SignTypedDataData, SignTransactionData, SignerOptions } from "./types.js";
// @ts-ignore - HTML imported as text via tsup loader
import htmlContent from "./web/index.html";
// @ts-ignore - JS imported as text via tsup loader
import walletJs from "./web/js/wallet.js";
// @ts-ignore - JS imported as text via tsup loader
import txParserJs from "./web/js/tx-parser.js";
// @ts-ignore - JS imported as text via tsup loader
import actionsJs from "./web/js/actions.js";
// @ts-ignore - JS imported as text via tsup loader
import appJs from "./web/js/app.js";

export class TronSigner {
  private config: AppConfig;
  private pendingStore: PendingStore;
  private httpServer: HttpServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tronWeb: any;
  private browserWatchTimer: ReturnType<typeof setInterval> | null = null;
  private _onBrowserDisconnect: (() => void) | null = null;

  set onBrowserDisconnect(cb: (() => void) | null) {
    this._onBrowserDisconnect = cb;
  }

  constructor() {
    this.config = loadConfig();
    this.pendingStore = new PendingStore();

    const networkConfig = NETWORKS[this.config.network];
    const tronWebOptions: Record<string, unknown> = {
      fullHost: networkConfig.fullHost,
    };
    if (this.config.apiKey) {
      tronWebOptions.headers = { "TRON-PRO-API-KEY": this.config.apiKey };
    }
    // @ts-ignore - tronweb constructor typing
    this.tronWeb = new TronWeb(tronWebOptions);

    this.httpServer = new HttpServer(this.pendingStore, htmlContent as string, {
      'wallet.js': walletJs as string,
      'tx-parser.js': txParserJs as string,
      'actions.js': actionsJs as string,
      'app.js': appJs as string,
    });
  }

  async start(): Promise<void> {
    await this.httpServer.start(this.config.httpPort);
    console.error(`HTTP server started on http://127.0.0.1:${this.httpServer.getPort()}`);

    // Ensure HTTP server is closed when the process exits
    const cleanup = () => {
      this.httpServer.stop().catch(() => {});
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("beforeExit", cleanup);

    // Watch for browser disconnect (alive → not-alive transition)
    const DISCONNECT_TIMEOUT = 6_000;
    let wasAlive = false;
    this.browserWatchTimer = setInterval(() => {
      const hb = getLastHeartbeat();
      const alive = hb > 0 && Date.now() - hb < DISCONNECT_TIMEOUT;
      if (wasAlive && !alive && this._onBrowserDisconnect) {
        this._onBrowserDisconnect();
      }
      wasAlive = alive;
    }, 2000);
  }

  private getPort(): number {
    return this.httpServer.getPort();
  }

  async stop(): Promise<void> {
    if (this.browserWatchTimer) {
      clearInterval(this.browserWatchTimer);
      this.browserWatchTimer = null;
    }
    this.pendingStore.clear();
    await this.httpServer.stop();
  }

  getConfig(): AppConfig {
    return this.config;
  }


  private resolveNetwork(network?: TronNetwork): TronNetwork {
    return network || this.config.network;
  }

  private attachAbortSignal(id: string, promise: Promise<unknown>, signal?: AbortSignal): void {
    if (!signal) return;
    if (signal.aborted) {
      this.pendingStore.reject(id, "CANCELLED_BY_CALLER");
      return;
    }
    const onAbort = () => this.pendingStore.reject(id, "CANCELLED_BY_CALLER");
    signal.addEventListener("abort", onAbort, { once: true });
    promise.finally(() => signal.removeEventListener("abort", onAbort));
  }

  async connectWallet(network?: TronNetwork, options?: SignerOptions): Promise<{ address: string; network: string }> {
    const net = this.resolveNetwork(network);
    const { id, promise } = this.pendingStore.create("connect", {}, net);
    this.attachAbortSignal(id, promise, options?.signal);
    await openApprovalPage(this.getPort(), id);
    const result = (await promise) as { address: string; network: string };
    return result;
  }

  async sendTrx(to: string, amount: number, network?: TronNetwork, options?: SignerOptions): Promise<{ txId: string }> {
    const net = this.resolveNetwork(network);
    const data: SendTrxData = { to, amount };
    const { id, promise } = this.pendingStore.create("send_trx", data, net);
    this.attachAbortSignal(id, promise, options?.signal);
    await openApprovalPage(this.getPort(), id);
    const result = (await promise) as { txId: string };
    return result;
  }

  async sendTrc20(
    contractAddress: string,
    to: string,
    amount: string,
    decimals?: number,
    network?: TronNetwork,
    options?: SignerOptions
  ): Promise<{ txId: string }> {
    const net = this.resolveNetwork(network);
    const data: SendTrc20Data = {
      contractAddress,
      to,
      amount,
      decimals: decimals ?? 6,
    };
    const { id, promise } = this.pendingStore.create("send_trc20", data, net);
    this.attachAbortSignal(id, promise, options?.signal);
    await openApprovalPage(this.getPort(), id);
    const result = (await promise) as { txId: string };
    return result;
  }

  async signMessage(message: string, network?: TronNetwork, options?: SignerOptions): Promise<{ signature: string }> {
    const net = this.resolveNetwork(network);
    const data: SignMessageData = { message };
    const { id, promise } = this.pendingStore.create("sign_message", data, net);
    this.attachAbortSignal(id, promise, options?.signal);
    await openApprovalPage(this.getPort(), id);
    const result = (await promise) as { signature: string };
    return result;
  }

  async signTypedData(
    typedData: Record<string, unknown>,
    network?: TronNetwork,
    options?: SignerOptions
  ): Promise<{ signature: string }> {
    const net = this.resolveNetwork(network);
    const data: SignTypedDataData = { typedData };
    const { id, promise } = this.pendingStore.create("sign_typed_data", data, net);
    this.attachAbortSignal(id, promise, options?.signal);
    await openApprovalPage(this.getPort(), id);
    const result = (await promise) as { signature: string };
    return result;
  }

  async signTransaction(
    transaction: Record<string, unknown>,
    network?: TronNetwork,
    broadcast?: boolean,
    options?: SignerOptions
  ): Promise<{ signedTransaction: Record<string, unknown>; txId?: string }> {
    const net = this.resolveNetwork(network);
    const data: SignTransactionData = { transaction, broadcast: broadcast ?? false };
    const { id, promise } = this.pendingStore.create("sign_transaction", data, net);
    this.attachAbortSignal(id, promise, options?.signal);
    await openApprovalPage(this.getPort(), id);
    const result = (await promise) as { signedTransaction: Record<string, unknown>; txId?: string };
    return result;
  }

  async getBalance(address: string, network?: TronNetwork): Promise<{ balance: string; balanceSun: number }> {
    const net = this.resolveNetwork(network);
    const networkConfig = NETWORKS[net];
    const tronWebOptions: Record<string, unknown> = { fullHost: networkConfig.fullHost };
    if (this.config.apiKey) {
      tronWebOptions.headers = { "TRON-PRO-API-KEY": this.config.apiKey };
    }
    // @ts-ignore
    const tw = net === this.config.network ? this.tronWeb : new (await import("tronweb")).TronWeb(tronWebOptions);
    const balanceSun = await tw.trx.getBalance(address);
    const balance = tw.fromSun(balanceSun).toString();
    return { balance, balanceSun };
  }
}
