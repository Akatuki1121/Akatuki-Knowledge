// PushScheduler holds every timing and retry rule of the plugin, with no
// Obsidian dependency, so the rules can be tested outside Obsidian.
//
// - A change starts (or restarts) a per-path debounce timer. Only when the
//   editing settles for the whole debounce window is the note read and sent.
// - A note whose content hash equals the last hash the server accepted is
//   not sent again. This also stops the echo of Akatuki Knowledge writing a
//   note back into the vault: that content is already what D1 holds.
// - Temporary failures (network errors, 429, 5xx) are retried with the
//   configured delays and then dropped; the hourly pull remains the safety
//   net, so nothing is queued without bound. Other failures (401 and the
//   rest of 4xx) are not retried.
// - A "deferred" or "needs_review" answer is final for that edit. The hash
//   is not recorded, so the next edit of the same note sends again.

export type PushOutcome = "applied" | "unchanged" | "deferred" | "needs_review";

export interface PushResponse {
  status: number;
  body: { ok?: boolean; result?: string; reason?: string | null } | null;
}

export interface SchedulerDeps {
  debounceMs: number;
  retryDelaysMs: number[];
  readContent: (path: string) => Promise<string>;
  hashContent: (content: string) => Promise<string>;
  send: (path: string, content: string, contentHash: string) => Promise<PushResponse>;
  onSettled?: (path: string, outcome: PushOutcome, reason: string | null) => void;
  onFailed?: (path: string, status: number | null) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class PushScheduler {
  private readonly deps: SchedulerDeps;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly timers = new Map<string, unknown>();
  private readonly lastAcceptedHash = new Map<string, string>();
  private readonly inFlight = new Set<string>();
  private readonly queuedAgain = new Set<string>();

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  notifyChanged(path: string): void {
    const existing = this.timers.get(path);
    if (existing !== undefined) this.clearTimer(existing);
    const handle = this.setTimer(() => {
      this.timers.delete(path);
      void this.flush(path);
    }, this.deps.debounceMs);
    this.timers.set(path, handle);
  }

  dispose(): void {
    for (const handle of this.timers.values()) this.clearTimer(handle);
    this.timers.clear();
  }

  private async flush(path: string): Promise<void> {
    if (this.inFlight.has(path)) {
      // A send for this path is still running. Run once more after it, so a
      // change made during the send is not lost.
      this.queuedAgain.add(path);
      return;
    }
    this.inFlight.add(path);
    try {
      const content = await this.deps.readContent(path);
      const contentHash = await this.deps.hashContent(content);
      if (this.lastAcceptedHash.get(path) === contentHash) return;
      await this.sendWithRetry(path, content, contentHash);
    } catch {
      this.deps.onFailed?.(path, null);
    } finally {
      this.inFlight.delete(path);
      if (this.queuedAgain.delete(path)) this.notifyChanged(path);
    }
  }

  private async sendWithRetry(path: string, content: string, contentHash: string): Promise<void> {
    const delays = this.deps.retryDelaysMs;
    for (let attempt = 0; ; attempt++) {
      let response: PushResponse | null = null;
      let retryable = false;
      try {
        response = await this.deps.send(path, content, contentHash);
      } catch {
        retryable = true;
      }
      if (response !== null) {
        if (response.status === 200 && response.body?.ok === true
          && (response.body.result === "applied" || response.body.result === "unchanged"
            || response.body.result === "deferred" || response.body.result === "needs_review")) {
          const outcome = response.body.result as PushOutcome;
          if (outcome === "applied" || outcome === "unchanged") {
            this.lastAcceptedHash.set(path, contentHash);
          }
          this.deps.onSettled?.(path, outcome, response.body.reason ?? null);
          return;
        }
        retryable = response.status === 429 || response.status >= 500;
        if (!retryable) {
          this.deps.onFailed?.(path, response.status);
          return;
        }
      }
      if (attempt >= delays.length) {
        this.deps.onFailed?.(path, response ? response.status : null);
        return;
      }
      await new Promise<void>((resolve) => {
        this.setTimer(resolve, delays[attempt]);
      });
    }
  }
}
