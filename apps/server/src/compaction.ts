import { completeStored } from "./after-commit.ts";
import type { EventHub } from "./event-hub.ts";
import express from "express";
import type { OrgToolName, RuntimeAdapter } from "@babojubot/contracts";
import {
  claimCompaction,
  compactionLeaseActive,
  finishCompaction,
  listCompactionCandidates,
  recoverCompactions,
  type Database,
} from "@babojubot/db";
import type { RunDispatcher } from "./dispatcher.ts";
import { issueRunToken, digestRunToken } from "./run-token.ts";
import { mcpRoutes } from "./mcp.ts";

/** Maintenance has a separate, list-only credential and never creates a Run or Event. */
export class CompactionScheduler {
  readonly tokens = new Map<string, { id: string; tools: OrgToolName[] }>();
  readonly controllers = new Map<string, AbortController>();
  private running: Promise<void> | undefined;
  private jobs = new Set<Promise<void>>();
  private settlements = new Map<
    string,
    {
      ok: boolean;
      nextSession: import("@babojubot/contracts").SessionState | null;
    }
  >();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private readonly options: {
    db: Database;
    providers: ReadonlyMap<string, RuntimeAdapter>;
    dispatcher: RunDispatcher;
    hub: EventHub;
    now: () => Date;
    url: () => string;
  };
  constructor(options: CompactionScheduler["options"]) {
    this.options = options;
  }
  router() {
    const router = express.Router();
    router.use(async (req, res, next) => {
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
      const entry = token && this.tokens.get(digestRunToken(token));
      if (!entry) return next("router");
      if (
        req.path !== "/mcp" ||
        !(await compactionLeaseActive(this.options.db, entry.id))
      ) {
        res.status(403).json({ error: { code: "forbidden" } });
        return;
      }
      // Only mcpRoutes consumes this identity; dispatch below always refuses.
      res.locals.run = { id: entry.id };
      next();
    });
    mcpRoutes(
      router,
      async () => ({ status: 403, value: { error: { code: "forbidden" } } }),
      async (run) =>
        [...this.tokens.values()].find((entry) => entry.id === run.id)?.tools ??
        []
    );
    return router;
  }
  async recover() {
    await recoverCompactions(this.options.db);
  }
  start() {
    this.timer = setInterval(() => void this.scan(), 1000);
    this.timer.unref();
  }
  async tick() {
    await this.scan();
    await Promise.all([...this.jobs]);
    await this.settle();
  }
  private async scan() {
    while (this.running) await this.running;
    if (this.closed) return;
    this.running = this.sweep();
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }
  private async sweep() {
    const { db, providers, now } = this.options;
    const supported = [...providers]
      .filter(
        ([, adapter]) => adapter.capabilities.precompact && adapter.precompact
      )
      .map(([id]) => id);
    if (!supported.length) return;
    try {
      await this.settle();
      for (const candidate of await listCompactionCandidates(db)) {
        if (this.closed) return;
        const lease = await claimCompaction(db, candidate, now(), supported);
        if (!lease) continue;
        if (this.closed) {
          this.settlements.set(lease.id, { ok: false, nextSession: null });
          await this.settle();
          return;
        }
        const job = this.execute(lease).finally(() => this.jobs.delete(job));
        this.jobs.add(job);
      }
    } catch (error) {
      console.error("[compaction] maintenance failed", error);
    }
  }
  private async execute(
    lease: NonNullable<Awaited<ReturnType<typeof claimCompaction>>>
  ) {
    const { db, providers, url } = this.options;
    const { token, digest } = issueRunToken(),
      controller = new AbortController();
    this.tokens.set(digest, { id: lease.id, tools: lease.tools });
    this.controllers.set(lease.id, controller);
    const check = setInterval(() => {
      void compactionLeaseActive(db, lease.id)
        .then((active) => {
          if (!active) controller.abort();
        })
        .catch(() => controller.abort());
    }, 250);
    let result: { ok: boolean; nextSession: typeof lease.session | null } = {
      ok: false,
      nextSession: null,
    };
    try {
      result = await providers.get(lease.provider)!.precompact!(
        { session: lease.session, access: { toolsBaseUrl: url(), token } },
        controller.signal
      );
    } catch {
      /* Provider failures remain private and do not become Run activity. */
    } finally {
      clearInterval(check);
      this.tokens.delete(digest);
      this.controllers.delete(lease.id);
    }
    this.settlements.set(lease.id, result);
    await this.settle();
  }
  private settling: Promise<void> | undefined;
  private async settle() {
    while (this.settling) await this.settling;
    this.settling = (async () => {
      for (const [id, result] of this.settlements) {
        try {
          const stored = await finishCompaction(this.options.db, id, result);
          this.settlements.delete(id);
          if (!this.closed && stored)
            await completeStored(this.options, stored);
        } catch {
          console.error(
            "[compaction] settlement failed; will retry without sending compact again"
          );
        }
      }
    })();
    try {
      await this.settling;
    } finally {
      this.settling = undefined;
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const controller of this.controllers.values()) controller.abort();
    while (this.running) await this.running;
    await Promise.all([...this.jobs]);
    await this.settle();
  }
}
