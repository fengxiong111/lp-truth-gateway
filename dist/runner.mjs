// src/onchain-evidence.ts
var RPC_URLS = [
  "https://rpc.mainnet.chain.robinhood.com",
  "https://rpc.nodeflare.app/robinhood/public",
  "https://robinhood-rpc.publicnode.com"
];
var CHAIN_ID = 4663n;
var TICK_LENS = "0x7dfd4f31be6814d2906bde155c3e1b146eac1468";
var GET_POPULATED_TICKS = "0x351fb478";
var FEE_GROWTH_0 = "0xf3058399";
var FEE_GROWTH_1 = "0x46141319";
var UINT256_MOD = 1n << 256n;
var clean = (x) => x.startsWith("0x") ? x.slice(2) : x;
var word = (hex, i) => clean(hex).slice(i * 64, (i + 1) * 64).padStart(64, "0");
var u = (hex, i = 0) => BigInt(`0x${word(hex, i)}`);
var signed = (hex, i, bits) => BigInt.asIntN(bits, u(hex, i));
var encAddress = (address2) => address2.toLowerCase().replace(/^0x/, "").padStart(64, "0");
var encSigned = (value) => BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, "0");
var hexBlock = (n2) => `0x${n2.toString(16)}`;
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var err = (e) => e instanceof Error ? e.message : "FAILED";
async function rpc(url, method, params) {
  let last = "RPC_FAILED";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "accept": "application/json", "user-agent": "lp-truth-gateway/1.4" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8e3) });
      if (!response.ok) {
        last = `RPC_HTTP_${response.status}`;
        if (response.status === 403 || response.status === 429 || response.status >= 500) {
          await sleep(150 * (attempt + 1));
          continue;
        }
        throw new Error(last);
      }
      const body = await response.json();
      if (body.error) throw new Error(`RPC_${body.error.code ?? "ERROR"}:${body.error.message ?? "UNKNOWN"}`);
      if (body.result === void 0 || body.result === null) throw new Error("RPC_NO_RESULT");
      return body.result;
    } catch (error) {
      last = err(error);
      if (attempt === 0) await sleep(150);
    }
  }
  throw new Error(last);
}
async function assertChain(url) {
  const id = await rpc(url, "eth_chainId", []);
  if (BigInt(id) !== CHAIN_ID) throw new Error(`CHAIN_ID_MISMATCH:${id}`);
}
async function call(url, to, data, blockTag) {
  return rpc(url, "eth_call", [{ to, data }, blockTag]);
}
async function block(url, tag) {
  return rpc(url, "eth_getBlockByNumber", [tag, false]);
}
function tickWordPosition(currentTick, tickSpacing) {
  if (!Number.isInteger(currentTick) || !Number.isInteger(tickSpacing) || tickSpacing <= 0) throw new Error("INVALID_TICK_INPUT");
  let compressed = Math.trunc(currentTick / tickSpacing);
  if (currentTick < 0 && currentTick % tickSpacing !== 0) compressed--;
  return Math.floor(compressed / 256);
}
function decodePopulatedTicks(hex) {
  const body = clean(hex);
  if (body.length < 128) return [];
  const offset = Number(BigInt(`0x${word(hex, 0)}`) / 32n);
  if (!Number.isSafeInteger(offset) || offset < 0) return [];
  const length = Number(u(hex, offset));
  if (!Number.isSafeInteger(length) || length < 0 || length > 256) return [];
  const out = [];
  for (let i = 0; i < length; i++) {
    const base = offset + 1 + i * 3;
    out.push({ tick: Number(signed(hex, base, 24)), liquidityNetRaw: signed(hex, base + 1, 128).toString(), liquidityGrossRaw: u(hex, base + 2).toString() });
  }
  return out;
}
function tickLensData(pool, bitmapWord) {
  return `${GET_POPULATED_TICKS}${encAddress(pool)}${encSigned(bitmapWord)}`;
}
function pct(numerator, denominator) {
  if (denominator <= 0n) return null;
  return Math.max(0, Math.min(100, Number(numerator * 1000000n / denominator) / 1e4));
}
async function tickVia(url, pool, blockTag, wordRadius) {
  await assertChain(url);
  const tag = blockTag ?? await rpc(url, "eth_blockNumber", []), center = tickWordPosition(pool.currentTick, pool.tickSpacing), words = Array.from({ length: wordRadius * 2 + 1 }, (_, i) => center - wordRadius + i);
  const encoded = await Promise.all(words.map((bitmapWord) => call(url, TICK_LENS, tickLensData(pool.poolAddress, bitmapWord), tag)));
  const decoded = encoded.flatMap(decodePopulatedTicks);
  const unique = [...new Map(decoded.map((x) => [x.tick, x])).values()].sort((a, b) => a.tick - b.tick), below = unique.filter((x) => x.tick <= pool.currentTick).at(-1)?.tick ?? null, above = unique.find((x) => x.tick > pool.currentTick)?.tick ?? null;
  const gross = unique.map((x) => BigInt(x.liquidityGrossRaw)), total = gross.reduce((a, b) => a + b, 0n), top5 = [...gross].sort((a, b) => a === b ? 0 : a > b ? -1 : 1).slice(0, 5).reduce((a, b) => a + b, 0n);
  return { verified: unique.length > 0, source: "UNISWAP_V3_TICKLENS", rpcUrl: url, tickLens: TICK_LENS, blockNumber: tag, currentTick: pool.currentTick, tickSpacing: pool.tickSpacing, wordRadius, wordsQueried: words.length, initializedTickCount: unique.length, nearestBelowTick: below, nearestAboveTick: above, nearestBelowDistance: below === null ? null : pool.currentTick - below, nearestAboveDistance: above === null ? null : above - pool.currentTick, totalLiquidityGrossRaw: total.toString(), top5GrossLiquidityConcentrationPct: pct(top5, total), error: unique.length ? null : "NO_INITIALIZED_TICKS_IN_WINDOW" };
}
async function fetchTickLiquidityEvidence(pool, blockTag, wordRadius = 2) {
  try {
    return await Promise.any(RPC_URLS.map(async (url) => {
      try {
        return await tickVia(url, pool, blockTag, wordRadius);
      } catch (error) {
        throw new Error(`${new URL(url).hostname}:${err(error)}`);
      }
    }));
  } catch (error) {
    const details = error instanceof AggregateError ? error.errors.map(err).join("|") : err(error);
    return { verified: false, source: "UNISWAP_V3_TICKLENS", rpcUrl: null, tickLens: TICK_LENS, blockNumber: blockTag ?? null, currentTick: pool.currentTick, tickSpacing: pool.tickSpacing, wordRadius, wordsQueried: 0, initializedTickCount: 0, nearestBelowTick: null, nearestAboveTick: null, nearestBelowDistance: null, nearestAboveDistance: null, totalLiquidityGrossRaw: "0", top5GrossLiquidityConcentrationPct: null, error: `ALL_RPC_FAILED:${details}` };
  }
}
async function historicalBlock(url, latest, desiredSeconds) {
  const latestN = BigInt(latest.number), latestTs = Number(BigInt(latest.timestamp)), probeN = latestN > 5000n ? latestN - 5000n : 0n, probe = await block(url, hexBlock(probeN)), probeTs = Number(BigInt(probe.timestamp)), span = Number(latestN - probeN);
  let secondsPerBlock = span > 0 ? (latestTs - probeTs) / span : 1;
  if (!Number.isFinite(secondsPerBlock) || secondsPerBlock <= 0) secondsPerBlock = 1;
  let guess = latestN - BigInt(Math.max(1, Math.round(desiredSeconds / secondsPerBlock)));
  if (guess < 0n) guess = 0n;
  let candidate = await block(url, hexBlock(guess));
  for (let i = 0; i < 2; i++) {
    const observed = latestTs - Number(BigInt(candidate.timestamp)), error = desiredSeconds - observed;
    if (Math.abs(error) <= 90) break;
    guess -= BigInt(Math.round(error / secondsPerBlock));
    if (guess < 0n) guess = 0n;
    if (guess >= latestN) guess = latestN - 1n;
    candidate = await block(url, hexBlock(guess));
  }
  return candidate;
}
function delta256(current, previous) {
  return (current - previous + UINT256_MOD) % UINT256_MOD;
}
async function feeSnapshot(url, pool) {
  const tag = await rpc(url, "eth_blockNumber", []), meta = await block(url, tag), [fee0Hex, fee1Hex] = await Promise.all([call(url, pool.poolAddress, FEE_GROWTH_0, tag), call(url, pool.poolAddress, FEE_GROWTH_1, tag)]);
  return { block: tag, timestamp: Number(BigInt(meta.timestamp)), fee0: u(fee0Hex), fee1: u(fee1Hex) };
}
function fromSnapshots(url, requestedWindowSeconds, from, to, mode, archiveReadVerified) {
  const d0 = delta256(to.fee0, from.fee0), d1 = delta256(to.fee1, from.fee1);
  return { verified: BigInt(to.block) > BigInt(from.block), source: "UNISWAP_V3_POOL", mode, rpcUrl: url, requestedWindowSeconds, observedWindowSeconds: Math.max(0, to.timestamp - from.timestamp), fromBlock: from.block, toBlock: to.block, fromTimestamp: from.timestamp, toTimestamp: to.timestamp, feeGrowthGlobal0X128DeltaRaw: d0.toString(), feeGrowthGlobal1X128DeltaRaw: d1.toString(), nonZeroGrowth: d0 > 0n || d1 > 0n, archiveReadVerified, error: null };
}
async function feeGrowthArchive(url, pool, requestedWindowSeconds) {
  await assertChain(url);
  const latestTag = await rpc(url, "eth_blockNumber", []), latest = await block(url, latestTag), previous = await historicalBlock(url, latest, requestedWindowSeconds);
  const [from0, from1, to0, to1] = await Promise.all([
    call(url, pool.poolAddress, FEE_GROWTH_0, previous.number),
    call(url, pool.poolAddress, FEE_GROWTH_1, previous.number),
    call(url, pool.poolAddress, FEE_GROWTH_0, latest.number),
    call(url, pool.poolAddress, FEE_GROWTH_1, latest.number)
  ]);
  const from = { block: previous.number, timestamp: Number(BigInt(previous.timestamp)), fee0: u(from0), fee1: u(from1) };
  const to = { block: latest.number, timestamp: Number(BigInt(latest.timestamp)), fee0: u(to0), fee1: u(to1) };
  return fromSnapshots(url, requestedWindowSeconds, from, to, "ARCHIVE_WINDOW", true);
}
async function feeGrowthLive(url, pool, requestedWindowSeconds) {
  await assertChain(url);
  const from = await feeSnapshot(url, pool);
  await sleep(5200);
  const to = await feeSnapshot(url, pool);
  return fromSnapshots(url, requestedWindowSeconds, from, to, "LIVE_DELTA", false);
}
async function raceEvidence(kind, pool, requestedWindowSeconds) {
  return Promise.any(RPC_URLS.map(async (url) => {
    try {
      return kind === "ARCHIVE" ? await feeGrowthArchive(url, pool, requestedWindowSeconds) : await feeGrowthLive(url, pool, requestedWindowSeconds);
    } catch (error) {
      throw new Error(`${kind}:${new URL(url).hostname}:${err(error)}`);
    }
  }));
}
async function fetchFeeGrowthEvidence(pool, requestedWindowSeconds = 3600, allowLive = true) {
  const errors = [];
  try {
    return await raceEvidence("ARCHIVE", pool, requestedWindowSeconds);
  } catch (error) {
    errors.push(error instanceof AggregateError ? error.errors.map(err).join("|") : err(error));
  }
  if (allowLive) {
    try {
      return await raceEvidence("LIVE", pool, requestedWindowSeconds);
    } catch (error) {
      errors.push(error instanceof AggregateError ? error.errors.map(err).join("|") : err(error));
    }
  }
  return { verified: false, source: "UNISWAP_V3_POOL", mode: null, rpcUrl: null, requestedWindowSeconds, observedWindowSeconds: null, fromBlock: null, toBlock: null, fromTimestamp: null, toTimestamp: null, feeGrowthGlobal0X128DeltaRaw: null, feeGrowthGlobal1X128DeltaRaw: null, nonZeroGrowth: false, archiveReadVerified: false, error: `ALL_RPC_FAILED:${errors.join("|")}` };
}
async function fetchOnchainEvidence(pool, options) {
  const [tickLiquidity, feeGrowth] = await Promise.all([fetchTickLiquidityEvidence(pool), fetchFeeGrowthEvidence(pool, 3600, options?.allowLiveFeeGrowth ?? true)]);
  return { tickLiquidity, feeGrowth };
}

