// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Splitter} from "../src/Splitter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";

contract SplitterTest is Test {
    Splitter internal splitter;
    MockERC20 internal usdc;

    address internal payer = makeAddr("payer");

    address[] internal recipients2;
    uint256[] internal bps2;

    address[] internal recipients4;
    uint256[] internal bps4;

    function setUp() public {
        splitter = new Splitter();
        usdc = new MockERC20("USD Coin", "USDC", 6);

        usdc.mint(payer, 1_000_000_000e6);
        vm.prank(payer);
        usdc.approve(address(splitter), type(uint256).max);

        recipients2.push(makeAddr("a"));
        recipients2.push(makeAddr("b"));
        bps2.push(6_000);
        bps2.push(4_000);

        // Stoa's 4-way split: 60 / 20 / 15 / 5
        recipients4.push(makeAddr("operator"));
        recipients4.push(makeAddr("user"));
        recipients4.push(makeAddr("polyseer"));
        recipients4.push(makeAddr("canteen"));
        bps4.push(6_000);
        bps4.push(2_000);
        bps4.push(1_500);
        bps4.push(500);
    }

    function _addrs(uint256 n) internal returns (address[] memory out) {
        out = new address[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = makeAddr(string.concat("r", vm.toString(i)));
        }
    }

    function _equalBps(uint256 n) internal pure returns (uint256[] memory out) {
        out = new uint256[](n);
        uint256 each = 10_000 / n;
        uint256 used;
        for (uint256 i; i + 1 < n; ++i) {
            out[i] = each;
            used += each;
        }
        out[n - 1] = 10_000 - used;
    }

    // ---------------------- Happy paths ----------------------

    function test_distribute_twoRecipients() public {
        uint256 amount = 1_000e6;
        uint256 balBefore0 = usdc.balanceOf(recipients2[0]);
        uint256 balBefore1 = usdc.balanceOf(recipients2[1]);

        vm.prank(payer);
        splitter.distribute(address(usdc), recipients2, bps2, amount);

        assertEq(usdc.balanceOf(recipients2[0]), balBefore0 + 600e6, "60% share");
        assertEq(usdc.balanceOf(recipients2[1]), balBefore1 + 400e6, "40% share");
        assertEq(usdc.balanceOf(address(splitter)), 0, "splitter must hold no dust");
    }

    function test_distribute_fourWayStoaSplit() public {
        uint256 amount = 100_000_000; // 100 USDC
        vm.prank(payer);
        splitter.distribute(address(usdc), recipients4, bps4, amount);

        assertEq(usdc.balanceOf(recipients4[0]), 60_000_000, "operator 60%");
        assertEq(usdc.balanceOf(recipients4[1]), 20_000_000, "user 20%");
        assertEq(usdc.balanceOf(recipients4[2]), 15_000_000, "polyseer 15%");
        assertEq(usdc.balanceOf(recipients4[3]), 5_000_000, "canteen 5%");
        assertEq(usdc.balanceOf(address(splitter)), 0, "no dust");
    }

    function test_distribute_handlesRoundingDust() public {
        // 7 wei distributed across 60/40 — integer division gives 4 and 2,
        // last recipient must absorb the remaining 1 wei.
        address[] memory r = new address[](2);
        r[0] = makeAddr("dust-a");
        r[1] = makeAddr("dust-b");
        uint256[] memory b = new uint256[](2);
        b[0] = 6_000;
        b[1] = 4_000;

        vm.prank(payer);
        splitter.distribute(address(usdc), r, b, 7);

        assertEq(usdc.balanceOf(r[0]), 4, "60% of 7 -> floor 4");
        assertEq(usdc.balanceOf(r[1]), 3, "last absorbs 3 (40% of 7 = 2 + 1 dust)");
        assertEq(usdc.balanceOf(address(splitter)), 0, "no residual");
    }

    function test_distribute_emitsEvent() public {
        uint256 amount = 1_000e6;
        vm.expectEmit(true, true, false, true, address(splitter));
        emit Splitter.Distributed(address(usdc), payer, amount, recipients2, bps2);

        vm.prank(payer);
        splitter.distribute(address(usdc), recipients2, bps2, amount);
    }

    // ---------------------- Validation ----------------------

    function test_revert_emptyRecipients() public {
        address[] memory r = new address[](0);
        uint256[] memory b = new uint256[](0);
        vm.expectRevert(Splitter.ZeroRecipients.selector);
        vm.prank(payer);
        splitter.distribute(address(usdc), r, b, 1e6);
    }

    function test_revert_lengthMismatch() public {
        address[] memory r = new address[](2);
        r[0] = recipients2[0];
        r[1] = recipients2[1];
        uint256[] memory b = new uint256[](1);
        b[0] = 10_000;
        vm.expectRevert(Splitter.LengthMismatch.selector);
        vm.prank(payer);
        splitter.distribute(address(usdc), r, b, 1e6);
    }

    function test_revert_zeroAmount() public {
        vm.expectRevert(Splitter.ZeroAmount.selector);
        vm.prank(payer);
        splitter.distribute(address(usdc), recipients2, bps2, 0);
    }

    function test_revert_bpsSumLow() public {
        uint256[] memory b = new uint256[](2);
        b[0] = 5_000;
        b[1] = 4_000; // sums to 9_000
        vm.expectRevert(abi.encodeWithSelector(Splitter.InvalidBpsSum.selector, 9_000));
        vm.prank(payer);
        splitter.distribute(address(usdc), recipients2, b, 1e6);
    }

    function test_revert_bpsSumHigh() public {
        uint256[] memory b = new uint256[](2);
        b[0] = 6_000;
        b[1] = 5_000; // sums to 11_000
        vm.expectRevert(abi.encodeWithSelector(Splitter.InvalidBpsSum.selector, 11_000));
        vm.prank(payer);
        splitter.distribute(address(usdc), recipients2, b, 1e6);
    }

    function test_revert_zeroBps() public {
        uint256[] memory b = new uint256[](2);
        b[0] = 10_000;
        b[1] = 0;
        vm.expectRevert(Splitter.ZeroBps.selector);
        vm.prank(payer);
        splitter.distribute(address(usdc), recipients2, b, 1e6);
    }

    function test_revert_zeroRecipient() public {
        address[] memory r = new address[](2);
        r[0] = recipients2[0];
        r[1] = address(0);
        vm.expectRevert(Splitter.ZeroRecipient.selector);
        vm.prank(payer);
        splitter.distribute(address(usdc), r, bps2, 1e6);
    }

    // ---------------------- Reentrancy ----------------------

    function test_reentrancy_blocked() public {
        ReentrantToken bad = new ReentrantToken();
        bad.setSplitter(splitter);
        bad.mint(payer, 1_000e18);

        vm.prank(payer);
        bad.approve(address(splitter), type(uint256).max);

        bad.arm(recipients2, bps2, 100e18);

        // The reentrant call inside transferFrom -> _update should revert with
        // ReentrancyGuard's error, which bubbles up and reverts the outer call.
        vm.expectRevert();
        vm.prank(payer);
        splitter.distribute(address(bad), recipients2, bps2, 100e18);
    }

    // ---------------------- Gas snapshots ----------------------

    function test_gas_twoRecipients() public {
        vm.prank(payer);
        uint256 g = gasleft();
        splitter.distribute(address(usdc), recipients2, bps2, 1_000e6);
        uint256 used = g - gasleft();
        emit log_named_uint("gas_2_recipients", used);
    }

    function test_gas_fiveRecipients() public {
        address[] memory r = _addrs(5);
        uint256[] memory b = _equalBps(5);
        vm.prank(payer);
        uint256 g = gasleft();
        splitter.distribute(address(usdc), r, b, 1_000e6);
        uint256 used = g - gasleft();
        emit log_named_uint("gas_5_recipients", used);
    }

    function test_gas_tenRecipients() public {
        address[] memory r = _addrs(10);
        uint256[] memory b = _equalBps(10);
        vm.prank(payer);
        uint256 g = gasleft();
        splitter.distribute(address(usdc), r, b, 1_000e6);
        uint256 used = g - gasleft();
        emit log_named_uint("gas_10_recipients", used);
    }
}
