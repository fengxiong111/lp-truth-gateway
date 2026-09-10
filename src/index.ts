import { fetchOnchainEvidence } from "./onchain-evidence.js";
import { fetchUniswapV3State } from "./onchain.js";
import { fetchDex, fetchOhlcv, fetchPaprikaOhlcv } from "./sources.js";
import { probePublicEnhancements } from "./surface.js";
import { createHash } from "node:crypto";
import type { Ohlcv, OnchainPoolTruth, PoolCandidate, SourceStatus, TruthArtifact } from "./schema.js";

const CAPACITY_LIQUIDITY_TARGET_USD = 100_000;
const now = () => new Date().toISOString();
const max = (rows: Ohlcv[]) => rows.length ? Math.max(...rows.map((x) => x.high)) : null;
const min = (rows: Ohlcv[]) => rows.length ? Math.min(...rows.map((x) => x.low)) : null;
const sum = (rows: Ohlcv[]) => rows.length ? rows.reduce((total, x) => total + x.volumeUsd, 0) : null;
const lower = (x: string | null) => x?.toLowerCase() ?? null;
const isV3Address = (x: string) => /^0x[0-9a-fA-F]{40}$/.test(x);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type BuildTruthOptions = {
  preferredPool?: string | null;
  fast?: boolean;
};

function comparablePriceConflicts(candidates: PoolCandidate[], selected: PoolCandidate | null): string[] {
  if (!selected?.priceUsd || selected.priceUsd <= 0) return [];
  const reference = selected.priceUsd;
  const liquidityFloor = Math.max(25_000, (selected.liquidityUsd ?? 0) * 0.01);
  return candidates
    .filter((p) => p.poolAddress.toLowerCase() !== selected.poolAddress.toLowerCase())
    .filter((p) => lower(p.chainId) === lower(selected.chainId))
    .filter((p) => p.priceUsd !== null && p.priceUsd > 0)
    .filter((p) => (p.liquidityUsd ?? 0) >= liquidityFloor || (p.volume24hUsd ?? 0) >= 100_000)
    .filter((p) => Math.abs((p.priceUsd as number) - reference) / reference > 0.05)
    .map((p) => `USD_PRICE_CONFLICT:${p.poolAddress}:${p.priceUsd}`);
}

function toTruthPool(state: Awaited<ReturnType<typeof fetchUniswapV3State>>["state"]): OnchainPoolTruth | null {
  return state ? { chainId:state.chainId, poolAddress:state.poolAddress, factory:state.factory, token0:state.token0, token1:state.token1, feeTier:state.feeTier, tickSpacing:state.tickSpacing, currentTick:state.currentTick, sqrtPriceX96:state.sqrtPriceX96, activeLiquidityRaw:state.activeLiquidityRaw, canonical:state.canonical } : null;
}

function collapseStatuses(rows: SourceStatus[]): SourceStatus[] {
  const sources = [...new Set(rows.map((x) => x.source))];
  return sources.map((source) => { const same = rows.filter((x) => x.source === source); return same.find((x) => x.status === "READY") ?? same[0]; });
}

function opportunityScore(candidate: PoolCandidate, verified: boolean): number {
  const liquidity = Math.max(0, candidate.liquidityUsd ?? 0);
  const volume = Math.max(0, candidate.volume24hUsd ?? 0);
  const capacity = Math.min(1, liquidity / CAPACITY_LIQUIDITY_TARGET_USD);
  const activity = Math.log1p(volume) * (0.2 + 0.8 * capacity);
  const feeSignal = candidate.capacityAdjustedFeeVelocity24h === null ? 1 : 1 + Math.min(1.5, candidate.capacityAdjustedFeeVelocity24h * 250);
  return activity * feeSignal * (verified ? 1.12 : 1);
}

