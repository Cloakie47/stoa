// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TracePin} from "../src/TracePin.sol";

contract TracePinTest is Test {
    TracePin internal pin;

    function setUp() public {
        pin = new TracePin();
    }

    function test_emitsEvent() public {
        bytes32 h = keccak256("trace-payload");
        string memory uri = "ipfs://bafy.../trace.json";
        address pinner = makeAddr("pinner");

        vm.expectEmit(true, true, false, true, address(pin));
        emit TracePin.TracePinned(pinner, h, uri, block.timestamp);

        vm.prank(pinner);
        pin.pinTrace(h, uri);
    }

    function test_anyoneCanPin() public {
        bytes32 h = keccak256("x");
        vm.prank(makeAddr("a"));
        pin.pinTrace(h, "u1");
        vm.prank(makeAddr("b"));
        pin.pinTrace(h, "u2");
    }
}
