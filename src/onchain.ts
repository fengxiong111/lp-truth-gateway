import type { FailureState, PoolCandidate, SourceStatus } from "./schema.js";

export type OnchainPoolState = {
  chainId: string;
  rpcUrl: string;
  poolAddress: string;
  factory: string;
  token0: string;
  token1: string;
  feeTier: number;
  tickSpacing: number;
  currentTick: number;
  sqrtPriceX96: string;
  activeLiquidityRaw: string;
  canonical: boolean;
};

type ChainConfig = { chainId: string; rpcUrl: string; uniswapV3Factory: string };

const ROBINHOOD: ChainConfig = {
  chainId: "4663",
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  uniswapV3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
};

const CHAIN_ALIASES: Record<string, ChainConfig> = {
  robinhood: ROBINHOOD,
  "robinhood-chain": ROBINHOOD,
  "4663": ROBINHOOD,
};

const SELECTOR = {
  token0: "0x0dfe1681",
  token1: "0xd21220a7",
  factory: "0xc45a0155",
  fee: "0xddca3f43",
  tickSpacing: "0xd0c93a7c",
  liquidity: "0x1a686502",
  slot0: "0x3850c7bd",
  getPool: "0x1698ee82",
} as const;

const now = () => new Date().toISOString();
const cleanHex = (value: string) => value.startsWith("0x") ? value.slice(2) : value;
const word = (hex: string, index = 0) => cleanHex(hex).slice(index * 64, (index + 1) * 64).padStart(64, "0");
const uint = (hex: string, index = 0) => BigInt(`0x${word(hex, index)}`);
const addressWord = (hex: string, index = 0) => `0x${word(hex, index).slice(24)}`.toLowerCase();
const encodeAddress = (address: string) => address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const encodeUint = (value: number | bigint) => BigInt(value).toString(16).padStart(64, "0");
const int24 = (hex: string, index = 0) => {
  const mask = (1n << 24n) - 1n;
  let value = uint(hex, index) & mask;
  if (value >= (1n << 23n)) value -= (1n << 24n);
  return Number(value);
};

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`);
    const body = await response.json() as { result?: T; error?: { code?: number; message?: string } };
    if (body.error) throw new Error(`RPC_${body.error.code ?? "ERROR"}:${body.error.message ?? "UNKNOWN"}`);
    if (body.result === undefined) throw new Error("RPC_NO_RESULT");
    return body.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function ethCall(url: string, to: string, data: string): Promise<string> {
  return rpc<string>(url, "eth_call", [{ to, data }, "latest"]);
}

function status(source: "rpc" | "uniswap", ready: boolean, failureState: FailureState | null, error: string | null): SourceStatus {
  return { source, status: ready ? "READY" : "BLOCKED", fetchedAt: now(), failureState, error };
}

export async function fetchUniswapV3State(pool: PoolCandidate): Promise<{ state: OnchainPoolState | null; statuses: SourceStatus[] }> {
  const config = pool.chainId ? CHAIN_ALIASES[pool.chainId.toLowerCase()] : undefined;
  if (!config) {
    return {
      state: null,
      statuses: [
        status("rpc", false, "BLOCKED_DATA", `UNSUPPORTED_CHAIN:${pool.chainId ?? "UNKNOWN"}`),
        status("uniswap", false, "BLOCKED_DATA", "UNISWAP_V3_CHAIN_CONFIG_MISSING"),
      ],
    };
  }

  try {
    const chainHex = await rpc<string>(config.rpcUrl, "eth_chainId", []);
    if (BigInt(chainHex).toString() !== config.chainId) throw new Error(`CHAIN_ID_MISMATCH:${chainHex}`);

    const [token0Hex, token1Hex, factoryHex, feeHex, spacingHex, liquidityHex, slot0Hex] = await Promise.all([
      ethCall(config.rpcUrl, pool.poolAddress, SELECTOR.token0),
      ethCall(config.rpcUrl, pool.poolAddress, SELECTOR.token1),
      ethCall(config.rpcUrl, pool.poolAddress, SELECTOR.factory),
      ethCall(config.rpcUrl, pool.poolAddress, SELECTOR.fee),
      ethCall(config.rpcUrl, pool.poolAddress, SELECTOR.tickSpacing),
      ethCall(config.rpcUrl, pool.poolAddress, SELECTOR.liquidity),
      ethCall(config.rpcUrl, pool.poolAddress, SELECTOR.slot0),
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
        canonical,
      },
      statuses: [status("rpc", true, null, null), status("uniswap", true, null, null)],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_RPC_ERROR";
    return {
      state: null,
      statuses: [status("rpc", false, "BLOCKED_EXECUTION", message), status("uniswap", false, "BLOCKED_EVIDENCE", message)],
    };
  }
}
