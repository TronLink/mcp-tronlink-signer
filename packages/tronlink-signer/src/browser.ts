import open from "open";

let pageOpened = false;
let lastHeartbeat = 0;

const HEARTBEAT_TIMEOUT = 6_000; // 2s heartbeat × 3 misses = page closed

export function recordHeartbeat(): void {
  lastHeartbeat = Date.now();
}

export function getLastHeartbeat(): number {
  return lastHeartbeat;
}

export function isPageAlive(): boolean {
  if (!pageOpened) return false;
  if (lastHeartbeat === 0) return false;
  return Date.now() - lastHeartbeat < HEARTBEAT_TIMEOUT;
}

export async function openApprovalPage(
  port: number,
  _requestId: string
): Promise<void> {
  const url = `http://127.0.0.1:${port}/`;
  if (isPageAlive()) {
    // Page is still open, it will pick up the new request via polling
    return;
  }
  pageOpened = true;
  lastHeartbeat = Date.now();
  await open(url);
}
