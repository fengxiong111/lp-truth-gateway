import { fetchUniswapV3State } from "./onchain.js";
import { fetchDex, fetchOhlcv, fetchPaprikaOhlcv } from "./sources.js";
import type { Ohlcv, PoolCandidate, SourceStatus, TruthArtifact } from "./schema.js";

const now = () => new Date().toISOString();
const max = (a: Ohlcv[]) => a.length ? Math.max(...a.map((x) => x.high)) : null;
const min = (a: Ohlcv[]) => a.length ? Math.min(...a.map((x) => x.low)) : null;
const sum = (a: Ohlcv[]) => a.length ? a.reduce((s, x) => s + x.volumeUsd, 0) : null;
const lower = (x: string | null) => x?.toLowerCase() ?? null;

function comparablePriceConflicts(candidates: PoolCandidate[], selected: PoolCandidate | null): string[] {
  if (!selected?.priceUsd || selected.priceUsd <= 0) return [];
  const reference = selected.priceUsd;
  const selectedLiquidity = selected.liquidityUsd ?? 0;
  const liquidityFloor = Math.max(25_000, selectedLiquidity * 0.01);
  return candidates
    .filter((p) => p.poolAddress.toLowerCase() !== selected.poolAddress.toLowerCase())
    .filter((p) => lower(p.chainId) === lower(selected.chainId))
    .filter((p) => p.priceUsd !== null && p.priceUsd > 0)
    .filter((p) => (p.liquidityUsd ?? 0) >= liquidityFloor || (p.volume24hUsd ?? 0) >= 100_000)
    .filter((p) => Math.abs((p.priceUsd as number) - reference) / reference > 0.05)
    .map((p) => `USD_PRICE_CONFLICT:${p.poolAddress}:${p.priceUsd}`);
}

async function selectVerifiedPool(candidates: PoolCandidate[]): Promise<{
  selected: PoolCandidate | null;
  onchain: TruthArtifact["onchainPool"];
  statuses: SourceStatus[];
}> {
  let lastStatuses: SourceStatus[] = [];
  const eligible = candidates
    .filter((p) => lower(p.chainId) === "robinhood" || p.chainId === "4663" || lower(p.chainId) === "robinhood-chain")
    .filter((p) => lower(p.dexId)?.includes("uniswap"))
    .slice(0, 6);

  for (const candidate of eligible) {
    const proof = await fetchUniswapV3State(candidate);
    lastStatuses = proof.statuses;
    if (proof.state?.canonical) {
      return {
        selected: { ...candidate, feeTier: proof.state.feeTier },
        onchain: {
          chainId: proof.state.chainId,
          poolAddress: proof.state.poolAddress,
          factory: proof.state.factory,
          token0: proof.state.token0,
          token1: proof.state.token1,
          feeTier: proof.state.feeTier,
          tickSpacing: proof.state.tickSpacing,
          currentTick: proof.state.currentTick,
          sqrtPriceX96: proof.state.sqrtPriceX96,
          activeLiquidityRaw: proof.state.activeLiquidityRaw,
          canonical: proof.state.canonical,
        },
        statuses: proof.statuses,
      };
    }
  }

  return { selected: candidates[0] ?? null, onchain: null, statuses: lastStatuses.length ? lastStatuses : [
    { source: "rpc", status: "BLOCKED", fetchedAt: now(), failureState: "BLOCKED_DATA", error: "NO_SUPPORTED_ONCHAIN_POOL" },
    { source: "uniswap", status: "BLOCKED", fetchedAt: now(), failureState: "BLOCKED_EVIDENCE", error: "NO_CANONICAL_V3_POOL_PROOF" },
  ] };
}

