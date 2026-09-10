import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePopulatedTicks, tickWordPosition } from "../src/onchain-evidence.js";

const w=(n:bigint)=>BigInt.asUintN(256,n).toString(16).padStart(64,"0");

test("tickWordPosition follows V3 negative-floor compression",()=>{
  assert.equal(tickWordPosition(0,60),0);
  assert.equal(tickWordPosition(15359,60),0);
  assert.equal(tickWordPosition(15360,60),1);
  assert.equal(tickWordPosition(-1,60),-1);
  assert.equal(tickWordPosition(-15360,60),-1);
  assert.equal(tickWordPosition(-15361,60),-2);
});

test("decodes TickLens dynamic tuple array without bigint loss",()=>{
  const payload=`0x${w(32n)}${w(2n)}${w(-120n)}${w(-1234567890123456789n)}${w(9999999999999999999n)}${w(60n)}${w(1234567890123456789n)}${w(8888888888888888888n)}`;
  const rows=decodePopulatedTicks(payload);
  assert.equal(rows.length,2);
  assert.equal(rows[0].tick,-120);
  assert.equal(rows[0].liquidityNetRaw,"-1234567890123456789");
  assert.equal(rows[0].liquidityGrossRaw,"9999999999999999999");
  assert.equal(rows[1].tick,60);
  assert.equal(rows[1].liquidityNetRaw,"1234567890123456789");
});
