import type { FeeGrowthEvidence, OnchainPoolTruth, TickLiquidityEvidence } from "./schema.js";

const RPC_URLS = [
  "https://rpc.mainnet.chain.robinhood.com",
  "https://rpc.nodeflare.app/robinhood/public",
  "https://robinhood-rpc.publicnode.com",
] as const;
const CHAIN_ID = 4663n;
const TICK_LENS = "0x7dfd4f31be6814d2906bde155c3e1b146eac1468";
const GET_POPULATED_TICKS = "0x351fb478";
const FEE_GROWTH_0 = "0xf3058399";
const FEE_GROWTH_1 = "0x46141319";
const UINT256_MOD = 1n << 256n;

type RpcBlock = { number:string; timestamp:string };
type PopulatedTick = { tick:number; liquidityNetRaw:string; liquidityGrossRaw:string };
type FeeSnapshot = { block:string; timestamp:number; fee0:bigint; fee1:bigint };
const clean=(x:string)=>x.startsWith("0x")?x.slice(2):x;
const word=(hex:string,i:number)=>clean(hex).slice(i*64,(i+1)*64).padStart(64,"0");
const u=(hex:string,i=0)=>BigInt(`0x${word(hex,i)}`);
const signed=(hex:string,i:number,bits:number)=>BigInt.asIntN(bits,u(hex,i));
const encAddress=(address:string)=>address.toLowerCase().replace(/^0x/,"").padStart(64,"0");
const encSigned=(value:number)=>BigInt.asUintN(256,BigInt(value)).toString(16).padStart(64,"0");
const hexBlock=(n:bigint)=>`0x${n.toString(16)}`;
const sleep=(ms:number)=>new Promise((resolve)=>setTimeout(resolve,ms));
const err=(e:unknown)=>e instanceof Error?e.message:"FAILED";

async function rpc<T>(url:string,method:string,params:unknown[]):Promise<T>{
  let last="RPC_FAILED";
  for(let attempt=0;attempt<2;attempt++){
    try{
      const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json","accept":"application/json","user-agent":"lp-truth-gateway/1.4"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params}),signal:AbortSignal.timeout(8_000)});
      if(!response.ok){last=`RPC_HTTP_${response.status}`;if(response.status===403||response.status===429||response.status>=500){await sleep(150*(attempt+1));continue;}throw new Error(last);}
      const body=await response.json() as {result?:T;error?:{code?:number;message?:string}};
      if(body.error)throw new Error(`RPC_${body.error.code??"ERROR"}:${body.error.message??"UNKNOWN"}`);
      if(body.result===undefined||body.result===null)throw new Error("RPC_NO_RESULT");
      return body.result;
    }catch(error){last=err(error);if(attempt===0)await sleep(150);}
  }
  throw new Error(last);
}
async function assertChain(url:string):Promise<void>{const id=await rpc<string>(url,"eth_chainId",[]);if(BigInt(id)!==CHAIN_ID)throw new Error(`CHAIN_ID_MISMATCH:${id}`);}
async function call(url:string,to:string,data:string,blockTag:string):Promise<string>{return rpc<string>(url,"eth_call",[{to,data},blockTag]);}
async function block(url:string,tag:string):Promise<RpcBlock>{return rpc<RpcBlock>(url,"eth_getBlockByNumber",[tag,false]);}

export function tickWordPosition(currentTick:number,tickSpacing:number):number{
  if(!Number.isInteger(currentTick)||!Number.isInteger(tickSpacing)||tickSpacing<=0)throw new Error("INVALID_TICK_INPUT");
  let compressed=Math.trunc(currentTick/tickSpacing);if(currentTick<0&&currentTick%tickSpacing!==0)compressed--;return Math.floor(compressed/256);
}
export function decodePopulatedTicks(hex:string):PopulatedTick[]{
  const body=clean(hex);if(body.length<128)return[];
  const offset=Number(BigInt(`0x${word(hex,0)}`)/32n);if(!Number.isSafeInteger(offset)||offset<0)return[];
  const length=Number(u(hex,offset));if(!Number.isSafeInteger(length)||length<0||length>256)return[];
  const out:PopulatedTick[]=[];for(let i=0;i<length;i++){const base=offset+1+i*3;out.push({tick:Number(signed(hex,base,24)),liquidityNetRaw:signed(hex,base+1,128).toString(),liquidityGrossRaw:u(hex,base+2).toString()});}return out;
}
function tickLensData(pool:string,bitmapWord:number):string{return `${GET_POPULATED_TICKS}${encAddress(pool)}${encSigned(bitmapWord)}`;}
function pct(numerator:bigint,denominator:bigint):number|null{if(denominator<=0n)return null;return Math.max(0,Math.min(100,Number((numerator*1_000_000n)/denominator)/10_000));}

