import type { AnalyzerFrameTableWindow } from "./api.ts";

// Keep this aligned with MAX_ANALYZER_TABLE_WINDOW_ROWS in sigpilot-graph.
export const ANALYZER_TABLE_PAGE_SIZE = 1_024;

interface WindowRequest<T> {
  key: string;
  run: () => Promise<T>;
  accept: (result: T) => void;
  reject: (error: unknown) => void;
}

/** One active IPC request and one replaceable pending request for the panel. */
export class AnalyzerTableRequestQueue<T> {
  private active: WindowRequest<T> | null = null;
  private pending: WindowRequest<T> | null = null;
  private desiredKey: string | null = null;

  request(request: WindowRequest<T>) {
    this.desiredKey = request.key;
    if (this.active) {
      this.pending = this.active.key === request.key ? null : request;
      return;
    }
    this.start(request);
  }

  // An already-issued IPC call cannot be cancelled, but its result must not
  // update a different session or restart work after the panel unmounts.
  clear() {
    this.desiredKey = null;
    this.pending = null;
  }

  private start(request: WindowRequest<T>) {
    this.active = request;
    void Promise.resolve()
      .then(request.run)
      .then((result) => {
        if (this.desiredKey === request.key) request.accept(result);
      })
      .catch((error: unknown) => {
        if (this.desiredKey === request.key) request.reject(error);
      })
      .finally(() => {
        this.active = null;
        const next = this.pending;
        this.pending = null;
        if (next) this.start(next);
      });
  }
}

/** Copy/export consumes bounded pages instead of requesting all frame objects. */
export async function visitAnalyzerTablePages(
  fetch: (start: number, end: number) => Promise<AnalyzerFrameTableWindow>,
  visit: (page: AnalyzerFrameTableWindow) => void,
) {
  let start = 0;
  let total: number | null = null;
  do {
    const page = await fetch(start, Math.min(total ?? Infinity, start + ANALYZER_TABLE_PAGE_SIZE));
    // Snapshot the count on the first page so an ongoing decode cannot make
    // copying chase a growing tail forever.
    total = Math.min(total ?? page.row_count, page.row_count);
    if (page.rows.length === 0 && start < total) {
      throw new Error("Analyzer results changed while copying; please retry.");
    }
    visit(page);
    start += page.rows.length;
  } while (start < total);
}
