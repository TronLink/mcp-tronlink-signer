// @ts-ignore - tronweb types are complex
import { TronWeb } from "tronweb";
import { PendingStore } from "./pending-store.js";
import { HttpServer } from "./http-server.js";
import { openApprovalPage, getLastHeartbeat, getLastPageOpenAt } from "./browser.js";
import { NETWORKS, loadConfig } from "./config.js";
import type { AppConfig, TronNetwork, SendTrxData, SendTrc20Data, SignMessageData, SignTypedDataData, SignTransactionData, SignerOptions, WaitForTransactionOptions, BroadcastResult, BroadcastStatus } from "./types.js";
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
  private _onWalletChanged: ((reason: string) => void) | null = null;
  private connectedWallet: { address: string; network: TronNetwork } | null = null;
  private broadcastListeners = new Map<string, (info: { txId: string; signedTransaction?: Record<string, unknown> }) => void>();

  set onBrowserDisconnect(cb: (() => void) | null) {
    this._onBrowserDisconnect = cb;
  }

  /**
   * Fires when the user switches account/network or disconnects inside TronLink.
   * All pending requests have already been rejected with "WALLET_CHANGED: <reason>"
   * and the internal connectedWallet cache has been invalidated by the time this
   * callback runs. Reasons: "account" | "network" | "disconnect".
   */
  set onWalletChanged(cb: ((reason: string) => void) | null) {
    this._onWalletChanged = cb;
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
    this.httpServer.onWalletChanged = (reason) => {
      this.connectedWallet = null;
      if (this._onWalletChanged) this._onWalletChanged(reason);
    };
    this.httpServer.onBroadcasted = (id, info) => {
      const listener = this.broadcastListeners.get(id);
      if (listener) listener(info);
    };
  }

  /** Register a listener that fires the moment the browser reports a successful broadcast
   *  (before on-chain confirmation). Auto-removed when `promise` settles. */
  private registerBroadcastListener(
    id: string,
    promise: Promise<unknown>,
    onBroadcasted: (info: { txId: string; signedTransaction: Record<string, unknown> }) => void
  ): void {
    let fired = false;
    this.broadcastListeners.set(id, (info) => {
      if (fired) return;
      fired = true;
      try {
        onBroadcasted({ txId: info.txId, signedTransaction: info.signedTransaction ?? {} });
      } catch {
        /* caller's problem */
      }
    });
    // then(fn, fn) instead of finally(fn): finally preserves the rejection,
    // creating a floating rejected promise on WALLET_CHANGED/timeout. The cleanup
    // here is a side-effect — the original rejection still reaches awaiters.
    const cleanup = () => this.broadcastListeners.delete(id);
    promise.then(cleanup, cleanup);
  }

  async start(): Promise<void> {
    await this.httpServer.start(this.config.httpPort);
    console.error(`HTTP server started on http://127.0.0.1:${this.httpServer.getPort()}`);

    // Emit onBrowserDisconnect on alive→not-alive transition. Cold browser
    // startup (Chrome launching, TronLink service worker waking) can easily
    // take >5s on slower machines, which would falsely flip the watcher to
    // "disconnected" before the first real heartbeat ever arrives. The grace
    // windows (startup + per-openApprovalPage) suppress the transition fire
    // while a real heartbeat is still en route.
    //
    // wasAlive is only set true by a *real* heartbeat — never by grace alone.
    // Otherwise an idle process (daemon mode with no commands yet, MCP server
    // waiting on its first tool call) would record "alive" during grace, then
    // emit a phantom disconnect the moment grace expires.
    const DISCONNECT_TIMEOUT = 5_000;
    const STARTUP_GRACE_MS = 30_000;
    const PAGE_OPEN_GRACE_MS = 15_000;
    const startedAt = Date.now();
    let wasAlive = false;
    this.browserWatchTimer = setInterval(() => {
      const hb = getLastHeartbeat();
      const alive = hb > 0 && Date.now() - hb < DISCONNECT_TIMEOUT;
      const inStartGrace = Date.now() - startedAt < STARTUP_GRACE_MS;
      const lastOpen = getLastPageOpenAt();
      const inOpenGrace = lastOpen > 0 && Date.now() - lastOpen < PAGE_OPEN_GRACE_MS;
      const inGrace = inStartGrace || inOpenGrace;
      if (wasAlive && !alive && !inGrace) {
        this.connectedWallet = null;
        if (this._onBrowserDisconnect) this._onBrowserDisconnect();
        wasAlive = false;
      } else if (alive) {
        wasAlive = true;
      }
    }, 1000);
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

  // Browser only broadcasts and returns { txId, status: 'pending' }. The SDK
  // runs the confirmation poll here so we can use the server-side tronWeb
  // (with TRON-PRO-API-KEY) and so confirmTimeoutMs isn't capped by the
  // pending-store's 5-minute total timeout.
  private async confirmIfNeeded(
    broadcasted: BroadcastResult,
    network: TronNetwork,
    options?: SignerOptions,
  ): Promise<BroadcastResult> {
    if (options?.confirm === false) return broadcasted;
    if (broadcasted.status !== "pending") return broadcasted;
    const outcome = await this.waitForTransaction(broadcasted.txId, network, {
      timeoutMs: options?.confirmTimeoutMs,
      signal: options?.signal,
    });
    return { txId: broadcasted.txId, status: outcome.status, error: outcome.error };
  }

  /** @returns true if the signal was already aborted */
  private attachAbortSignal(id: string, promise: Promise<unknown>, signal?: AbortSignal): boolean {
    if (!signal) return false;
    if (signal.aborted) {
      this.pendingStore.reject(id, "CANCELLED_BY_CALLER");
      return true;
    }
    const onAbort = () => this.pendingStore.reject(id, "CANCELLED_BY_CALLER");
    signal.addEventListener("abort", onAbort, { once: true });
    // then(fn, fn) instead of finally(fn): see registerBroadcastListener.
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    promise.then(cleanup, cleanup);
    return false;
  }

  async connectWallet(network?: TronNetwork, options?: SignerOptions): Promise<{ address: string; network: string }> {
    const net = this.resolveNetwork(network);
    const { id, promise } = this.pendingStore.create("connect", {}, net);
    const cancelled = this.attachAbortSignal(id, promise, options?.signal);
    if (!cancelled) {
      await openApprovalPage(this.getPort(), this.httpServer.getSessionId(), id);
    }
    const result = (await promise) as { address: string; network: string };
    this.connectedWallet = { address: result.address, network: result.network as TronNetwork };
    return result;
  }

  /**
   * Returns the most recently connected wallet (cached in-memory).
   * Cleared when the approval page disconnects (heartbeat timeout).
   * Callers should treat this as a cache, not ground truth — the user may
   * have switched accounts inside TronLink and the SDK has no way to know.
   * To force a fresh read, call connectWallet() instead.
   */
  getConnectedWallet(): { address: string; network: TronNetwork } | null {
    return this.connectedWallet;
  }

  async sendTrx(to: string, amount: string | number, network?: TronNetwork, options?: SignerOptions): Promise<BroadcastResult> {
    const net = this.resolveNetwork(network);
    const data: SendTrxData = { to, amount };
    const { id, promise } = this.pendingStore.create("send_trx", data, net);
    const cancelled = this.attachAbortSignal(id, promise, options?.signal);
    if (options?.onBroadcasted) this.registerBroadcastListener(id, promise, options.onBroadcasted);
    if (!cancelled) {
      await openApprovalPage(this.getPort(), this.httpServer.getSessionId(), id);
    }
    const broadcasted = (await promise) as BroadcastResult;
    return this.confirmIfNeeded(broadcasted, net, options);
  }

  async sendTrc20(
    contractAddress: string,
    to: string,
    amount: string,
    decimals?: number,
    network?: TronNetwork,
    options?: SignerOptions
  ): Promise<BroadcastResult> {
    const net = this.resolveNetwork(network);
    const data: SendTrc20Data = {
      contractAddress,
      to,
      amount,
      decimals,
    };
    const { id, promise } = this.pendingStore.create("send_trc20", data, net);
    const cancelled = this.attachAbortSignal(id, promise, options?.signal);
    if (options?.onBroadcasted) this.registerBroadcastListener(id, promise, options.onBroadcasted);
    if (!cancelled) {
      await openApprovalPage(this.getPort(), this.httpServer.getSessionId(), id);
    }
    const broadcasted = (await promise) as BroadcastResult;
    return this.confirmIfNeeded(broadcasted, net, options);
  }

  async signMessage(message: string, network?: TronNetwork, options?: SignerOptions): Promise<{ signature: string }> {
    const net = this.resolveNetwork(network);
    const data: SignMessageData = { message };
    const { id, promise } = this.pendingStore.create("sign_message", data, net);
    const cancelled = this.attachAbortSignal(id, promise, options?.signal);
    if (!cancelled) {
      await openApprovalPage(this.getPort(), this.httpServer.getSessionId(), id);
    }
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
    const cancelled = this.attachAbortSignal(id, promise, options?.signal);
    if (!cancelled) {
      await openApprovalPage(this.getPort(), this.httpServer.getSessionId(), id);
    }
    const result = (await promise) as { signature: string };
    return result;
  }

  async signTransaction(
    transaction: Record<string, unknown>,
    network?: TronNetwork,
    broadcast?: boolean,
    options?: SignerOptions
  ): Promise<{ signedTransaction: Record<string, unknown>; txId?: string; status?: BroadcastStatus; error?: string }> {
    const net = this.resolveNetwork(network);
    const data: SignTransactionData = {
      transaction,
      broadcast: broadcast ?? false,
    };
    const { id, promise } = this.pendingStore.create("sign_transaction", data, net);
    const cancelled = this.attachAbortSignal(id, promise, options?.signal);
    if (broadcast && options?.onBroadcasted) this.registerBroadcastListener(id, promise, options.onBroadcasted);
    if (!cancelled) {
      await openApprovalPage(this.getPort(), this.httpServer.getSessionId(), id);
    }
    const result = (await promise) as {
      signedTransaction: Record<string, unknown>;
      txId?: string;
      status?: BroadcastStatus;
      error?: string;
    };
    if (!broadcast || !result.txId || !result.status) return result;
    const confirmed = await this.confirmIfNeeded(
      { txId: result.txId, status: result.status, error: result.error },
      net,
      options,
    );
    return { signedTransaction: result.signedTransaction, ...confirmed };
  }

  async getBalance(address: string, network?: TronNetwork): Promise<{ balance: string; balanceSun: number }> {
    const net = this.resolveNetwork(network);
    const tw = this.getTronWebFor(net);
    const balanceSun = await tw.trx.getBalance(address);
    const balance = tw.fromSun(balanceSun).toString();
    return { balance, balanceSun };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getTronWebFor(network: TronNetwork): any {
    if (network === this.config.network) return this.tronWeb;
    const networkConfig = NETWORKS[network];
    const opts: Record<string, unknown> = { fullHost: networkConfig.fullHost };
    if (this.config.apiKey) {
      opts.headers = { "TRON-PRO-API-KEY": this.config.apiKey };
    }
    // @ts-ignore - tronweb constructor typing
    return new TronWeb(opts);
  }

  async waitForTransaction(
    txId: string,
    network?: TronNetwork,
    options?: WaitForTransactionOptions
  ): Promise<{ status: BroadcastStatus; error?: string }> {
    const net = this.resolveNetwork(network);
    const tw = this.getTronWebFor(net);
    const timeoutMs = options?.timeoutMs ?? 30_000;
    const pollIntervalMs = 2000;
    const signal = options?.signal;
    const deadline = Date.now() + timeoutMs;

    const throwIfAborted = () => {
      if (signal?.aborted) throw new Error("CANCELLED_BY_CALLER");
    };

    while (Date.now() < deadline) {
      throwIfAborted();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let info: any;
      try {
        info = await tw.trx.getUnconfirmedTransactionInfo(txId);
      } catch {
        await sleepAbortable(pollIntervalMs, signal);
        continue;
      }

      if (!info || !info.id) {
        await sleepAbortable(pollIntervalMs, signal);
        continue;
      }

      if (info.result === "FAILED") {
        const reason = decodeRevertReason(info.contractResult?.[0]) || info.receipt?.result || "FAILED";
        return { status: "failed", error: reason };
      }

      const receiptResult = info.receipt?.result;
      if (receiptResult && receiptResult !== "SUCCESS") {
        const reason = decodeRevertReason(info.contractResult?.[0]) || receiptResult;
        return { status: "failed", error: reason };
      }

      return { status: "success" };
    }

    return { status: "pending" };
  }
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("CANCELLED_BY_CALLER"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("CANCELLED_BY_CALLER"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Decode the revert payload from contractResult / constant_result. Recognizes
// the two Solidity-emitted forms (Error(string), Panic(uint256)) and falls
// through to a selector + args breakdown for custom errors so callers can
// resolve them externally (4byte.directory or contract ABI). Returns null only
// when the input is empty.
const PANIC_REASONS: Record<number, string> = {
  0x00: "generic compiler panic",
  0x01: "assertion failed",
  0x11: "arithmetic overflow or underflow",
  0x12: "division or modulo by zero",
  0x21: "conversion to invalid enum value",
  0x22: "storage byte array incorrectly encoded",
  0x31: "pop on empty array",
  0x32: "array out-of-bounds access",
  0x41: "memory allocation too large or array too large",
  0x51: "call to invalid internal function",
};

function decodeRevertReason(hex?: string): string | null {
  if (!hex) return null;
  const stripped = (hex.startsWith("0x") ? hex.slice(2) : hex).toLowerCase();
  if (!stripped) return null;

  const selector = stripped.slice(0, 8);
  const args = stripped.slice(8);

  if (selector === "08c379a0" && args.length >= 128) {
    try {
      const length = parseInt(args.slice(64, 128), 16);
      if (Number.isFinite(length) && length > 0) {
        const dataEnd = 128 + length * 2;
        if (dataEnd <= args.length) {
          const decoded = Buffer.from(args.slice(128, dataEnd), "hex").toString("utf8");
          if (decoded) return decoded;
        }
      }
    } catch { /* fall through */ }
    return "Contract reverted";
  }

  if (selector === "4e487b71" && args.length >= 64) {
    const code = parseInt(args.slice(0, 64), 16);
    if (Number.isFinite(code)) {
      const codeStr = `0x${code.toString(16).padStart(2, "0")}`;
      const reason = PANIC_REASONS[code];
      return reason ? `Panic(${codeStr}): ${reason}` : `Panic(${codeStr})`;
    }
  }

  if (selector.length === 8) {
    return args
      ? `Contract reverted with custom error 0x${selector} (args 0x${args})`
      : `Contract reverted with custom error 0x${selector}`;
  }

  return "Contract reverted";
}
