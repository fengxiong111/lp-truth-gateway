# LP Truth Gateway

`address -> lp-truth-v1 Verified Market/Pool Truth Artifact`。

本仓库只负责 Truth；`lp-range-oracle` 只消费版本化 artifact 做 Candidate Search / Replay / Core / Buffer / Action。未知值保持 `null`，授权缺失为 `BLOCKED_AUTH`，证据不足为 `BLOCKED_EVIDENCE`，RPC/适配器失败明确分类，不以猜测回填。

## 当前 Truth 链

默认分支的 `[LP_TRUTH] <EVM 地址>` Issue Queue：

1. DexScreener 发现候选池并统一把“被查询 Token”价格归一到 USD，避免 base/quote 方向造成假冲突。
2. Robinhood Chain 上通过 public RPC 读取 Uniswap V3 `token0/token1/factory/fee/tickSpacing/liquidity/slot0`，并用官方 V3 Factory `getPool` 验证 canonical pool identity。
3. 对多个可验证 V3 候选池并行补齐真实 fee tier、current tick、sqrtPriceX96、raw active liquidity。
4. DexPaprika 提供 5m/30m/1h/24h 与真实 7d OHLCV；GeckoTerminal 作为历史 fallback。
5. Pool competition 使用 `volume × on-chain fee tier` 作为明确标注的 gross-fee proxy，再除以 TVL 得到 fee-velocity proxy；增加 `$100k` liquidity capacity guard，防止极小高周转池错误胜出。
6. 当前 PONS E2E 已能把深度 PONS/WETH 0.30% 池置于极小 0.05% 池之前，并输出 Evidence B。

`grossFee24hUsd` / `feeVelocity24h` 仍是 **proxy**，不是实际 fee-growth。A-grade Truth 仍需要 tick liquidity density、真实 fee-growth/fees、方向性 swaps、holder/whale flow 等证据。

OKX、Revert、VFAT 属于 enhancement adapters；缺授权时不阻塞无密钥基础 Truth，也不会伪称已接入。
