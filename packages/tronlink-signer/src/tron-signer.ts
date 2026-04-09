// @ts-ignore - tronweb types are complex
import { TronWeb } from "tronweb";
import { PendingStore } from "./pending-store.js";
import { HttpServer } from "./http-server.js";
import { openApprovalPage } from "./browser.js";
import { NETWORKS, loadConfig } from "./config.js";
import type { AppConfig, TronNetwork, SendTrxData, SendTrc20Data, SignMessageData, SignTypedDataData, SignTransactionData } from "./types.js";
// @ts-ignore - HTML imported as text via tsup loader
import htmlContent from "./web/index.html";

export class TronSigner {
  private config: AppConfig;
  private pendingStore: PendingStore;
  private httpServer: HttpServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tronWeb: any;

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

    this.httpServer = new HttpServer(this.pendingStore, htmlContent as string);
  }

  async start(): Promise<void> {
    await this.httpServer.start(this.config.httpPort);
    console.error(`HTTP server started on http://127.0.0.1:${this.httpServer.getPort()}`);
  }

  private getPort(): number {
    return this.httpServer.getPort();
  }

  async stop(): Promise<void> {
    this.pendingStore.clear();
    await this.httpServer.stop();
  }

  getConfig(): AppConfig {
    return this.config;
  }

  private resolveNetwork(network?: TronNetwork): TronNetwork {
    return network || this.config.network;
  }

  async connectWallet(network?: TronNetwork): Promise<{ address: string }> {
    const net = this.resolveNetwork(network);
    const { id, promise } = this.pendingStore.create("connect", {}, net);
    await openApprovalPage(this.getPort(), id);
    const result = (await promise) as { address: string };
    return result;
  }

  async sendTrx(to: string, amount: number, network?: TronNetwork): Promise<{ txId: string }> {
    const net = this.resolveNetwork(network);
    const data: SendTrxData = { to, amount };
    const { id, promise } = this.pendingStore.create("send_trx", data, net);
    await openApprovalPage(this.getPort(), id);
    const result = (await promise) as { txId: string };
    return result;
  }

  async sendTrc20(
    contractAddress: string,
    to: string,
    amount: string,
    decimals?: number,
    network?: TronNetwork
  ): Promise<{ txId: string }> {
    const net = this.resolveNetwork(network);
    const data: SendTrc20Data = {
      contractAddress,
      to,
      amount,
      decimals: decimals ?? 6,
    };
    const { id, promise } = this.pendingStore.create("send_trc20", data, net);
    await openApprovalPage(this.getPort(), id);
    const result = (await promise) as { txId: string };
    return result;
  }

  async signMessage(message: string, network?: TronNetwork): Promise<{ signature: string }> {
    const net = this.resolveNetwork(network);
    const data: SignMessageData = { message };
    const { id, promise } = this.pendingStore.create("sign_message", data, net);
    await openApprovalPage(this.getPort(), id);
    const result = (await promise) as { signature: string };
    return result;
  }

  async signTypedData(
    typedData: Record<string, unknown>,
    network?: TronNetwork
  ): Promise<{ signature: string }> {
    const net = this.resolveNetwork(network);
    const data: SignTypedDataData = { typedData };
    const { id, promise } = this.pendingStore.create("sign_typed_data", data, net);
    await openApprovalPage(this.getPort(), id);
    const result = (await promise) as { signature: string };
    return result;
  }

  async signTransaction(
    transaction: Record<string, unknown>,
    network?: TronNetwork
  ): Promise<{ signedTransaction: Record<string, unknown> }> {
    const net = this.resolveNetwork(network);
    const data: SignTransactionData = { transaction };
    const { id, promise } = this.pendingStore.create("sign_transaction", data, net);
    await openApprovalPage(this.getPort(), id);
    const result = (await promise) as { signedTransaction: Record<string, unknown> };
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