async function tickVia(url:string,pool:OnchainPoolTruth,blockTag:string|undefined,wordRadius:number):Promise<TickLiquidityEvidence>{
  await assertChain(url);
  const tag=blockTag??await rpc<string>(url,"eth_blockNumber",[]),center=tickWordPosition(pool.currentTick,pool.tickSpacing),words=Array.from({length:wordRadius*2+1},(_,i)=>center-wordRadius+i);
  const encoded=await Promise.all(words.map((bitmapWord)=>call(url,TICK_LENS,tickLensData(pool.poolAddress,bitmapWord),tag)));
  const decoded=encoded.flatMap(decodePopulatedTicks);
  const unique=[...new Map(decoded.map(x=>[x.tick,x])).values()].sort((a,b)=>a.tick-b.tick),below=unique.filter(x=>x.tick<=pool.currentTick).at(-1)?.tick??null,above=unique.find(x=>x.tick>pool.currentTick)?.tick??null;
  const gross=unique.map(x=>BigInt(x.liquidityGrossRaw)),total=gross.reduce((a,b)=>a+b,0n),top5=[...gross].sort((a,b)=>a===b?0:a>b?-1:1).slice(0,5).reduce((a,b)=>a+b,0n);
  return {verified:unique.length>0,source:"UNISWAP_V3_TICKLENS",rpcUrl:url,tickLens:TICK_LENS,blockNumber:tag,currentTick:pool.currentTick,tickSpacing:pool.tickSpacing,wordRadius,wordsQueried:words.length,initializedTickCount:unique.length,nearestBelowTick:below,nearestAboveTick:above,nearestBelowDistance:below===null?null:pool.currentTick-below,nearestAboveDistance:above===null?null:above-pool.currentTick,totalLiquidityGrossRaw:total.toString(),top5GrossLiquidityConcentrationPct:pct(top5,total),error:unique.length?null:"NO_INITIALIZED_TICKS_IN_WINDOW"};
}
export async function fetchTickLiquidityEvidence(pool:OnchainPoolTruth,blockTag?:string,wordRadius=2):Promise<TickLiquidityEvidence>{
  try{
    return await Promise.any(RPC_URLS.map(async(url)=>{try{return await tickVia(url,pool,blockTag,wordRadius);}catch(error){throw new Error(`${new URL(url).hostname}:${err(error)}`);}}));
  }catch(error){
    const details=error instanceof AggregateError?error.errors.map(err).join("|"):err(error);
    return {verified:false,source:"UNISWAP_V3_TICKLENS",rpcUrl:null,tickLens:TICK_LENS,blockNumber:blockTag??null,currentTick:pool.currentTick,tickSpacing:pool.tickSpacing,wordRadius,wordsQueried:0,initializedTickCount:0,nearestBelowTick:null,nearestAboveTick:null,nearestBelowDistance:null,nearestAboveDistance:null,totalLiquidityGrossRaw:"0",top5GrossLiquidityConcentrationPct:null,error:`ALL_RPC_FAILED:${details}`};
  }
}

