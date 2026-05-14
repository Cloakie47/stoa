// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {StoaSettler} from "../src/StoaSettler.sol";

/// @notice Deploys StoaSettler wired against the already-live Splitter, TracePin,
///         and the Arc Testnet USDC ERC-20 interface. Addresses come from env vars
///         so the same script works for any environment.
contract DeployStoaSettler is Script {
    function run() external returns (address settlerAddr) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address usdc = vm.envAddress("USDC_ADDRESS");
        address splitter = vm.envAddress("SPLITTER_ADDRESS");
        address tracePin = vm.envAddress("TRACEPIN_ADDRESS");

        vm.startBroadcast(pk);
        StoaSettler s = new StoaSettler(usdc, splitter, tracePin);
        vm.stopBroadcast();

        settlerAddr = address(s);
        console2.log("StoaSettler deployed at:", settlerAddr);
        console2.log("  USDC:    ", usdc);
        console2.log("  Splitter:", splitter);
        console2.log("  TracePin:", tracePin);
    }
}
