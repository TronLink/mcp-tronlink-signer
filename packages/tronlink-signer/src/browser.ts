import open from "open";

let pageOpened = false;
let lastHeartbeat = 0;
let lastPageOpenAt = 0;

const HEARTBEAT_TIMEOUT = 5_000;

export function recordHeartbeat(): void {
  lastHeartbeat = Date.now();
}

export function getLastHeartbeat(): number {
  return lastHeartbeat;
}

export function getLastPageOpenAt(): number {
  return lastPageOpenAt;
}

export function isPageAlive(): boolean {
  if (!pageOpened) return false;
  if (lastHeartbeat === 0) return false;
  return Date.now() - lastHeartbeat < HEARTBEAT_TIMEOUT;
}

export async function openApprovalPage(
  port: number,
  sessionId: string,
  _requestId: string
): Promise<void> {
  // Per-process token in the query so `open(url)` differs across process
  // restarts: same process always opens/focuses the same tab; a new process
  // (new sessionId) opens a fresh tab instead of focusing a dead old one.
  // The token is informational — auth still goes via the x-session-id header.
  const url = `http://127.0.0.1:${port}/?s=${encodeURIComponent(sessionId)}`;
  if (isPageAlive()) {
    return;
  }
  pageOpened = true;
  lastHeartbeat = Date.now();
  lastPageOpenAt = Date.now();
  await open(url);
}