function enrichCandidates(candidates: PoolCandidate[], proofByPool: Map<string, OnchainPoolTruth>): PoolCandidate[] {
  return candidates.map((candidate)=>{
    const proof=proofByPool.get(candidate.poolAddress.toLowerCase()); if(!proof)return candidate;
    const grossFee24hUsd=candidate.volume24hUsd===null?null:candidate.volume24hUsd*(proof.feeTier/1_000_000);
    const feeVelocity24h=grossFee24hUsd!==null&&candidate.liquidityUsd!==null&&candidate.liquidityUsd>0?grossFee24hUsd/candidate.liquidityUsd:null;
    const capacityFactor=candidate.liquidityUsd===null?null:Math.min(1,candidate.liquidityUsd/CAPACITY_LIQUIDITY_TARGET_USD);
    const capacityAdjustedFeeVelocity24h=feeVelocity24h===null||capacityFactor===null?null:feeVelocity24h*capacityFactor;
    return {...candidate,feeTier:proof.feeTier,grossFee24hUsd,feeVelocity24h,capacityAdjustedFeeVelocity24h};
  });
}

async function verifyPools(candidates: PoolCandidate[], preferredPool?: string | null, fast=false): Promise<{ candidates:PoolCandidate[]; verifiedPools:OnchainPoolTruth[]; selected:PoolCandidate|null; onchain:OnchainPoolTruth|null; statuses:SourceStatus[] }> {
  const preferred = preferredPool
    ? candidates.find((candidate)=>candidate.poolAddress.toLowerCase()===preferredPool.toLowerCase()) ?? null
    : null;
  const proofByPool = new Map<string, OnchainPoolTruth>();
  const statuses: SourceStatus[] = [];

  if(preferred){
    const preferredIsRobinhood=lower(preferred.chainId)==="robinhood"||preferred.chainId==="4663"||lower(preferred.chainId)==="robinhood-chain";
    const preferredIsV3=preferredIsRobinhood&&Boolean(lower(preferred.dexId)?.includes("uniswap"))&&isV3Address(preferred.poolAddress);
    if(preferredIsV3){
      const result=await fetchUniswapV3State(preferred);
      statuses.push(...result.statuses);
      const proof=toTruthPool(result.state);
      if(proof?.canonical)proofByPool.set(proof.poolAddress.toLowerCase(),proof);
    }else{
      statuses.push(
        {source:"rpc",status:"BLOCKED",fetchedAt:now(),failureState:"BLOCKED_EVIDENCE",error:"PREFERRED_POOL_NON_V3_POSITION_ANCHORED",transport:"RPC"},
        {source:"uniswap",status:"BLOCKED",fetchedAt:now(),failureState:"BLOCKED_EVIDENCE",error:"PREFERRED_POOL_NON_V3_POSITION_ANCHORED",transport:"RPC"}
      );
    }
    const enriched=enrichCandidates(candidates,proofByPool);
    const selected=enriched.find((candidate)=>candidate.poolAddress.toLowerCase()===preferred.poolAddress.toLowerCase())??preferred;
    const onchain=proofByPool.get(selected.poolAddress.toLowerCase())??null;
    return {candidates:enriched,verifiedPools:[...proofByPool.values()],selected,onchain,statuses:collapseStatuses(statuses)};
  }

  const eligible = candidates
    .filter((p) => lower(p.chainId) === "robinhood" || p.chainId === "4663" || lower(p.chainId) === "robinhood-chain")
    .filter((p) => lower(p.dexId)?.includes("uniswap"))
    .filter((p) => isV3Address(p.poolAddress))
    .slice(0,fast?4:8);

  if(fast){
    const batch=await Promise.all(eligible.map((candidate)=>fetchUniswapV3State(candidate)));
    for(const result of batch){statuses.push(...result.statuses);const proof=toTruthPool(result.state);if(proof?.canonical)proofByPool.set(proof.poolAddress.toLowerCase(),proof);}
  }else{
    for (let i=0;i<eligible.length;i+=4) {
      const batch=await Promise.all(eligible.slice(i,i+4).map((candidate)=>fetchUniswapV3State(candidate)));
      for(const result of batch){statuses.push(...result.statuses);const proof=toTruthPool(result.state);if(proof?.canonical)proofByPool.set(proof.poolAddress.toLowerCase(),proof);}
    }
  }

  const enriched=enrichCandidates(candidates,proofByPool);
  const ranked=[...enriched].sort((a,b)=>opportunityScore(b,proofByPool.has(b.poolAddress.toLowerCase()))-opportunityScore(a,proofByPool.has(a.poolAddress.toLowerCase())));
  const selected=ranked[0]??null;
  const onchain=selected?proofByPool.get(selected.poolAddress.toLowerCase())??null:null;
  const collapsed=collapseStatuses(statuses);
  if(!collapsed.length)collapsed.push(
    {source:"rpc",status:"BLOCKED",fetchedAt:now(),failureState:"BLOCKED_DATA",error:"NO_SUPPORTED_V3_POOL_PROOF",transport:"RPC"},
    {source:"uniswap",status:"BLOCKED",fetchedAt:now(),failureState:"BLOCKED_EVIDENCE",error:"NO_CANONICAL_V3_POOL_PROOF",transport:"RPC"}
  );
  return { candidates:ranked, verifiedPools:[...proofByPool.values()], selected, onchain, statuses:collapsed };
}

