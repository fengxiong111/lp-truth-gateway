export type JsonFetchOptions = { timeoutMs?: number; attempts?: number; retryDelayMs?: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function getJson(url: string, options: JsonFetchOptions = {}): Promise<{ data: any; error: string | null }> {
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 6_000);
  const attempts = Math.max(1, Math.min(3, options.attempts ?? 2));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 180);
  let lastError = "FETCH_FAILED";

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "lp-truth-gateway/1.5" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.status === 429 || r.status >= 500) {
        lastError = `HTTP_${r.status}`;
        if (attempt + 1 < attempts) {
          await sleep(retryDelayMs * (attempt + 1));
          continue;
        }
        return { data: null, error: lastError };
      }
      if (!r.ok) return { data: null, error: `HTTP_${r.status}` };
      return { data: await r.json(), error: null };
    } catch (e) {
      lastError = e instanceof Error ? e.message : "FETCH_FAILED";
      if (attempt + 1 < attempts) await sleep(retryDelayMs * (attempt + 1));
    }
  }
  return { data: null, error: lastError };
}

export const n = (x: unknown): number | null => {
  const v = typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : NaN;
  return Number.isFinite(v) ? v : null;
};
