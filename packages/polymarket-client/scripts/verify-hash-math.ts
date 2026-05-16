import { keccak256, concat, type Hex } from "viem";

const appDomainSep = "0xcfc66be2a3b30464cb3b588324101f660c9a205fa76e8e5f83ee16a528e1c4cb" as Hex;
const contentsHash = "0x1124942433330d6d0b18c84fdbc7c1ef8cde85700620fc75fd1163e542c827aa" as Hex;
const outerHash = "0xefb23789f29805e5a440e0db611a5f27536f25c0f4759d6655971f4b478b586b" as Hex;

const reconstructed = keccak256(
  concat([
    "0x1901" as Hex,
    appDomainSep,
    contentsHash,
  ]),
);

console.log(`reconstructed: ${reconstructed}`);
console.log(`outerHash:     ${outerHash}`);
console.log(`match:         ${reconstructed === outerHash}`);
