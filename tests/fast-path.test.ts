import test from "node:test";
import assert from "node:assert/strict";
import type { BuildTruthOptions } from "../src/index.js";

test("fast truth options accept an exact pool hint without changing the public address contract",()=>{
  const options:BuildTruthOptions={fast:true,preferredPool:"0x"+"ab".repeat(32)};
  assert.equal(options.fast,true);
  assert.equal(options.preferredPool?.length,66);
});
