import { fetchOnchainEvidence } from "./onchain-evidence.js";
import { fetchUniswapV3State } from "./onchain.js";
import { fetchDex, fetchOhlcv, fetchPaprikaOhlcv } from "./sources.js";
import { probePublicEnhancements } from "./surface.js";
import type { Ohlcv, OnchainPoolTruth, PoolCandidate, SourceStatus, TruthArtifact } from "./schema.js";

const CAPACITY_LIQUIDITY_TARGET_USD = 100_000;
const now = () => new Date().toISOString();
const max = (rows: Ohlcv[]) => rows.length ? Math.max(...rows.map((x) => x.high)) : null;
const min = (rows: Ohlcv[]) => rows.length ? Math.min(...rows.map((x) => x.low)) : null;
const sum = (rows: Ohlcv[]) => rows.length ? rows.reduce((total, x) => total + x.volumeUsd, 0) : null;
const lower = (x: string | null) => x?.toLowerCase() ?? null;
const isV3Address = (x: string) => /^0x[0-9a-fA-F]{40}$/.test(x);

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

async function verifyPools(candidates: PoolCandidate[]): Promise<{ candidates:PoolCandidate[]; verifiedPools:OnchainPoolTruth[]; selected:PoolCandidate|null; onchain:OnchainPoolTruth|null; statuses:SourceStatus[] }> {
  const eligible = candidates.filter((p) => lower(p.chainId) === "robinhood" || p.chainId === "4663" || lower(p.chainId) === "robinhood-chain").filter((p) => lower(p.dexId)?.includes("uniswap")).filter((p) => isV3Address(p.poolAddress)).slice(0,8);
  const proofByPool = new Map<string, OnchainPoolTruth>();
  const statuses: SourceStatus[] = [];
  for (let i=0;i<eligible.length;i+=2) {
    const batch=await Promise.all(eligible.slice(i,i+2).map((candidate)=>fetchUniswapV3State(candidate)));
    for(const result of batch){statuses.push(...result.statuses);const proof=toTruthPool(result.state);if(proof?.canonical)proofByPool.set(proof.poolAddress.toLowerCase(),proof);}
  }
  const enriched=candidates.map((candidate)=>{
    const proof=proofByPool.get(candidate.poolAddress.toLowerCase()); if(!proof)return candidate;
    const grossFee24hUsd=candidate.volume24hUsd===null?null:candidate.volume24hUsd*(proof.feeTier/1_000_000);
    const feeVelocity24h=grossFee24hUsd!==null&&candidate.liquidityUsd!==null&&candidate.liquidityUsd>0?grossFee24hUsd/candidate.liquidityUsd:null;
    const capacityFactor=candidate.liquidityUsd===null?null:Math.min(1,candidate.liquidityUsd/CAPACITY_LIQUIDITY_TARGET_USD);
    const capacityAdjustedFeeVelocity24h=feeVelocity24h===null||capacityFactor===null?null:feeVelocity24h*capacityFactor;
    return {...candidate,feeTier:proof.feeTier,grossFee24hUsd,feeVelocity24h,capacityAdjustedFeeVelocity24h};
  });
  const verifiedCandidates=enriched.filter((candidate)=>proofByPool.has(candidate.poolAddress.toLowerCase()));
  verifiedCandidates.sort((a,b)=>{const adjusted=(b.capacityAdjustedFeeVelocity24h??-1)-(a.capacityAdjustedFeeVelocity24h??-1);if(adjusted!==0)return adjusted;const raw=(b.feeVelocity24h??-1)-(a.feeVelocity24h??-1);return raw!==0?raw:(b.liquidityUsd??-1)-(a.liquidityUsd??-1);});
  const selected=verifiedCandidates[0]??enriched[0]??null;
  const onchain=selected?proofByPool.get(selected.poolAddress.toLowerCase())??null:null;
  const collapsed=collapseStatuses(statuses);
  if(!collapsed.length)collapsed.push({source:"rpc",status:"BLOCKED",fetchedAt:now(),failureState:"BLOCKED_DATA",error:"NO_SUPPORTED_ONCHAIN_POOL",transport:"RPC"},{source:"uniswap",status:"BLOCKED",fetchedAt:now(),failureState:"BLOCKED_EVIDENCE",error:"NO_CANONICAL_V3_POOL_PROOF",transport:"RPC"});
  return {
    candidates:enriched.sort((a,b)=>{const va=proofByPool.has(a.poolAddress.toLowerCase())?1:0,vb=proofByPool.has(b.poolAddress.toLowerCase())?1:0;if(va!==vb)return vb-va;const adjusted=(b.capacityAdjustedFeeVelocity24h??-1)-(a.capacityAdjustedFeeVelocity24h??-1);return adjusted!==0?adjusted:(b.liquidityUsd??-1)-(a.liquidityUsd??-1);}),
    verifiedPools:[...proofByPool.values()],selected,onchain,statuses:collapsed,
  };
}

