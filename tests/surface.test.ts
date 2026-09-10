import { test } from "node:test";
import assert from "node:assert/strict";
import { readPublicSurface } from "../src/surface.js";

const PONS = "0x39dbed3a2bd333467115de45665cc57f813c4571";

test("surface transport refuses non-HTTPS or non-allowlisted targets", async () => {
  const a = await readPublicSurface({ source:"revert", url:"http://revert.finance/discover", tokenAddress:PONS, allowedHosts:["revert.finance"], browserFallback:false });
  assert.equal(a.receipt.status,"BLOCKED");
  assert.equal(a.receipt.transport,"NONE");
  assert.equal(a.receipt.error,"UNSAFE_OR_UNAPPROVED_URL");
  assert.equal(a.receipt.contentSha256,null);
});

test("surface receipt never upgrades evidence merely because a page exists", async () => {
  const a = await readPublicSurface({ source:"revert", url:"https://example.com/", tokenAddress:PONS, allowedHosts:["revert.finance"], browserFallback:false });
  assert.equal(a.receipt.status,"BLOCKED");
  assert.equal(a.receipt.addressMatched,false);
});
