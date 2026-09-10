# LP Truth Gateway

`address -> lp-truth-v1 Verified Market/Pool Truth Artifact`。

本仓库只负责公开来源的候选池、实时市场字段与真实 OHLCV 历史；`lp-range-oracle` 只消费此 artifact 做 Candidate Search、Replay、Core/Buffer/Action。未知值保持 `null`，授权缺失明确 `BLOCKED_AUTH`，历史不可验证明确 `BLOCKED_EVIDENCE`。

默认分支的 `[LP_TRUTH] <EVM 地址>` Issue Queue 使用 DexScreener 候选发现和 DexPaprika OHLCV（5m/30m/1h/24h，7d窗口），GeckoTerminal作为 fallback，并记录 freshness、price conflict、wick penalty。Uniswap/RPC、OKX、Revert、VFAT 未配置授权时不伪造数据。