// src/onchain.ts
var ROBINHOOD = {
  chainId: "4663",
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  uniswapV3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa"
};
var CHAIN_ALIASES = {
  robinhood: ROBINHOOD,
  "robinhood-chain": ROBINHOOD,
  "4663": ROBINHOOD
};
var SELECTOR = {
  token0: "0x0dfe1681",
  token1: "0xd21220a7",
  factory: "0xc45a0155",
  fee: "0xddca3f43",
  tickSpacing: "0xd0c93a7c",
  liquidity: "0x1a686502",
  slot0: "0x3850c7bd",
  getPool: "0x1698ee82"
};
var now = () => (/* @__PURE__ */ new Date()).toISOString();
var cleanHex = (value) => value.startsWith("0x") ? value.slice(2) : value;
var word2 = (hex, index = 0) => cleanHex(hex).slice(index * 64, (index + 1) * 64).padStart(64, "0");
var uint = (hex, index = 0) => BigInt(`0x${word2(hex, index)}`);
var addressWord = (hex, index = 0) => `0x${word2(hex, index).slice(24)}`.toLowerCase();
var encodeAddress = (address2) => address2.toLowerCase().replace(/^0x/, "").padStart(64, "0");
var encodeUint = (value) => BigInt(value).toString(16).padStart(64, "0");
var int24 = (hex, index = 0) => {
  const mask = (1n << 24n) - 1n;
  let value = uint(hex, index) & mask;
  if (value >= 1n << 23n) value -= 1n << 24n;
  return Number(value);
};
async function rpc2(url, method, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8e3);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(`RPC_${body.error.code ?? "ERROR"}:${body.error.message ?? "UNKNOWN"}`);
    if (body.result === void 0) throw new Error("RPC_NO_RESULT");
    return body.result;
  } finally {
    clearTimeout(timeout);
  }
}
async function ethCall(url, to, data) {
  return rpc2(url, "eth_call", [{ to, data }, "latest"]);
}
function status(source, ready, failureState, error) {
  return { source, status: ready ? "READY" : "BLOCKED", fetchedAt: now(), failureState, error };
}
async function fetchUniswapV3State(pool) {
  const config = pool.chainId ? CHAIN_ALIASES[pool.chainId.toLowerCase()] : void 0;
  if (!config) {
    return {
      state: null,
      statuses: [
        status("rpc", false, "BLOCKED_DATA", `UNSUPPORTED_CHAIN:${pool.chainId ?? "UNKNOWN"}`),
        status("uniswap", false, "BLOCKED_DATA", "UNISWAP_V3_CHAIN_CONFIG_MISSING")
      ]
    };
  }
  try {
    const chainHex = await rpc2(config.rpcUrl, "eth_chainId", []);
    if (BigInt(chainHex).toString() !== config.chainId) throw new Error(`CHAIN_ID_MISMATCH:${chainHex}`);
    const [token0Hex, token1Hex, factoryHex, feeHex, spacingHex, liquidityHex, slot0Hex] = await Promise.all([
      ethCall(config.rpcUrl, pool.poolAddress, SELECTOR.token0),
      ethCall(config.rpcUrl, pool.poolAddress, SELECTOR.token1),
      ethCall(config.rpcUrl, pool.poolAddress, SELECTOR.factory),
      ethCall(config.rpcUrl, pool.poolAddress, SELECTOR.fee),
      ethCall(config.rpcUrl, pool.poolAddress, SELECTOR.tickSpacing),
      ethCall(config.rpcUrl, pool.poolAddress, SELECTOR.liquidity),
      ethCall(config.rpcUrl, pool.poolAddress, SELECTOR.slot0)
    ]);
    const token0 = addressWord(token0Hex);
    const token1 = addressWord(token1Hex);
    const factory = addressWord(factoryHex);
    const feeTier = Number(uint(feeHex));
    const tickSpacing = int24(spacingHex);
    const activeLiquidityRaw = uint(liquidityHex).toString();
    const sqrtPriceX96 = uint(slot0Hex, 0).toString();
    const currentTick = int24(slot0Hex, 1);
    const getPoolData = `${SELECTOR.getPool}${encodeAddress(token0)}${encodeAddress(token1)}${encodeUint(feeTier)}`;
    const factoryPool = addressWord(await ethCall(config.rpcUrl, config.uniswapV3Factory, getPoolData));
    const canonical = factory === config.uniswapV3Factory.toLowerCase() && factoryPool === pool.poolAddress.toLowerCase();
    if (!canonical) throw new Error(`NON_CANONICAL_POOL:factory=${factory},getPool=${factoryPool}`);
    return {
      state: {
        chainId: config.chainId,
        rpcUrl: config.rpcUrl,
        poolAddress: pool.poolAddress.toLowerCase(),
        factory,
        token0,
        token1,
        feeTier,
        tickSpacing,
        currentTick,
        sqrtPriceX96,
        activeLiquidityRaw,
        canonical
      },
      statuses: [status("rpc", true, null, null), status("uniswap", true, null, null)]
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_RPC_ERROR";
    return {
      state: null,
      statuses: [status("rpc", false, "BLOCKED_EXECUTION", message), status("uniswap", false, "BLOCKED_EVIDENCE", message)]
    };
  }
}

// src/http.ts
var sleep2 = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function getJson(url, options = {}) {
  const timeoutMs = Math.max(1e3, options.timeoutMs ?? 6e3);
  const attempts = Math.max(1, Math.min(3, options.attempts ?? 2));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 180);
  let lastError = "FETCH_FAILED";
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "lp-truth-gateway/1.5" },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (r.status === 429 || r.status >= 500) {
        lastError = `HTTP_${r.status}`;
        if (attempt + 1 < attempts) {
          await sleep2(retryDelayMs * (attempt + 1));
          continue;
        }
        return { data: null, error: lastError };
      }
      if (!r.ok) return { data: null, error: `HTTP_${r.status}` };
      return { data: await r.json(), error: null };
    } catch (e) {
      lastError = e instanceof Error ? e.message : "FETCH_FAILED";
      if (attempt + 1 < attempts) await sleep2(retryDelayMs * (attempt + 1));
    }
  }
  return { data: null, error: lastError };
}
var n = (x) => {
  const v = typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : NaN;
  return Number.isFinite(v) ? v : null;
};

