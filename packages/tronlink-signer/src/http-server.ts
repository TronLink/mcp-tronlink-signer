import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { PendingStore } from "./pending-store.js";
import { NETWORKS } from "./config.js";
import { recordHeartbeat } from "./browser.js";

const CSP =
  "default-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "connect-src *; " +
  "frame-ancestors 'none';";

export class HttpServer {
  private app: Express;
  private server: Server | null = null;
  private pendingStore: PendingStore;
  private htmlContent: string;
  private jsFiles: Record<string, string>;
  private port: number = 0;
  private sessionId: string;
  public onWalletChanged: ((reason: string) => void) | null = null;
  public onBroadcasted: ((id: string, info: { txId: string; signedTransaction?: Record<string, unknown> }) => void) | null = null;

  constructor(pendingStore: PendingStore, htmlContent: string, jsFiles: Record<string, string> = {}) {
    this.pendingStore = pendingStore;
    this.htmlContent = htmlContent;
    this.jsFiles = jsFiles;
    this.sessionId = randomUUID();
    this.app = express();
    this.setupRoutes();
  }

  // Defense against DNS rebinding + cross-origin CSRF: reject any request whose
  // Host header isn't our loopback binding. For state-changing methods (POST/
  // PUT/DELETE/PATCH) we also require Origin/Referer to be present AND match —
  // browsers always send one of those on cross-origin writes, so a missing
  // header means the caller isn't a browser in good standing (e.g. curl from
  // another local process trying to forge a request).
  private originGuard = (req: Request, res: Response, next: NextFunction): void => {
    const allowedHosts = new Set([
      `127.0.0.1:${this.port}`,
      `localhost:${this.port}`,
    ]);
    const host = req.headers.host || "";
    if (!allowedHosts.has(host)) {
      res.status(403).json({ error: "Forbidden host" });
      return;
    }
    const originHeader = (req.headers.origin || req.headers.referer || "") as string;
    const isWrite = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
    if (isWrite && !originHeader) {
      res.status(403).json({ error: "Origin required" });
      return;
    }
    if (originHeader) {
      const ok =
        originHeader === `http://127.0.0.1:${this.port}` ||
        originHeader === `http://localhost:${this.port}` ||
        originHeader.startsWith(`http://127.0.0.1:${this.port}/`) ||
        originHeader.startsWith(`http://localhost:${this.port}/`);
      if (!ok) {
        res.status(403).json({ error: "Forbidden origin" });
        return;
      }
    }
    next();
  };

  // The sessionId travels in the x-session-id header on every sensitive
  // request. It is injected into the HTML page server-side (template
  // substitution) and is never exposed via a GET endpoint — otherwise any
  // local process could read it and forge approvals.
  private requireSession(req: Request, res: Response): boolean {
    const clientSession = req.headers["x-session-id"];
    if (clientSession !== this.sessionId) {
      res.status(410).json({ error: "Session expired" });
      return false;
    }
    return true;
  }

