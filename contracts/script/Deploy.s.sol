// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Splitter} from "../src/Splitter.sol";
import {TracePin} from "../src/TracePin.sol";

contract Deploy is Script {
    function run() external returns (address splitterAddr, address tracePinAddr) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(pk);

        Splitter splitter = new Splitter();
        TracePin tracePin = new TracePin();

        vm.stopBroadcast();

        splitterAddr = address(splitter);
        tracePinAddr = address(tracePin);

        console2.log("Splitter deployed at:", splitterAddr);
        console2.log("TracePin deployed at:", tracePinAddr);
    }
}