// src/sources.ts
var now2 = () => (/* @__PURE__ */ new Date()).toISOString();
var lower = (value) => typeof value === "string" ? value.toLowerCase() : null;
async function fetchDex(address2) {
  const r = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${address2}`);
  const pairs = Array.isArray(r.data?.pairs) ? r.data.pairs : [];
  const token = address2.toLowerCase();
  const candidates = pairs.map((p) => {
    const baseAddress = lower(p.baseToken?.address);
    const quoteAddress = lower(p.quoteToken?.address);
    const basePriceUsd = n(p.priceUsd);
    const basePriceInQuote = n(p.priceNative);
    const queriedTokenSide = baseAddress === token ? "base" : quoteAddress === token ? "quote" : null;
    const normalizedPriceUsd = queriedTokenSide === "base" ? basePriceUsd : queriedTokenSide === "quote" && basePriceUsd !== null && basePriceInQuote !== null && basePriceInQuote > 0 ? basePriceUsd / basePriceInQuote : null;
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
      poolAgeDays: n(p.pairCreatedAt) ? (Date.now() - Number(p.pairCreatedAt)) / 864e5 : null,
      source: "dexscreener"
    };
  }).filter((p) => typeof p.poolAddress === "string" && p.queriedTokenSide !== null);
  return {
    candidates,
    status: {
      source: "dexscreener",
      status: candidates.length ? "READY" : "BLOCKED",
      fetchedAt: now2(),
      failureState: candidates.length ? null : "BLOCKED_DATA",
      error: candidates.length ? null : r.error ?? "NO_POOL",
      url: `https://api.dexscreener.com/latest/dex/tokens/${address2}`
    }
  };
}
var rows = (x) => {
  const a = x?.data?.attributes?.ohlcv_list;
  return Array.isArray(a) ? a.map((v) => ({
    timestamp: Number(v[0]),
    open: n(v[1]) ?? 0,
    high: n(v[2]) ?? 0,
    low: n(v[3]) ?? 0,
    close: n(v[4]) ?? 0,
    volumeUsd: n(v[5]) ?? 0
  })).filter((v) => v.timestamp > 0 && v.high > 0) : [];
};
async function fetchOhlcv(pool, aggregate, limit) {
  const r = await getJson(`https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(pool.chainId ?? "")}/pools/${pool.poolAddress}/ohlcv/hour?aggregate=${aggregate}&limit=${limit}`);
  const out = rows(r.data);
  return {
    rows: out,
    status: {
      source: "geckoterminal",
      status: out.length ? "READY" : "BLOCKED",
      fetchedAt: now2(),
      failureState: out.length ? null : r.error ? "BLOCKED_EXECUTION" : "BLOCKED_EVIDENCE",
      error: out.length ? null : r.error ?? "NO_OHLCV",
      url: `https://api.geckoterminal.com/api/v2/networks/${pool.chainId ?? ""}/pools/${pool.poolAddress}/ohlcv/hour`
    }
  };
}
async function fetchPaprikaOhlcv(pool, interval, days) {
  const end = new Date(Math.floor(Date.now() / 36e5) * 36e5);
  const start = new Date(end.getTime() - days * 864e5);
  const limit = interval === "5m" ? 300 : interval === "30m" ? 100 : 200;
  const r = await getJson(`https://api.dexpaprika.com/networks/${encodeURIComponent(pool.chainId ?? "")}/pools/${pool.poolAddress.toLowerCase()}/ohlcv?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}&interval=${interval}&limit=${limit}`);
  const a = Array.isArray(r.data) ? r.data : [];
  const out = a.map((v) => ({
    timestamp: Date.parse(v.time_open) / 1e3,
    open: n(v.open) ?? 0,
    high: n(v.high) ?? 0,
    low: n(v.low) ?? 0,
    close: n(v.close) ?? 0,
    volumeUsd: n(v.volume) ?? 0
  })).filter((v) => v.timestamp > 0 && v.high > 0);
  return {
    rows: out,
    status: {
      source: "dexpaprika",
      status: out.length ? "READY" : "BLOCKED",
      fetchedAt: now2(),
      failureState: out.length ? null : r.error ? "BLOCKED_EXECUTION" : "BLOCKED_EVIDENCE",
      error: out.length ? null : r.error ?? "NO_OHLCV",
      url: `https://api.dexpaprika.com/networks/${pool.chainId ?? ""}/pools/${pool.poolAddress.toLowerCase()}/ohlcv`
    }
  };
}

