import { getJson, n } from "./http.js";
import type { Ohlcv, PoolCandidate, SourceStatus } from "./schema.js";

const now = () => new Date().toISOString();
const lower = (value: unknown) => typeof value === "string" ? value.toLowerCase() : null;

export async function fetchDex(address: string): Promise<{ candidates: PoolCandidate[]; status: SourceStatus }> {
  const r = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
  const pairs = Array.isArray(r.data?.pairs) ? r.data.pairs : [];
  const token = address.toLowerCase();
  const candidates = pairs.map((p: any) => {
    const baseAddress = lower(p.baseToken?.address);
    const quoteAddress = lower(p.quoteToken?.address);
    const basePriceUsd = n(p.priceUsd);
    const basePriceInQuote = n(p.priceNative);
    const queriedTokenSide: "base" | "quote" | null = baseAddress === token ? "base" : quoteAddress === token ? "quote" : null;
    const normalizedPriceUsd = queriedTokenSide === "base"
      ? basePriceUsd
      : queriedTokenSide === "quote" && basePriceUsd !== null && basePriceInQuote !== null && basePriceInQuote > 0
        ? basePriceUsd / basePriceInQuote
        : null;
    return {
      chainId: p.chainId ?? null,
      dexId: p.dexId ?? null,
      poolAddress: p.pairAddress,
      baseAddress,
      quoteAddress,
      baseSymbol: p.baseToken?.symbol ?? null,
      quoteSymbol: p.quoteToken?.symbol ?? null,
      queriedTokenSide,
      priceUsd: normalizedPriceUsd,
      volume24hUsd: n(p.volume?.h24),
      liquidityUsd: n(p.liquidity?.usd),
      feeTier: null,
      grossFee24hUsd: null,
      feeVelocity24h: null,
      capacityAdjustedFeeVelocity24h: null,
      poolAgeDays: n(p.pairCreatedAt) ? (Date.now() - Number(p.pairCreatedAt)) / 86400000 : null,
      source: "dexscreener",
    } satisfies PoolCandidate;
  }).filter((p: PoolCandidate) => typeof p.poolAddress === "string" && p.queriedTokenSide !== null);

  return {
    candidates,
    status: {
      source: "dexscreener",
      status: candidates.length ? "READY" : "BLOCKED",
      fetchedAt: now(),
      failureState: candidates.length ? null : "BLOCKED_DATA",
      error: candidates.length ? null : (r.error ?? "NO_POOL"),
    },
  };
}

const rows = (x: any): Ohlcv[] => {
  const a = x?.data?.attributes?.ohlcv_list;
  return Array.isArray(a)
    ? a.map((v: any) => ({
        timestamp: Number(v[0]),
        open: n(v[1]) ?? 0,
        high: n(v[2]) ?? 0,
        low: n(v[3]) ?? 0,
        close: n(v[4]) ?? 0,
        volumeUsd: n(v[5]) ?? 0,
      })).filter((v: Ohlcv) => v.timestamp > 0 && v.high > 0)
    : [];
};

export async function fetchOhlcv(pool: PoolCandidate, aggregate: number, limit: number): Promise<{ rows: Ohlcv[]; status: SourceStatus }> {
  const r = await getJson(`https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(pool.chainId ?? "")}/pools/${pool.poolAddress}/ohlcv/hour?aggregate=${aggregate}&limit=${limit}`);
  const out = rows(r.data);
  return {
    rows: out,
    status: {
      source: "geckoterminal",
      status: out.length ? "READY" : "BLOCKED",
      fetchedAt: now(),
      failureState: out.length ? null : (r.error ? "BLOCKED_EXECUTION" : "BLOCKED_EVIDENCE"),
      error: out.length ? null : (r.error ?? "NO_OHLCV"),
    },
  };
}

export async function fetchPaprikaOhlcv(pool: PoolCandidate, interval: "5m" | "30m" | "1h" | "24h", days: number): Promise<{ rows: Ohlcv[]; status: SourceStatus }> {
  const end = new Date(Math.floor(Date.now() / 3600000) * 3600000);
  const start = new Date(end.getTime() - days * 86400000);
  const limit = interval === "5m" ? 300 : interval === "30m" ? 100 : 200;
  const r = await getJson(`https://api.dexpaprika.com/networks/${encodeURIComponent(pool.chainId ?? "")}/pools/${pool.poolAddress.toLowerCase()}/ohlcv?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}&interval=${interval}&limit=${limit}`);
  const a = Array.isArray(r.data) ? r.data : [];
  const out = a.map((v: any) => ({
    timestamp: Date.parse(v.time_open) / 1000,
    open: n(v.open) ?? 0,
    high: n(v.high) ?? 0,
    low: n(v.low) ?? 0,
    close: n(v.close) ?? 0,
    volumeUsd: n(v.volume) ?? 0,
  })).filter((v: Ohlcv) => v.timestamp > 0 && v.high > 0);
  return {
    rows: out,
    status: {
      source: "dexpaprika",
      status: out.length ? "READY" : "BLOCKED",
      fetchedAt: now(),
      failureState: out.length ? null : (r.error ? "BLOCKED_EXECUTION" : "BLOCKED_EVIDENCE"),
      error: out.length ? null : (r.error ?? "NO_OHLCV"),
    },
  };
}