export async function buildTruth(address: string): Promise<TruthArtifact> {
  const enhancementPromise=probePublicEnhancements(address);
  const dex=await fetchDex(address);
  const discovered=dex.candidates.sort((a,b)=>{const liquidity=(b.liquidityUsd??-1)-(a.liquidityUsd??-1);return liquidity!==0?liquidity:(b.volume24hUsd??-1)-(a.volume24hUsd??-1);});
  const verified=await verifyPools(discovered);
  const candidates=verified.candidates,selected=verified.selected;
  const onchainEvidencePromise=verified.onchain?fetchOnchainEvidence(verified.onchain):Promise.resolve(null);
  const statuses:SourceStatus[]=[{...dex.status,transport:"PUBLIC_ENDPOINT"},...verified.statuses,{source:"okx",status:"BLOCKED",fetchedAt:now(),failureState:"BLOCKED_AUTH",error:"OFFICIAL_API_KEY_NOT_CONFIGURED",transport:"OFFICIAL_API"},{source:"vfat",status:"BLOCKED",fetchedAt:now(),failureState:"BLOCKED_EVIDENCE",error:"NO_TOKEN_SCOPED_PUBLIC_SURFACE_YET",transport:"HTML_DOM"}];

  let ohlcv5m:Ohlcv[]=[],ohlcv30m:Ohlcv[]=[],ohlcv1h:Ohlcv[]=[],ohlcv1d:Ohlcv[]=[];
  let historyReady=false;
  if(selected){
    const paprika=await Promise.all([fetchPaprikaOhlcv(selected,"5m",1),fetchPaprikaOhlcv(selected,"30m",1),fetchPaprikaOhlcv(selected,"1h",7),fetchPaprikaOhlcv(selected,"24h",7)]);
    [ohlcv5m,ohlcv30m,ohlcv1h,ohlcv1d]=paprika.map((x)=>x.rows);
    const paprikaStatus=paprika.find((x)=>x.rows.length)?.status??paprika.find((x)=>x.status.status==="BLOCKED")?.status;
    if(paprikaStatus)statuses.push({...paprikaStatus,transport:"PUBLIC_ENDPOINT"});
    historyReady=ohlcv1h.length>0&&paprikaStatus?.status==="READY";
    if(!historyReady){
      const gecko=await Promise.all([fetchOhlcv(selected,5,12),fetchOhlcv(selected,30,48),fetchOhlcv(selected,60,168),fetchOhlcv(selected,1440,10)]);
      const geckoStatus=gecko.find((x)=>x.rows.length)?.status??gecko.find((x)=>x.status.status==="BLOCKED")?.status;
      if(geckoStatus)statuses.push({...geckoStatus,transport:"PUBLIC_ENDPOINT"});
      if(gecko[0].rows.length)ohlcv5m=gecko[0].rows;if(gecko[1].rows.length)ohlcv30m=gecko[1].rows;if(gecko[2].rows.length)ohlcv1h=gecko[2].rows;if(gecko[3].rows.length)ohlcv1d=gecko[3].rows;
      historyReady=ohlcv1h.length>0&&geckoStatus?.status==="READY";
    }
  }

  const [enhancements,onchainEvidence]=await Promise.all([enhancementPromise,onchainEvidencePromise]);
  const surfaceReceipts=enhancements.map((x)=>x.receipt);
  statuses.push(...enhancements.map((x):SourceStatus=>({source:x.receipt.source,status:x.receipt.status,fetchedAt:x.fetchedAt,failureState:x.receipt.status==="READY"?null:"BLOCKED_EVIDENCE",error:x.receipt.error,transport:x.receipt.transport})));

  const price=selected?.priceUsd??(ohlcv1h.at(-1)?.close??null);
  const conflicts=comparablePriceConflicts(candidates,selected);
  const latestHistoryTs=ohlcv1h.length?Math.max(...ohlcv1h.map((x)=>x.timestamp)):null;
  const freshnessSeconds=latestHistoryTs===null?null:Math.max(0,Math.floor(Date.now()/1000-latestHistoryTs));
  const wickPenalty=ohlcv1h.some((x)=>x.high>Math.max(x.open,x.close)*1.25||x.low<Math.min(x.open,x.close)*.75);
  const onchainReady=Boolean(verified.onchain?.canonical&&verified.onchain.feeTier>0&&Number.isFinite(verified.onchain.currentTick)&&BigInt(verified.onchain.activeLiquidityRaw)>0n);
  const marketReady=dex.status.status==="READY";
  const baseB=marketReady&&historyReady&&onchainReady&&conflicts.length===0;
  const gradeA=Boolean(baseB&&onchainEvidence?.tickLiquidity.verified&&onchainEvidence?.feeGrowth.verified&&onchainEvidence.feeGrowth.archiveReadVerified);
  const grade:"A"|"B"|"C"|"D"=gradeA?"A":baseB?"B":marketReady&&historyReady?"C":marketReady?"C":"D";

  return {
    schemaVersion:"lp-truth-v1",request:{tokenAddress:address},timestamp:now(),selectedPool:selected,poolCandidates:candidates,verifiedPools:verified.verifiedPools,onchainPool:verified.onchain,
    poolSelection:{method:"VERIFIED_CAPACITY_ADJUSTED_FEE_VELOCITY",verifiedCandidates:verified.verifiedPools.length,capacityLiquidityTargetUsd:CAPACITY_LIQUIDITY_TARGET_USD,feeBasis:"VOLUME_X_FEE_TIER_PROXY"},
    market:{priceUsd:price,high24hUsd:max(ohlcv30m),low24hUsd:min(ohlcv30m),high7dUsd:max(ohlcv1h),low7dUsd:min(ohlcv1h),volume5mUsd:sum(ohlcv5m.slice(-1)),volume30mUsd:sum(ohlcv30m.slice(-1)),volume1hUsd:sum(ohlcv1h.slice(-1)),volume24hUsd:selected?.volume24hUsd??null,tvlUsd:selected?.liquidityUsd??null,activeLiquidityUsd:null,feeTier:verified.onchain?.feeTier??selected?.feeTier??null,poolAgeDays:selected?.poolAgeDays??null,tick:{current:verified.onchain?.currentTick??null,lower:null,upper:null},holderFlow:null},
    history:{ohlcv5m,ohlcv30m,ohlcv1h,ohlcv1d},
    onchainEvidence:{tickLiquidity:onchainEvidence?.tickLiquidity??null,feeGrowth:onchainEvidence?.feeGrowth??null,directionalSwaps:null},
    evidence:{grade,freshnessSeconds,conflicts,wickPenalty,sources:collapseStatuses(statuses),surfaceReceipts},
    failureState:grade==="D"?"BLOCKED_EVIDENCE":null,
  };
}
