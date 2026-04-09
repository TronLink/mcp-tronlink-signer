import express, { type Express, type Request, type Response } from "express";
import type { Server } from "node:http";
import { PendingStore } from "./pending-store.js";
import { NETWORKS } from "./config.js";

export class HttpServer {
  private app: Express;
  private server: Server | null = null;
  private pendingStore: PendingStore;
  private htmlContent: string;
  private port: number = 0;

  constructor(pendingStore: PendingStore, htmlContent: string) {
    this.pendingStore = pendingStore;
    this.htmlContent = htmlContent;
    this.app = express();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use(express.json());

    this.app.get("/", (_req: Request, res: Response) => {
      res.setHeader("Content-Type", "text/html");
      res.send(this.htmlContent);
    });

    this.app.get("/api/pending/:id", (req: Request, res: Response) => {
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

    this.app.get("/api/health", (_req: Request, res: Response) => {
      res.json({ status: "ok" });
    });

    this.app.get("/api/debug", (_req: Request, res: Response) => {
      res.json({ pendingCount: this.pendingStore.size() });
    });
  }

  getPort(): number {
    return this.port;
  }

  async start(port: number): Promise<void> {
    this.port = port;
    return this._tryListen(port);
  }

  private _tryListen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(port, "127.0.0.1", () => {
          this.port = port;
          console.error(`[HttpServer] Listening on http://127.0.0.1:${port}`);
          resolve();
        });
        this.server.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") {
            const nextPort = port + 1;
            console.error(`[HttpServer] Port ${port} is in use, trying ${nextPort}...`);
            this._tryListen(nextPort).then(resolve, reject);
          } else {
            reject(err);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
