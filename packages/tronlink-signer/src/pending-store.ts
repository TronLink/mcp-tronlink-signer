import { randomUUID } from "node:crypto";
import { REQUEST_TIMEOUT_MS } from "./config.js";
import type { PendingRequest, PendingRequestType, TronNetwork } from "./types.js";

interface PendingEntry<T = unknown> {
  request: PendingRequest<T>;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PendingStore {
  private pending = new Map<string, PendingEntry>();

  create<T>(type: PendingRequestType, data: T, network: TronNetwork): { id: string; promise: Promise<unknown> } {
    const id = randomUUID();
    const request: PendingRequest<T> = {
      id,
      type,
      data,
      network,
      createdAt: Date.now(),
    };

    let resolve!: (result: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error("TIMEOUT: Request timed out after 5 minutes"));
    }, REQUEST_TIMEOUT_MS);

    this.pending.set(id, { request, resolve, reject, timer });
    console.error(`[PendingStore] Created request: ${id}, type: ${type}, total pending: ${this.pending.size}`);

    return { id, promise };
  }

  get(id: string): PendingRequest | undefined {
    const entry = this.pending.get(id);
    return entry?.request;
  }

  resolve(id: string, result: unknown): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(result);
    return true;
  }

  reject(id: string, error: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.reject(new Error(error));
    return true;
  }

  getNext(): PendingRequest | undefined {
    let oldest: PendingEntry | undefined;
    for (const entry of this.pending.values()) {
      if (!oldest || entry.request.createdAt < oldest.request.createdAt) {
        oldest = entry;
      }
    }
    return oldest?.request;
  }

  getAll(): PendingRequest[] {
    const arr: PendingRequest[] = [];
    for (const entry of this.pending.values()) arr.push(entry.request);
    arr.sort((a, b) => a.createdAt - b.createdAt);
    return arr;
  }

  size(): number {
    return this.pending.size;
  }

  clear(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Store cleared"));
    }
    this.pending.clear();
  }

  clearAll(reason: string): void {
    const count = this.pending.size;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
    if (count > 0) {
      console.error(`[PendingStore] Cleared ${count} pending request(s): ${reason}`);
    }
  }
}