// src/surface.ts
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var UA = "lp-truth-gateway/1.1";
var MAX_BODY = 4e6;
var MAX_ENDPOINTS = 12;
var now3 = () => (/* @__PURE__ */ new Date()).toISOString();
function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}
function safeUrl(raw, allowedHosts) {
  try {
    const u2 = new URL(raw);
    if (u2.protocol !== "https:") return null;
    if (!allowedHosts.includes(u2.hostname.toLowerCase())) return null;
    return u2;
  } catch {
    return null;
  }
}
function safePath(raw) {
  try {
    const u2 = new URL(raw);
    return `${u2.origin}${u2.pathname}`;
  } catch {
    return null;
  }
}
async function getText(url) {
  try {
    const r = await fetch(url, { headers: { accept: "application/json,text/html;q=0.9,*/*;q=0.5", "user-agent": UA }, signal: AbortSignal.timeout(12e3) });
    if (!r.ok) return { text: null, contentType: r.headers.get("content-type") ?? "", error: `HTTP_${r.status}` };
    const text = (await r.text()).slice(0, MAX_BODY);
    return { text, contentType: r.headers.get("content-type") ?? "", error: null };
  } catch (e) {
    return { text: null, contentType: "", error: e instanceof Error ? e.message : "FETCH_FAILED" };
  }
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function decodeEntities(text) {
  return text.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function embeddedJson(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*(?:type=["']application\/(?:json|ld\+json)["']|id=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/gi)];
  const out = [];
  for (const m of scripts.slice(0, 20)) {
    const parsed = parseJson(decodeEntities((m[1] ?? "").trim()));
    if (parsed !== null) out.push(parsed);
  }
  return out.length ? out : null;
}
function discoverEndpoints(html, base, allowedHosts) {
  const raw = /* @__PURE__ */ new Set();
  const patterns = [/https:\/\/[^"'\s<>\\]+/g, /["'](\/[^"']*(?:api|graphql|_next\/data)[^"']*)["']/gi, /(?:fetch|axios\.(?:get|post))\(\s*["']([^"']+)["']/gi];
  for (const pattern of patterns) for (const m of html.matchAll(pattern)) raw.add(m[1] ?? m[0]);
  const out = [];
  for (const value of raw) {
    try {
      const u2 = new URL(value.replace(/&amp;/g, "&"), base);
      if (u2.protocol !== "https:" || !allowedHosts.includes(u2.hostname.toLowerCase())) continue;
      if (!/(api|graphql|_next\/data|pool|position|analytics|discover)/i.test(u2.pathname + u2.search)) continue;
      out.push(u2.toString());
    } catch {
    }
  }
  return [...new Set(out)].slice(0, MAX_ENDPOINTS);
}
async function readDiscoveredEndpoint(urls, tokenAddress) {
  const token = tokenAddress.toLowerCase();
  for (const url of urls) {
    const r = await getText(url);
    if (!r.text) continue;
    const parsed = parseJson(r.text);
    if (parsed === null) continue;
    if (r.text.toLowerCase().includes(token)) return { text: r.text, structured: parsed, url };
  }
  return null;
}
async function chromePath() {
  const candidates = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter((x) => Boolean(x));
  for (const p of candidates) try {
    await access(p);
    return p;
  } catch {
  }
  return null;
}
async function browserDump(url, allowedHosts) {
  const chrome = await chromePath();
  if (!chrome) return null;
  const dir = await mkdtemp(join(tmpdir(), "lp-surface-"));
  const netlog = join(dir, "netlog.json");
  try {
    const { stdout } = await execFileAsync(chrome, ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", `--user-data-dir=${dir}`, `--log-net-log=${netlog}`, "--net-log-capture-mode=Default", "--virtual-time-budget=6000", "--dump-dom", url], { timeout: 15e3, maxBuffer: MAX_BODY });
    let endpointUrls = discoverEndpoints(stdout, new URL(url), allowedHosts);
    try {
      const log = JSON.parse(await readFile(netlog, "utf8"));
      const observed = (log.events ?? []).flatMap((e) => e.params?.url ? [e.params.url] : []).filter((x) => Boolean(safeUrl(x, allowedHosts)));
      endpointUrls = [.../* @__PURE__ */ new Set([...endpointUrls, ...observed.filter((x) => /(api|graphql|pool|position|analytics|discover)/i.test(x))])].slice(0, MAX_ENDPOINTS);
    } catch {
    }
    return { html: stdout.slice(0, MAX_BODY), endpointUrls };
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
function receipt(source, url, transport, text, structured, endpoints, tokenAddress, error) {
  const addressMatched = text?.toLowerCase().includes(tokenAddress.toLowerCase()) ?? false;
  const structuredPayload = structured !== null;
  const transportReady = text !== null;
  const ready = transportReady && addressMatched && structuredPayload;
  const paths = [...new Set(endpoints.map(safePath).filter((x) => Boolean(x)))].slice(0, 8);
  return {
    source,
    url,
    transport,
    transportReady,
    status: ready ? "READY" : "BLOCKED",
    addressMatched,
    structuredPayload,
    discoveredEndpoints: endpoints.length,
    discoveredEndpointPaths: paths,
    contentSha256: text ? sha(text) : null,
    error: ready ? null : addressMatched && transportReady ? "UNSTRUCTURED_SURFACE_ONLY" : error ?? "TOKEN_NOT_FOUND_ON_PUBLIC_SURFACE"
  };
}
async function readPublicSurface(options) {
  const { source, tokenAddress, allowedHosts } = options;
  const base = safeUrl(options.url, allowedHosts);
  if (!base) {
    const r2 = receipt(source, options.url, "NONE", null, null, [], tokenAddress, "UNSAFE_OR_UNAPPROVED_URL");
    return { receipt: r2, fetchedAt: now3(), text: null, structured: null, endpointUrls: [] };
  }
  const direct = await getText(base.toString());
  if (!direct.text) {
    const r2 = receipt(source, base.toString(), "NONE", null, null, [], tokenAddress, direct.error);
    return { receipt: r2, fetchedAt: now3(), text: null, structured: null, endpointUrls: [] };
  }
  const directJson = /json/i.test(direct.contentType) ? parseJson(direct.text) : null;
  if (directJson !== null && direct.text.toLowerCase().includes(tokenAddress.toLowerCase())) {
    const r2 = receipt(source, base.toString(), "PUBLIC_ENDPOINT", direct.text, directJson, [], tokenAddress, null);
    return { receipt: r2, fetchedAt: now3(), text: direct.text, structured: directJson, endpointUrls: [] };
  }
  const embedded = embeddedJson(direct.text);
  const staticEndpoints = discoverEndpoints(direct.text, base, allowedHosts);
  const endpoint = await readDiscoveredEndpoint(staticEndpoints, tokenAddress);
  if (endpoint) {
    const r2 = receipt(source, endpoint.url, "DISCOVERED_ENDPOINT", endpoint.text, endpoint.structured, staticEndpoints, tokenAddress, null);
    return { receipt: r2, fetchedAt: now3(), text: endpoint.text, structured: endpoint.structured, endpointUrls: staticEndpoints };
  }
  if (direct.text.toLowerCase().includes(tokenAddress.toLowerCase())) {
    const r2 = receipt(source, base.toString(), "HTML_DOM", direct.text, embedded, staticEndpoints, tokenAddress, null);
    return { receipt: r2, fetchedAt: now3(), text: direct.text, structured: embedded, endpointUrls: staticEndpoints };
  }
  if (options.browserFallback !== false) {
    const browser = await browserDump(base.toString(), allowedHosts);
    if (browser) {
      const browserEndpoint = await readDiscoveredEndpoint(browser.endpointUrls, tokenAddress);
      if (browserEndpoint) {
        const r3 = receipt(source, browserEndpoint.url, "DISCOVERED_ENDPOINT", browserEndpoint.text, browserEndpoint.structured, browser.endpointUrls, tokenAddress, null);
        return { receipt: r3, fetchedAt: now3(), text: browserEndpoint.text, structured: browserEndpoint.structured, endpointUrls: browser.endpointUrls };
      }
      const rendered = embeddedJson(browser.html);
      const r2 = receipt(source, base.toString(), "BROWSER_DOM", browser.html, rendered, browser.endpointUrls, tokenAddress, null);
      return { receipt: r2, fetchedAt: now3(), text: browser.html, structured: rendered, endpointUrls: browser.endpointUrls };
    }
  }
  const r = receipt(source, base.toString(), "HTML_DOM", direct.text, embedded, staticEndpoints, tokenAddress, "TOKEN_NOT_FOUND_ON_PUBLIC_SURFACE");
  return { receipt: r, fetchedAt: now3(), text: direct.text, structured: embedded, endpointUrls: staticEndpoints };
}
async function probePublicEnhancements(tokenAddress) {
  const address2 = tokenAddress.toLowerCase();
  return Promise.all([
    readPublicSurface({ source: "revert", url: `https://revert.finance/discover?pool=${encodeURIComponent(address2)}`, tokenAddress: address2, allowedHosts: ["revert.finance", "www.revert.finance"], browserFallback: process.env.LP_BROWSER_FALLBACK !== "0" })
  ]);
}

// src/index.ts
import { createHash as createHash2 } from "node:crypto";
var CAPACITY_LIQUIDITY_TARGET_USD = 1e5;
var now4 = () => (/* @__PURE__ */ new Date()).toISOString();
var max = (rows2) => rows2.length ? Math.max(...rows2.map((x) => x.high)) : null;
var min = (rows2) => rows2.length ? Math.min(...rows2.map((x) => x.low)) : null;
var sum = (rows2) => rows2.length ? rows2.reduce((total, x) => total + x.volumeUsd, 0) : null;
var lower2 = (x) => x?.toLowerCase() ?? null;
var isV3Address = (x) => /^0x[0-9a-fA-F]{40}$/.test(x);
var hash = (value) => createHash2("sha256").update(JSON.stringify(value)).digest("hex");
function comparablePriceConflicts(candidates, selected) {
  if (!selected?.priceUsd || selected.priceUsd <= 0) return [];
  const reference = selected.priceUsd;
  const liquidityFloor = Math.max(25e3, (selected.liquidityUsd ?? 0) * 0.01);
  return candidates.filter((p) => p.poolAddress.toLowerCase() !== selected.poolAddress.toLowerCase()).filter((p) => lower2(p.chainId) === lower2(selected.chainId)).filter((p) => p.priceUsd !== null && p.priceUsd > 0).filter((p) => (p.liquidityUsd ?? 0) >= liquidityFloor || (p.volume24hUsd ?? 0) >= 1e5).filter((p) => Math.abs(p.priceUsd - reference) / reference > 0.05).map((p) => `USD_PRICE_CONFLICT:${p.poolAddress}:${p.priceUsd}`);
}
function toTruthPool(state) {
  return state ? { chainId: state.chainId, poolAddress: state.poolAddress, factory: state.factory, token0: state.token0, token1: state.token1, feeTier: state.feeTier, tickSpacing: state.tickSpacing, currentTick: state.currentTick, sqrtPriceX96: state.sqrtPriceX96, activeLiquidityRaw: state.activeLiquidityRaw, canonical: state.canonical } : null;
}
function collapseStatuses(rows2) {
  const sources = [...new Set(rows2.map((x) => x.source))];
  return sources.map((source) => {
    const same = rows2.filter((x) => x.source === source);
    return same.find((x) => x.status === "READY") ?? same[0];
  });
}
function opportunityScore(candidate, verified) {
  const liquidity = Math.max(0, candidate.liquidityUsd ?? 0);
  const volume = Math.max(0, candidate.volume24hUsd ?? 0);
  const capacity = Math.min(1, liquidity / CAPACITY_LIQUIDITY_TARGET_USD);
  const activity = Math.log1p(volume) * (0.2 + 0.8 * capacity);
  const feeSignal = candidate.capacityAdjustedFeeVelocity24h === null ? 1 : 1 + Math.min(1.5, candidate.capacityAdjustedFeeVelocity24h * 250);
  return activity * feeSignal * (verified ? 1.12 : 1);
}
function enrichCandidates(candidates, proofByPool) {
  return candidates.map((candidate) => {
    const proof = proofByPool.get(candidate.poolAddress.toLowerCase());
    if (!proof) return candidate;
    const grossFee24hUsd = candidate.volume24hUsd === null ? null : candidate.volume24hUsd * (proof.feeTier / 1e6);
    const feeVelocity24h = grossFee24hUsd !== null && candidate.liquidityUsd !== null && candidate.liquidityUsd > 0 ? grossFee24hUsd / candidate.liquidityUsd : null;
    const capacityFactor = candidate.liquidityUsd === null ? null : Math.min(1, candidate.liquidityUsd / CAPACITY_LIQUIDITY_TARGET_USD);
    const capacityAdjustedFeeVelocity24h = feeVelocity24h === null || capacityFactor === null ? null : feeVelocity24h * capacityFactor;
    return { ...candidate, feeTier: proof.feeTier, grossFee24hUsd, feeVelocity24h, capacityAdjustedFeeVelocity24h };
  });
}
async function verifyPools(candidates, preferredPool2, fast2 = false) {
  const preferred = preferredPool2 ? candidates.find((candidate) => candidate.poolAddress.toLowerCase() === preferredPool2.toLowerCase()) ?? null : null;
  const proofByPool = /* @__PURE__ */ new Map();
  const statuses = [];
  if (preferred) {
    const preferredIsRobinhood = lower2(preferred.chainId) === "robinhood" || preferred.chainId === "4663" || lower2(preferred.chainId) === "robinhood-chain";
    const preferredIsV3 = preferredIsRobinhood && Boolean(lower2(preferred.dexId)?.includes("uniswap")) && isV3Address(preferred.poolAddress);
    if (preferredIsV3) {
      const result = await fetchUniswapV3State(preferred);
      statuses.push(...result.statuses);
      const proof = toTruthPool(result.state);
      if (proof?.canonical) proofByPool.set(proof.poolAddress.toLowerCase(), proof);
    } else {
      statuses.push(
        { source: "rpc", status: "BLOCKED", fetchedAt: now4(), failureState: "BLOCKED_EVIDENCE", error: "PREFERRED_POOL_NON_V3_POSITION_ANCHORED", transport: "RPC" },
        { source: "uniswap", status: "BLOCKED", fetchedAt: now4(), failureState: "BLOCKED_EVIDENCE", error: "PREFERRED_POOL_NON_V3_POSITION_ANCHORED", transport: "RPC" }
      );
    }
    const enriched2 = enrichCandidates(candidates, proofByPool);
    const selected2 = enriched2.find((candidate) => candidate.poolAddress.toLowerCase() === preferred.poolAddress.toLowerCase()) ?? preferred;
    const onchain2 = proofByPool.get(selected2.poolAddress.toLowerCase()) ?? null;
    return { candidates: enriched2, verifiedPools: [...proofByPool.values()], selected: selected2, onchain: onchain2, statuses: collapseStatuses(statuses) };
  }
  const eligible = candidates.filter((p) => lower2(p.chainId) === "robinhood" || p.chainId === "4663" || lower2(p.chainId) === "robinhood-chain").filter((p) => lower2(p.dexId)?.includes("uniswap")).filter((p) => isV3Address(p.poolAddress)).slice(0, fast2 ? 4 : 8);
  if (fast2) {
    const batch = await Promise.all(eligible.map((candidate) => fetchUniswapV3State(candidate)));
    for (const result of batch) {
      statuses.push(...result.statuses);
      const proof = toTruthPool(result.state);
      if (proof?.canonical) proofByPool.set(proof.poolAddress.toLowerCase(), proof);
    }
  } else {
    for (let i = 0; i < eligible.length; i += 4) {
      const batch = await Promise.all(eligible.slice(i, i + 4).map((candidate) => fetchUniswapV3State(candidate)));
      for (const result of batch) {
        statuses.push(...result.statuses);
        const proof = toTruthPool(result.state);
        if (proof?.canonical) proofByPool.set(proof.poolAddress.toLowerCase(), proof);
      }
    }
  }
  const enriched = enrichCandidates(candidates, proofByPool);
  const ranked = [...enriched].sort((a, b) => opportunityScore(b, proofByPool.has(b.poolAddress.toLowerCase())) - opportunityScore(a, proofByPool.has(a.poolAddress.toLowerCase())));
  const selected = ranked[0] ?? null;
  const onchain = selected ? proofByPool.get(selected.poolAddress.toLowerCase()) ?? null : null;
  const collapsed = collapseStatuses(statuses);
  if (!collapsed.length) collapsed.push(
    { source: "rpc", status: "BLOCKED", fetchedAt: now4(), failureState: "BLOCKED_DATA", error: "NO_SUPPORTED_V3_POOL_PROOF", transport: "RPC" },
    { source: "uniswap", status: "BLOCKED", fetchedAt: now4(), failureState: "BLOCKED_EVIDENCE", error: "NO_CANONICAL_V3_POOL_PROOF", transport: "RPC" }
  );
  return { candidates: ranked, verifiedPools: [...proofByPool.values()], selected, onchain, statuses: collapsed };
}
function historyIsReady(rows2, sourceReady) {
  return rows2.length >= 120 && sourceReady && rows2.at(-1).timestamp - rows2[0].timestamp >= 6 * 86400;
}
async function buildTruth(address2, options = {}) {
  const fast2 = options.fast ?? false;
  const dex = await fetchDex(address2);
  const discovered = dex.candidates.sort((a, b) => {
    const liquidity = (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1);
    return liquidity !== 0 ? liquidity : (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1);
  });
  const verified = await verifyPools(discovered, options.preferredPool, fast2);
  const candidates = verified.candidates, selected = verified.selected;
  const onchainEvidencePromise = verified.onchain ? fetchOnchainEvidence(verified.onchain, { allowLiveFeeGrowth: !fast2 }) : Promise.resolve(null);
  const statuses = [
    { ...dex.status, transport: "PUBLIC_ENDPOINT" },
    ...verified.statuses,
    { source: "okx", status: "BLOCKED", fetchedAt: now4(), failureState: "BLOCKED_AUTH", error: "OFFICIAL_API_KEY_NOT_CONFIGURED", transport: "OFFICIAL_API" },
    { source: "vfat", status: "BLOCKED", fetchedAt: now4(), failureState: "BLOCKED_EVIDENCE", error: "NO_TOKEN_SCOPED_PUBLIC_SURFACE_YET", transport: "HTML_DOM" }
  ];
  let ohlcv5m = [], ohlcv30m = [], ohlcv1h = [], ohlcv1d = [];
  let historyReady = false;
  if (selected) {
    const [paprika, gecko] = await Promise.all([
      Promise.all([
        fetchPaprikaOhlcv(selected, "5m", 1),
        fetchPaprikaOhlcv(selected, "30m", 1),
        fetchPaprikaOhlcv(selected, "1h", 7),
        fetchPaprikaOhlcv(selected, "24h", 7)
      ]),
      Promise.all([
        fetchOhlcv(selected, 5, 12),
        fetchOhlcv(selected, 30, 48),
        fetchOhlcv(selected, 60, 168),
        fetchOhlcv(selected, 1440, 10)
      ])
    ]);
    const paprikaStatus = paprika.find((x) => x.rows.length)?.status ?? paprika.find((x) => x.status.status === "BLOCKED")?.status;
    const geckoStatus = gecko.find((x) => x.rows.length)?.status ?? gecko.find((x) => x.status.status === "BLOCKED")?.status;
    if (paprikaStatus) statuses.push({ ...paprikaStatus, transport: "PUBLIC_ENDPOINT" });
    if (geckoStatus) statuses.push({ ...geckoStatus, transport: "PUBLIC_ENDPOINT" });
    const paprikaReady = historyIsReady(paprika[2].rows, paprikaStatus?.status === "READY");
    const geckoReady = historyIsReady(gecko[2].rows, geckoStatus?.status === "READY");
    const primary = paprikaReady || !geckoReady ? paprika : gecko;
    const secondary = primary === paprika ? gecko : paprika;
    ohlcv5m = primary[0].rows.length ? primary[0].rows : secondary[0].rows;
    ohlcv30m = primary[1].rows.length ? primary[1].rows : secondary[1].rows;
    ohlcv1h = primary[2].rows.length ? primary[2].rows : secondary[2].rows;
    ohlcv1d = primary[3].rows.length ? primary[3].rows : secondary[3].rows;
    historyReady = paprikaReady || geckoReady;
  }
  const onchainEvidence = await onchainEvidencePromise;
  const price = selected?.priceUsd ?? (ohlcv1h.at(-1)?.close ?? null);
  const supportedChain = selected === null || lower2(selected.chainId) === "robinhood" || selected.chainId === "4663" || lower2(selected.chainId) === "robinhood-chain";
  const conflicts = comparablePriceConflicts(candidates, selected);
  const latestHistoryTs = ohlcv1h.length ? Math.max(...ohlcv1h.map((x) => x.timestamp)) : null;
  const freshnessSeconds = latestHistoryTs === null ? null : Math.max(0, Math.floor(Date.now() / 1e3 - latestHistoryTs));
  const wickPenalty = ohlcv1h.some((x) => x.high > Math.max(x.open, x.close) * 1.25 || x.low < Math.min(x.open, x.close) * 0.75);
  const onchainReady = Boolean(verified.onchain?.canonical && verified.onchain.feeTier > 0 && Number.isFinite(verified.onchain.currentTick) && BigInt(verified.onchain.activeLiquidityRaw) > 0n);
  const marketReady = dex.status.status === "READY";
  const preferredAnchored = Boolean(options.preferredPool && selected?.poolAddress.toLowerCase() === options.preferredPool.toLowerCase());
  const baseB = marketReady && historyReady && onchainReady && (preferredAnchored || conflicts.length === 0);
  const feeGrowthA = Boolean(onchainEvidence?.feeGrowth.verified && (onchainEvidence.feeGrowth.observedWindowSeconds ?? 0) >= 5 && onchainEvidence.feeGrowth.feeGrowthGlobal0X128DeltaRaw !== null && onchainEvidence.feeGrowth.feeGrowthGlobal1X128DeltaRaw !== null);
  const gradeA = Boolean(baseB && onchainEvidence?.tickLiquidity.verified && feeGrowthA);
  let enhancements = [];
  if (!fast2 || !marketReady || !historyReady) {
    enhancements = await probePublicEnhancements(address2);
    statuses.push(...enhancements.map((x) => ({ source: x.receipt.source, status: x.receipt.status, fetchedAt: x.fetchedAt, failureState: x.receipt.status === "READY" ? null : "BLOCKED_EVIDENCE", error: x.receipt.error, transport: x.receipt.transport, url: x.receipt.url, contentSha256: x.receipt.contentSha256 })));
  }
  const surfaceReceipts = enhancements.map((x) => x.receipt);
  const sourceReceipts = statuses.map((s) => ({
    source: s.source,
    transport: s.transport ?? null,
    url: s.url ?? null,
    fetchedAt: s.fetchedAt,
    status: s.status,
    failureState: s.failureState,
    error: s.error,
    contentSha256: s.contentSha256 ?? null
  }));
  const truthReceipts = [
    { sourceUrl: null, transport: "PUBLIC_ENDPOINT", asOf: latestHistoryTs === null ? null : new Date(latestHistoryTs * 1e3).toISOString(), contentSha256: hash({ ohlcv5m, ohlcv30m, ohlcv1h, ohlcv1d }), blockNumber: null, rpcUrl: null, conflicts, failureState: historyReady ? null : "BLOCKED_EVIDENCE" },
    { sourceUrl: verified.onchain?.poolAddress ?? null, transport: "RPC", asOf: now4(), contentSha256: hash(verified.onchain), blockNumber: onchainEvidence?.feeGrowth?.toBlock ?? onchainEvidence?.tickLiquidity?.blockNumber ?? null, rpcUrl: onchainEvidence?.feeGrowth?.rpcUrl ?? onchainEvidence?.tickLiquidity?.rpcUrl ?? null, conflicts, failureState: gradeA ? null : baseB ? null : "BLOCKED_EVIDENCE" }
  ];
  const grade = gradeA ? "A" : baseB ? "B" : marketReady && historyReady ? "C" : marketReady ? "C" : "D";
  const failureState = !supportedChain ? "BLOCKED_DATA" : grade === "D" ? "BLOCKED_EVIDENCE" : null;
  return {
    schemaVersion: "lp-truth-v1",
    request: { tokenAddress: address2 },
    timestamp: now4(),
    selectedPool: selected,
    poolCandidates: candidates,
    verifiedPools: verified.verifiedPools,
    onchainPool: verified.onchain,
    poolSelection: { method: "VERIFIED_CAPACITY_ADJUSTED_FEE_VELOCITY", verifiedCandidates: verified.verifiedPools.length, capacityLiquidityTargetUsd: CAPACITY_LIQUIDITY_TARGET_USD, feeBasis: "VOLUME_X_FEE_TIER_PROXY" },
    market: { priceUsd: price, high24hUsd: max(ohlcv30m), low24hUsd: min(ohlcv30m), high7dUsd: max(ohlcv1h), low7dUsd: min(ohlcv1h), volume5mUsd: sum(ohlcv5m.slice(-1)), volume30mUsd: sum(ohlcv30m.slice(-1)), volume1hUsd: sum(ohlcv1h.slice(-1)), volume24hUsd: selected?.volume24hUsd ?? null, tvlUsd: selected?.liquidityUsd ?? null, activeLiquidityUsd: null, feeTier: verified.onchain?.feeTier ?? selected?.feeTier ?? null, poolAgeDays: selected?.poolAgeDays ?? null, tick: { current: verified.onchain?.currentTick ?? null, lower: null, upper: null }, holderFlow: null },
    history: { ohlcv5m, ohlcv30m, ohlcv1h, ohlcv1d },
    onchainEvidence: { tickLiquidity: onchainEvidence?.tickLiquidity ?? null, feeGrowth: onchainEvidence?.feeGrowth ?? null, directionalSwaps: null },
    evidence: { grade, freshnessSeconds, conflicts, wickPenalty, sources: collapseStatuses(statuses), surfaceReceipts },
    receipts: { source: sourceReceipts, truth: truthReceipts },
    failureState
  };
}

// runner.ts
var args = process.argv.slice(2);
var address = args[0];
if (!address || !/^(0x)[a-fA-F0-9]{40}$/.test(address)) throw new Error("INVALID_EVM_ADDRESS");
var poolIndex = args.indexOf("--pool");
var preferredPool = poolIndex >= 0 ? args[poolIndex + 1] ?? null : null;
var fast = !args.includes("--deep");
console.log(JSON.stringify(await buildTruth(address, { preferredPool, fast }), null, 2));