async function historicalBlock(url:string,latest:RpcBlock,desiredSeconds:number):Promise<RpcBlock>{
  const latestN=BigInt(latest.number),latestTs=Number(BigInt(latest.timestamp)),probeN=latestN>5000n?latestN-5000n:0n,probe=await block(url,hexBlock(probeN)),probeTs=Number(BigInt(probe.timestamp)),span=Number(latestN-probeN);
  let secondsPerBlock=span>0?(latestTs-probeTs)/span:1;if(!Number.isFinite(secondsPerBlock)||secondsPerBlock<=0)secondsPerBlock=1;
  let guess=latestN-BigInt(Math.max(1,Math.round(desiredSeconds/secondsPerBlock)));if(guess<0n)guess=0n;let candidate=await block(url,hexBlock(guess));
  for(let i=0;i<2;i++){const observed=latestTs-Number(BigInt(candidate.timestamp)),error=desiredSeconds-observed;if(Math.abs(error)<=90)break;guess-=BigInt(Math.round(error/secondsPerBlock));if(guess<0n)guess=0n;if(guess>=latestN)guess=latestN-1n;candidate=await block(url,hexBlock(guess));}return candidate;
}
function delta256(current:bigint,previous:bigint):bigint{return(current-previous+UINT256_MOD)%UINT256_MOD;}
async function feeSnapshot(url:string,pool:OnchainPoolTruth):Promise<FeeSnapshot>{
  const tag=await rpc<string>(url,"eth_blockNumber",[]),meta=await block(url,tag),[fee0Hex,fee1Hex]=await Promise.all([call(url,pool.poolAddress,FEE_GROWTH_0,tag),call(url,pool.poolAddress,FEE_GROWTH_1,tag)]);
  return {block:tag,timestamp:Number(BigInt(meta.timestamp)),fee0:u(fee0Hex),fee1:u(fee1Hex)};
}
function fromSnapshots(url:string,requestedWindowSeconds:number,from:FeeSnapshot,to:FeeSnapshot,mode:"ARCHIVE_WINDOW"|"LIVE_DELTA",archiveReadVerified:boolean):FeeGrowthEvidence{
  const d0=delta256(to.fee0,from.fee0),d1=delta256(to.fee1,from.fee1);
  return {verified:BigInt(to.block)>BigInt(from.block),source:"UNISWAP_V3_POOL",mode,rpcUrl:url,requestedWindowSeconds,observedWindowSeconds:Math.max(0,to.timestamp-from.timestamp),fromBlock:from.block,toBlock:to.block,fromTimestamp:from.timestamp,toTimestamp:to.timestamp,feeGrowthGlobal0X128DeltaRaw:d0.toString(),feeGrowthGlobal1X128DeltaRaw:d1.toString(),nonZeroGrowth:d0>0n||d1>0n,archiveReadVerified,error:null};
}
async function feeGrowthArchive(url:string,pool:OnchainPoolTruth,requestedWindowSeconds:number):Promise<FeeGrowthEvidence>{
  await assertChain(url);const latestTag=await rpc<string>(url,"eth_blockNumber",[]),latest=await block(url,latestTag),previous=await historicalBlock(url,latest,requestedWindowSeconds);
  const [from0,from1,to0,to1]=await Promise.all([
    call(url,pool.poolAddress,FEE_GROWTH_0,previous.number),call(url,pool.poolAddress,FEE_GROWTH_1,previous.number),call(url,pool.poolAddress,FEE_GROWTH_0,latest.number),call(url,pool.poolAddress,FEE_GROWTH_1,latest.number)
  ]);
  const from:FeeSnapshot={block:previous.number,timestamp:Number(BigInt(previous.timestamp)),fee0:u(from0),fee1:u(from1)};
  const to:FeeSnapshot={block:latest.number,timestamp:Number(BigInt(latest.timestamp)),fee0:u(to0),fee1:u(to1)};
  return fromSnapshots(url,requestedWindowSeconds,from,to,"ARCHIVE_WINDOW",true);
}
async function feeGrowthLive(url:string,pool:OnchainPoolTruth,requestedWindowSeconds:number):Promise<FeeGrowthEvidence>{
  await assertChain(url);const from=await feeSnapshot(url,pool);await sleep(5200);const to=await feeSnapshot(url,pool);return fromSnapshots(url,requestedWindowSeconds,from,to,"LIVE_DELTA",false);
}
async function raceEvidence(kind:"ARCHIVE"|"LIVE",pool:OnchainPoolTruth,requestedWindowSeconds:number):Promise<FeeGrowthEvidence>{
  return Promise.any(RPC_URLS.map(async(url)=>{try{return kind==="ARCHIVE"?await feeGrowthArchive(url,pool,requestedWindowSeconds):await feeGrowthLive(url,pool,requestedWindowSeconds);}catch(error){throw new Error(`${kind}:${new URL(url).hostname}:${err(error)}`);}}));
}
export async function fetchFeeGrowthEvidence(pool:OnchainPoolTruth,requestedWindowSeconds=3600,allowLive=true):Promise<FeeGrowthEvidence>{
  const errors:string[]=[];
  try{return await raceEvidence("ARCHIVE",pool,requestedWindowSeconds);}catch(error){errors.push(error instanceof AggregateError?error.errors.map(err).join("|"):err(error));}
  if(allowLive){try{return await raceEvidence("LIVE",pool,requestedWindowSeconds);}catch(error){errors.push(error instanceof AggregateError?error.errors.map(err).join("|"):err(error));}}
  return {verified:false,source:"UNISWAP_V3_POOL",mode:null,rpcUrl:null,requestedWindowSeconds,observedWindowSeconds:null,fromBlock:null,toBlock:null,fromTimestamp:null,toTimestamp:null,feeGrowthGlobal0X128DeltaRaw:null,feeGrowthGlobal1X128DeltaRaw:null,nonZeroGrowth:false,archiveReadVerified:false,error:`ALL_RPC_FAILED:${errors.join("|")}`};
}
export async function fetchOnchainEvidence(pool:OnchainPoolTruth,options?:{allowLiveFeeGrowth?:boolean}):Promise<{tickLiquidity:TickLiquidityEvidence;feeGrowth:FeeGrowthEvidence}>{
  const [tickLiquidity,feeGrowth]=await Promise.all([fetchTickLiquidityEvidence(pool),fetchFeeGrowthEvidence(pool,3600,options?.allowLiveFeeGrowth??true)]);
  return{tickLiquidity,feeGrowth};
}