function historyIsReady(rows: Ohlcv[], sourceReady: boolean): boolean {
  return rows.length>=120&&sourceReady&&(rows.at(-1)!.timestamp-rows[0]!.timestamp)>=6*86400;
}

export async function buildTruth(address: string, options: BuildTruthOptions = {}): Promise<TruthArtifact> {
  const fast = options.fast ?? false;
  const dex=await fetchDex(address);
  const discovered=dex.candidates.sort((a,b)=>{const liquidity=(b.liquidityUsd??-1)-(a.liquidityUsd??-1);return liquidity!==0?liquidity:(b.volume24hUsd??-1)-(a.volume24hUsd??-1);});
  const verified=await verifyPools(discovered, options.preferredPool, fast);
  const candidates=verified.candidates,selected=verified.selected;
  const onchainEvidencePromise=!fast&&verified.onchain
    ? fetchOnchainEvidence(verified.onchain,{allowLiveFeeGrowth:true})
    : Promise.resolve(null);
  const statuses:SourceStatus[]=[
    {...dex.status,transport:"PUBLIC_ENDPOINT"},
    ...verified.statuses,
    {source:"okx",status:"BLOCKED",fetchedAt:now(),failureState:"BLOCKED_AUTH",error:"OFFICIAL_API_KEY_NOT_CONFIGURED",transport:"OFFICIAL_API"},
    {source:"vfat",status:"BLOCKED",fetchedAt:now(),failureState:"BLOCKED_EVIDENCE",error:"NO_TOKEN_SCOPED_PUBLIC_SURFACE_YET",transport:"HTML_DOM"}
  ];

  let ohlcv5m:Ohlcv[]=[],ohlcv30m:Ohlcv[]=[],ohlcv1h:Ohlcv[]=[],ohlcv1d:Ohlcv[]=[];
  let historyReady=false;
  if(selected){
    if(fast){
      const [paprika1h,gecko1h]=await Promise.all([
        fetchPaprikaOhlcv(selected,"1h",7),
        fetchOhlcv(selected,60,168)
      ]);
      statuses.push({...paprika1h.status,transport:"PUBLIC_ENDPOINT"});
      statuses.push({...gecko1h.status,transport:"PUBLIC_ENDPOINT"});
      const paprikaReady=historyIsReady(paprika1h.rows,paprika1h.status.status==="READY");
      const geckoReady=historyIsReady(gecko1h.rows,gecko1h.status.status==="READY");
      ohlcv1h=paprikaReady||!geckoReady?paprika1h.rows:gecko1h.rows;
      historyReady=paprikaReady||geckoReady;
    }else{
      const [paprika,gecko]=await Promise.all([
        Promise.all([
          fetchPaprikaOhlcv(selected,"5m",1),
          fetchPaprikaOhlcv(selected,"30m",1),
          fetchPaprikaOhlcv(selected,"1h",7),
          fetchPaprikaOhlcv(selected,"24h",7)
        ]),
        Promise.all([
          fetchOhlcv(selected,5,12),
          fetchOhlcv(selected,30,48),
          fetchOhlcv(selected,60,168),
          fetchOhlcv(selected,1440,10)
        ])
      ]);
      const paprikaStatus=paprika.find((x)=>x.rows.length)?.status??paprika.find((x)=>x.status.status==="BLOCKED")?.status;
      const geckoStatus=gecko.find((x)=>x.rows.length)?.status??gecko.find((x)=>x.status.status==="BLOCKED")?.status;
      if(paprikaStatus)statuses.push({...paprikaStatus,transport:"PUBLIC_ENDPOINT"});
      if(geckoStatus)statuses.push({...geckoStatus,transport:"PUBLIC_ENDPOINT"});
      const paprikaReady=historyIsReady(paprika[2].rows,paprikaStatus?.status==="READY");
      const geckoReady=historyIsReady(gecko[2].rows,geckoStatus?.status==="READY");
      const primary=paprikaReady||!geckoReady?paprika:gecko;
      const secondary=primary===paprika?gecko:paprika;
      ohlcv5m=primary[0].rows.length?primary[0].rows:secondary[0].rows;
      ohlcv30m=primary[1].rows.length?primary[1].rows:secondary[1].rows;
      ohlcv1h=primary[2].rows.length?primary[2].rows:secondary[2].rows;
      ohlcv1d=primary[3].rows.length?primary[3].rows:secondary[3].rows;
      historyReady=paprikaReady||geckoReady;
    }
  }

  const onchainEvidence=await onchainEvidencePromise;
  const price=selected?.priceUsd??(ohlcv1h.at(-1)?.close??null);
  const supportedChain = selected === null || lower(selected.chainId) === "robinhood" || selected.chainId === "4663" || lower(selected.chainId) === "robinhood-chain";
  const conflicts=comparablePriceConflicts(candidates,selected);
  const latestHistoryTs=ohlcv1h.length?Math.max(...ohlcv1h.map((x)=>x.timestamp)):null;
  const freshnessSeconds=latestHistoryTs===null?null:Math.max(0,Math.floor(Date.now()/1000-latestHistoryTs));
  const wickPenalty=ohlcv1h.some((x)=>x.high>Math.max(x.open,x.close)*1.25||x.low<Math.min(x.open,x.close)*.75);
  const onchainReady=Boolean(verified.onchain?.canonical&&verified.onchain.feeTier>0&&Number.isFinite(verified.onchain.currentTick)&&BigInt(verified.onchain.activeLiquidityRaw)>0n);
  const marketReady=dex.status.status==="READY";
  const preferredAnchored=Boolean(options.preferredPool&&selected?.poolAddress.toLowerCase()===options.preferredPool.toLowerCase());
  const baseB=marketReady&&historyReady&&onchainReady&&(preferredAnchored||conflicts.length===0);
  const feeGrowthA=Boolean(onchainEvidence?.feeGrowth.verified&&(onchainEvidence.feeGrowth.observedWindowSeconds??0)>=5&&onchainEvidence.feeGrowth.feeGrowthGlobal0X128DeltaRaw!==null&&onchainEvidence.feeGrowth.feeGrowthGlobal1X128DeltaRaw!==null);
  const gradeA=Boolean(baseB&&onchainEvidence?.tickLiquidity.verified&&feeGrowthA);

  let enhancements:Awaited<ReturnType<typeof probePublicEnhancements>>=[];
  if(!fast || !marketReady || !historyReady){
    enhancements=await probePublicEnhancements(address);
    statuses.push(...enhancements.map((x):SourceStatus=>({source:x.receipt.source,status:x.receipt.status,fetchedAt:x.fetchedAt,failureState:x.receipt.status==="READY"?null:"BLOCKED_EVIDENCE",error:x.receipt.error,transport:x.receipt.transport,url:x.receipt.url,contentSha256:x.receipt.contentSha256})));
  }
  const surfaceReceipts=enhancements.map((x)=>x.receipt);
  const sourceReceipts=statuses.map((s)=>({
    source:s.source,transport:s.transport??null,url:s.url??null,fetchedAt:s.fetchedAt,status:s.status,
    failureState:s.failureState,error:s.error,contentSha256:s.contentSha256??null,
  }));
  const truthReceipts=[
    {sourceUrl:null,transport:"PUBLIC_ENDPOINT" as const,asOf:latestHistoryTs===null?null:new Date(latestHistoryTs*1000).toISOString(),contentSha256:hash({ohlcv5m,ohlcv30m,ohlcv1h,ohlcv1d}),blockNumber:null,rpcUrl:null,conflicts, failureState:historyReady?null:"BLOCKED_EVIDENCE" as const},
    {sourceUrl:verified.onchain?.poolAddress??null,transport:"RPC" as const,asOf:now(),contentSha256:hash(verified.onchain),blockNumber:onchainEvidence?.feeGrowth?.toBlock??onchainEvidence?.tickLiquidity?.blockNumber??null,rpcUrl:onchainEvidence?.feeGrowth?.rpcUrl??onchainEvidence?.tickLiquidity?.rpcUrl??null,conflicts, failureState:gradeA?null:(baseB?null:"BLOCKED_EVIDENCE" as const)},
  ];
  const grade:"A"|"B"|"C"|"D"=gradeA?"A":baseB?"B":marketReady&&historyReady?"C":marketReady?"C":"D";
  const failureState = !supportedChain ? "BLOCKED_DATA" as const : grade === "D" ? "BLOCKED_EVIDENCE" as const : null;
  const recent24h=ohlcv30m.length?ohlcv30m:ohlcv1h.slice(-24);

  return {
    schemaVersion:"lp-truth-v1",request:{tokenAddress:address},timestamp:now(),selectedPool:selected,poolCandidates:candidates,verifiedPools:verified.verifiedPools,onchainPool:verified.onchain,
    poolSelection:{method:"VERIFIED_CAPACITY_ADJUSTED_FEE_VELOCITY",verifiedCandidates:verified.verifiedPools.length,capacityLiquidityTargetUsd:CAPACITY_LIQUIDITY_TARGET_USD,feeBasis:"VOLUME_X_FEE_TIER_PROXY"},
    market:{priceUsd:price,high24hUsd:max(recent24h),low24hUsd:min(recent24h),high7dUsd:max(ohlcv1h),low7dUsd:min(ohlcv1h),volume5mUsd:sum(ohlcv5m.slice(-1)),volume30mUsd:sum(ohlcv30m.slice(-1)),volume1hUsd:sum(ohlcv1h.slice(-1)),volume24hUsd:selected?.volume24hUsd??null,tvlUsd:selected?.liquidityUsd??null,activeLiquidityUsd:null,feeTier:verified.onchain?.feeTier??selected?.feeTier??null,poolAgeDays:selected?.poolAgeDays??null,tick:{current:verified.onchain?.currentTick??null,lower:null,upper:null},holderFlow:null},
    history:{ohlcv5m,ohlcv30m,ohlcv1h,ohlcv1d},
    onchainEvidence:{tickLiquidity:onchainEvidence?.tickLiquidity??null,feeGrowth:onchainEvidence?.feeGrowth??null,directionalSwaps:null},
    evidence:{grade,freshnessSeconds,conflicts,wickPenalty,sources:collapseStatuses(statuses),surfaceReceipts},
    receipts:{source:sourceReceipts,truth:truthReceipts},
    failureState,
  };
}