export async function buildTruth(address: string): Promise<TruthArtifact> {
  const d = await fetchDex(address);
  const candidates = d.candidates.sort((a, b) => {
    const liquidityDelta = (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1);
    return liquidityDelta !== 0 ? liquidityDelta : (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1);
  });

  const verified = await selectVerifiedPool(candidates);
  const selected = verified.selected;
  const statuses: SourceStatus[] = [
    d.status,
    ...verified.statuses,
    { source: "okx", status: "BLOCKED", fetchedAt: now(), failureState: "BLOCKED_AUTH", error: "API_KEY_NOT_CONFIGURED" },
    { source: "revert", status: "BLOCKED", fetchedAt: now(), failureState: "BLOCKED_AUTH", error: "OPTIONAL_ADAPTER_NOT_CONFIGURED" },
    { source: "vfat", status: "BLOCKED", fetchedAt: now(), failureState: "BLOCKED_AUTH", error: "OPTIONAL_ADAPTER_NOT_CONFIGURED" },
  ];

  let h1: Ohlcv[] = [];
  let h24: Ohlcv[] = [];
  let h7: Ohlcv[] = [];
  let daily: Ohlcv[] = [];
  let historyReady = false;

  if (selected) {
    const [a, b, c, e] = await Promise.all([
      fetchPaprikaOhlcv(selected, "5m", 1),
      fetchPaprikaOhlcv(selected, "30m", 1),
      fetchPaprikaOhlcv(selected, "1h", 7),
      fetchPaprikaOhlcv(selected, "24h", 7),
    ]);
    h1 = a.rows;
    h24 = b.rows;
    h7 = c.rows;
    daily = e.rows;
    const paprika = [a, b, c, e].find((x) => x.rows.length)?.status ?? [a, b, c, e].find((x) => x.status.status === "BLOCKED")?.status;
    if (paprika) statuses.push(paprika);
    historyReady = h7.length > 0 && paprika?.status === "READY";

    if (!historyReady) {
      const [ga, gb, gc, gd] = await Promise.all([
        fetchOhlcv(selected, 5, 12),
        fetchOhlcv(selected, 30, 48),
        fetchOhlcv(selected, 60, 168),
        fetchOhlcv(selected, 1440, 10),
      ]);
      const gecko = [ga, gb, gc, gd].find((x) => x.rows.length)?.status ?? [ga, gb, gc, gd].find((x) => x.status.status === "BLOCKED")?.status;
      if (gecko) statuses.push(gecko);
      if (gc.rows.length) h7 = gc.rows;
      if (gd.rows.length) daily = gd.rows;
      if (ga.rows.length) h1 = ga.rows;
      if (gb.rows.length) h24 = gb.rows;
      historyReady = h7.length > 0 && gecko?.status === "READY";
    }
  }

  const price = selected?.priceUsd ?? (h7.at(-1)?.close ?? null);
  const conflicts = comparablePriceConflicts(candidates, selected);
  const latestHistoryTs = h7.length ? Math.max(...h7.map((x) => x.timestamp)) : null;
  const fresh = latestHistoryTs === null ? null : Math.max(0, Math.floor(Date.now() / 1000 - latestHistoryTs));
  const wick = h7.some((x) => x.high > Math.max(x.open, x.close) * 1.25 || x.low < Math.min(x.open, x.close) * 0.75);
  const onchainReady = Boolean(
    verified.onchain?.canonical &&
    verified.onchain.feeTier > 0 &&
    Number.isFinite(verified.onchain.currentTick) &&
    BigInt(verified.onchain.activeLiquidityRaw) > 0n,
  );
  const marketReady = d.status.status === "READY";
  const grade: "A" | "B" | "C" | "D" = marketReady && historyReady && onchainReady && conflicts.length === 0 ? "B" : marketReady && historyReady ? "C" : marketReady ? "C" : "D";

  return {
    schemaVersion: "lp-truth-v1",
    request: { tokenAddress: address },
    timestamp: now(),
    selectedPool: selected,
    poolCandidates: candidates,
    onchainPool: verified.onchain,
    market: {
      priceUsd: price,
      high24hUsd: max(h24),
      low24hUsd: min(h24),
      high7dUsd: max(h7),
      low7dUsd: min(h7),
      volume5mUsd: sum(h1.slice(-1)),
      volume30mUsd: sum(h24.slice(-1)),
      volume1hUsd: sum(h7.slice(-1)),
      volume24hUsd: selected?.volume24hUsd ?? null,
      tvlUsd: selected?.liquidityUsd ?? null,
      activeLiquidityUsd: null,
      feeTier: verified.onchain?.feeTier ?? selected?.feeTier ?? null,
      poolAgeDays: selected?.poolAgeDays ?? null,
      tick: { current: verified.onchain?.currentTick ?? null, lower: null, upper: null },
      holderFlow: null,
    },
    history: { ohlcv5m: h1, ohlcv30m: h24, ohlcv1h: h7, ohlcv1d: daily },
    evidence: { grade, freshnessSeconds: fresh, conflicts, wickPenalty: wick, sources: statuses },
    failureState: grade === "D" ? "BLOCKED_EVIDENCE" : null,
  };
}