  private setupRoutes(): void {
    this.app.use(express.json());
    this.app.use(this.originGuard);

    this.app.get("/", (_req: Request, res: Response) => {
      res.setHeader("Content-Type", "text/html");
      res.setHeader("Content-Security-Policy", CSP);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      // Inject sessionId into the HTML so only this page (same origin, same
      // pageload) can read it. sessionId is a randomUUID — no escaping needed.
      res.send(this.htmlContent.replaceAll("{{SESSION_ID}}", this.sessionId));
    });

    this.app.get("/js/:name", (req: Request, res: Response) => {
      const content = this.jsFiles[req.params.name as string];
      if (!content) {
        res.status(404).send("Not found");
        return;
      }
      res.setHeader("Content-Type", "application/javascript");
      res.send(content);
    });

    this.app.get("/api/pending", (req: Request, res: Response) => {
      if (!this.requireSession(req, res)) return;
      const all = this.pendingStore.getAll();
      res.json({
        requests: all.map((r) => ({ ...r, networkConfig: NETWORKS[r.network] })),
      });
    });

    this.app.get("/api/pending/next", (req: Request, res: Response) => {
      if (!this.requireSession(req, res)) return;
      const next = this.pendingStore.getNext();
      if (!next) {
        res.status(404).json({ error: "No pending request" });
        return;
      }
      res.json({
        ...next,
        networkConfig: NETWORKS[next.network],
      });
    });

    this.app.get("/api/pending/:id", (req: Request, res: Response) => {
      if (!this.requireSession(req, res)) return;
      const request = this.pendingStore.get(req.params.id as string);
      if (!request) {
        res.status(404).json({ error: "Request not found or expired" });
        return;
      }
      res.json({
        ...request,
        networkConfig: NETWORKS[request.network],
      });
    });

    this.app.post("/api/complete/:id", (req: Request, res: Response) => {
      if (!this.requireSession(req, res)) return;
      const id = req.params.id as string;
      const { success, result, error } = req.body;

      if (success) {
        const resolved = this.pendingStore.resolve(id, result);
        if (!resolved) {
          res.status(404).json({ error: "Request not found or expired" });
          return;
        }
        res.json({ ok: true });
      } else {
        const rejected = this.pendingStore.reject(id, error || "USER_REJECTED");
        if (!rejected) {
          res.status(404).json({ error: "Request not found or expired" });
          return;
        }
        res.json({ ok: true });
      }
    });

    this.app.post("/api/heartbeat", (req: Request, res: Response) => {
      if (!this.requireSession(req, res)) return;
      recordHeartbeat();
      res.json({ ok: true });
    });

    this.app.post("/api/broadcasted/:id", (req: Request, res: Response) => {
      if (!this.requireSession(req, res)) return;
      const id = req.params.id as string;
      const txId = typeof req.body?.txId === "string" ? req.body.txId : null;
      if (!txId) {
        res.status(400).json({ error: "txId required" });
        return;
      }
      const signedTransaction = req.body?.signedTransaction && typeof req.body.signedTransaction === "object"
        ? (req.body.signedTransaction as Record<string, unknown>)
        : undefined;
      if (this.onBroadcasted) this.onBroadcasted(id, { txId, signedTransaction });
      res.json({ ok: true });
    });

    this.app.post("/api/wallet-changed", (req: Request, res: Response) => {
      if (!this.requireSession(req, res)) return;
      const reason = (req.body && typeof req.body.reason === "string" ? req.body.reason : "changed") as string;
      this.pendingStore.clearAll(`WALLET_CHANGED: ${reason}`);
      if (this.onWalletChanged) this.onWalletChanged(reason);
      res.json({ ok: true });
    });

    this.app.get("/api/health", (_req: Request, res: Response) => {
      res.json({ status: "ok" });
    });

    this.app.get("/api/debug", (req: Request, res: Response) => {
      if (!this.requireSession(req, res)) return;
      res.json({ pendingCount: this.pendingStore.size() });
    });
  }

  getPort(): number {
    return this.port;
  }

  async start(port: number): Promise<void> {
    return this._tryListen(port);
  }

  private _tryListen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = this.app.listen(port, "127.0.0.1");
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeAllListeners();
        server.close();
        if (err.code === "EADDRINUSE") {
          const nextPort = port + 1;
          console.error(`[HttpServer] Port ${port} is in use, trying ${nextPort}...`);
          this._tryListen(nextPort).then(resolve, reject);
        } else {
          reject(err);
        }
      };
      server.once("error", onError);
      server.once("listening", () => {
        server.removeListener("error", onError);
        this.server = server;
        this.port = port;
        console.error(`[HttpServer] Listening on http://127.0.0.1:${port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      // The signer page holds HTTP keep-alive sockets (1s heartbeat + 1s poll).
      // server.close() only stops accepting new connections — existing idle
      // sockets keep the loop alive until TCP keep-alive times out, so the
      // SIGINT handler never reaches process.exit() and the host escalates
      // to SIGTERM. Force them closed so close() can settle.
      this.server.closeIdleConnections?.();
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }
}
