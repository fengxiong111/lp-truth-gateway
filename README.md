# LP Truth Gateway

`address -> lp-truth-v1 Verified Market/Pool Truth Artifact`。

本仓库只负责 Truth；`lp-range-oracle` 只消费版本化 artifact 做 Candidate Search / Replay / Core / Buffer / Action。未知值保持 `null`，授权缺失为 `BLOCKED_AUTH`，证据不足为 `BLOCKED_EVIDENCE`，RPC/适配器失败明确分类，不以猜测回填。

## Source Transport 原则

数据源能力与“有没有官方 API”解耦。每个 Source Adapter 都遵循同一降级链：

`Official API / RPC -> public endpoint -> reverse-discovered endpoint -> HTML/embedded JSON DOM -> headless-browser rendered DOM/network evidence -> BLOCKED`

因此没有官方 API 不等于没有数据能力。公开网页可由脚本读取；若数据由前端 XHR/fetch 加载，可从公开 HTML、脚本和 headless browser network log 发现 endpoint，再回到结构化读取。无接口时可直接读取渲染后的 DOM / embedded JSON。所有路径最后必须归一成同一个 typed Truth contract，所以 Oracle 不需要知道底层来自 API 还是 DOM。

Transport 与 Evidence Grade 分离：DOM/逆向 endpoint 可以提供与 API 同字段的结构化事实，但只有通过 freshness、identity、cross-source conflict、on-chain proof 等验证后才能提高 Evidence Grade。系统不绕过登录、验证码、付费墙或访问控制；需要授权时仍返回 `BLOCKED_AUTH`。

当前 `surface.ts` 已实现：HTTPS host allowlist、public JSON/HTML read、embedded JSON / `__NEXT_DATA__` 提取、同源 endpoint discovery、公开 endpoint 重读、可选 headless Chrome DOM + network-log discovery、SHA-256 receipt。所有 browser profile 为临时无账号环境，不读取钱包或本地凭据。

## 当前 Truth 链

默认分支的 `[LP_TRUTH] <EVM 地址>` Issue Queue：

1. DexScreener 发现候选池并统一把“被查询 Token”价格归一到 USD，避免 base/quote 方向造成假冲突。
2. Robinhood Chain 上通过 public RPC 读取 Uniswap V3 `token0/token1/factory/fee/tickSpacing/liquidity/slot0`，并用官方 V3 Factory `getPool` 验证 canonical pool identity。
3. 对多个可验证 V3 候选池并行补齐真实 fee tier、current tick、sqrtPriceX96、raw active liquidity。
4. DexPaprika 提供 5m/30m/1h/24h 与真实 7d OHLCV；GeckoTerminal 作为历史 fallback。
5. Pool competition 使用 `volume × on-chain fee tier` 作为明确标注的 gross-fee proxy，再除以 TVL 得到 fee-velocity proxy；增加 `$100k` liquidity capacity guard，防止极小高周转池错误胜出。
6. Revert 等无官方 API/未配置 API 的公开页面进入 Surface Transport 自动探测，不再一律误判为 `BLOCKED_AUTH`；VFAT 等没有 token-scoped surface 时保持 `BLOCKED_EVIDENCE`，直到建立可验证映射。
7. 当前 PONS E2E 已能把深度 PONS/WETH 0.30% 池置于极小 0.05% 池之前，并输出 Evidence B。

`grossFee24hUsd` / `feeVelocity24h` 仍是 **proxy**，不是实际 fee-growth。A-grade Truth 仍需要 tick liquidity density、真实 fee-growth delta、方向性 swaps、holder/whale flow 等证据。

OKX、Revert、VFAT 属于 enhancement adapters；官方接口优先，但不存在官方 API 时自动退化到公开 endpoint / DOM / browser transport。任何增强源失败都不会破坏无密钥基础 Truth。
