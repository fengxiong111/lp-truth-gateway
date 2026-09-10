import {buildTruth} from "./src/index.js";

const args=process.argv.slice(2);
const address=args[0];
if(!address||!/^(0x)[a-fA-F0-9]{40}$/.test(address))throw new Error("INVALID_EVM_ADDRESS");
const poolIndex=args.indexOf("--pool");
const preferredPool=poolIndex>=0?args[poolIndex+1]??null:null;
const fast=!args.includes("--deep");
console.log(JSON.stringify(await buildTruth(address,{preferredPool,fast}),null,2));
