import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTruth } from "../src/index.js";

const PONS = "0x39dbed3a2bd333467115de45665cc57f813c4571";

test("artifact contract keeps unknowns null and discovers candidates", async () => {
  const a = await buildTruth(PONS);
  assert.equal(a.schemaVersion, "lp-truth-v1");
  assert.ok(a.poolCandidates.length >= 1);
  assert.ok(a.market.priceUsd !== null);
  assert.ok(["A", "B", "C", "D"].includes(a.evidence.grade));
  if (a.evidence.grade === "A") {
    assert.ok(a.market.high7dUsd !== null);
    assert.ok(a.market.low7dUsd !== null);
    assert.ok(a.onchainEvidence.tickLiquidity?.verified);
    assert.ok(a.onchainEvidence.feeGrowth?.verified);
  }
  assert.equal(a.market.activeLiquidityUsd, null, "raw V3 liquidity must not be mislabeled as USD liquidity");
  assert.equal(a.receipts.truth.length, 2);

  if (a.onchainPool) {
    assert.equal(a.onchainPool.canonical, true);
    assert.ok(a.onchainPool.feeTier > 0);
    assert.ok(Number.isFinite(a.onchainPool.currentTick));
    assert.ok(BigInt(a.onchainPool.activeLiquidityRaw) > 0n);
    assert.equal(a.market.feeTier, a.onchainPool.feeTier);
    assert.equal(a.market.tick.current, a.onchainPool.currentTick);
  }
});
