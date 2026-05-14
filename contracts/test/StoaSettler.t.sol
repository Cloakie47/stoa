// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StoaSettler} from "../src/StoaSettler.sol";
import {Splitter} from "../src/Splitter.sol";
import {TracePin} from "../src/TracePin.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {HookedUSDC} from "./mocks/HookedUSDC.sol";
import {MaliciousRecipient} from "./mocks/MaliciousRecipient.sol";

contract StoaSettlerTest is Test {
    StoaSettler internal settler;
    Splitter internal splitter;
    TracePin internal tracePin;
    MockUSDC internal usdc;

    uint256 internal payerPk = 0xA11CE;
    address internal payer;

    address internal operator = makeAddr("operator");
    address internal user = makeAddr("user");
    address internal polyseer = makeAddr("polyseer");
    address internal canteen = makeAddr("canteen");

    address[] internal recipients;
    uint16[] internal bps;

    function setUp() public {
        payer = vm.addr(payerPk);

        usdc = new MockUSDC();
        splitter = new Splitter();
        tracePin = new TracePin();
        settler = new StoaSettler(address(usdc), address(splitter), address(tracePin));

        usdc.mint(payer, 1_000_000e6);

        recipients.push(operator);
        recipients.push(user);
        recipients.push(polyseer);
        recipients.push(canteen);
        bps.push(6_000);
        bps.push(2_000);
        bps.push(1_500);
        bps.push(500);
    }

    // ---------------------- helpers ----------------------

    function _authDigest(
        MockUSDC token,
        StoaSettler.EIP3009Authorization memory a
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
                a.from,
                a.to,
                a.value,
                a.validAfter,
                a.validBefore,
                a.nonce
            )
        );
        return
            keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
    }

    function _signAuth(
        MockUSDC token,
        uint256 pk,
        StoaSettler.EIP3009Authorization memory a
    ) internal view returns (StoaSettler.EIP3009Authorization memory) {
        bytes32 digest = _authDigest(token, a);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        a.v = v;
        a.r = r;
        a.s = s;
        return a;
    }

    function _makeAuth(uint256 value, bytes32 nonce)
        internal
        view
        returns (StoaSettler.EIP3009Authorization memory)
    {
        return
            _signAuth(
                usdc,
                payerPk,
                StoaSettler.EIP3009Authorization({
                    from: payer,
                    to: address(settler),
                    value: value,
                    validAfter: 0,
                    validBefore: block.timestamp + 1 hours,
                    nonce: nonce,
                    v: 0,
                    r: bytes32(0),
                    s: bytes32(0)
                })
            );
    }

    // ---------------------- happy paths ----------------------

    function test_settle_fourWaySplit_withTracePin() public {
        uint256 amount = 100e6; // 100 USDC
        bytes32 traceHash = keccak256("reasoning-payload");
        string memory uri = "ipfs://bafy.../trace.json";

        StoaSettler.EIP3009Authorization memory auth =
            _makeAuth(amount, keccak256("nonce-1"));

        vm.expectEmit(true, true, false, true, address(tracePin));
        emit TracePin.TracePinned(address(settler), traceHash, uri, block.timestamp);

        vm.expectEmit(true, true, false, true, address(settler));
        emit StoaSettler.StoaSettled(
            payer, amount, recipients, bps, traceHash, uri, keccak256("nonce-1")
        );

        settler.settle(auth, recipients, bps, traceHash, uri);

        assertEq(usdc.balanceOf(operator), 60e6, "operator 60%");
        assertEq(usdc.balanceOf(user), 20e6, "user 20%");
        assertEq(usdc.balanceOf(polyseer), 15e6, "polyseer 15%");
        assertEq(usdc.balanceOf(canteen), 5e6, "canteen 5%");
        assertEq(usdc.balanceOf(address(settler)), 0, "settler holds no dust");
        assertEq(usdc.balanceOf(address(splitter)), 0, "splitter holds no dust");
        assertEq(usdc.balanceOf(payer), 1_000_000e6 - amount, "payer debited exactly");
    }

    function test_settle_traceHashOmitted_skipsPin() public {
        uint256 amount = 50e6;
        StoaSettler.EIP3009Authorization memory auth =
            _makeAuth(amount, keccak256("nonce-2"));

        // Record logs to assert TracePinned was NOT emitted.
        vm.recordLogs();
        settler.settle(auth, recipients, bps, bytes32(0), "");
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 pinTopic = keccak256("TracePinned(address,bytes32,string,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(
                logs[i].topics[0] != pinTopic,
                "TracePinned must not be emitted when traceHash is zero"
            );
        }

        assertEq(usdc.balanceOf(operator), 30e6);
    }

    // ---------------------- validation reverts ----------------------

    function test_revert_invalidAuthTo() public {
        StoaSettler.EIP3009Authorization memory auth = _signAuth(
            usdc,
            payerPk,
            StoaSettler.EIP3009Authorization({
                from: payer,
                to: makeAddr("not-the-settler"),
                value: 10e6,
                validAfter: 0,
                validBefore: block.timestamp + 1 hours,
                nonce: keccak256("bad-to"),
                v: 0,
                r: bytes32(0),
                s: bytes32(0)
            })
        );

        vm.expectRevert(StoaSettler.InvalidAuthTo.selector);
        settler.settle(auth, recipients, bps, bytes32(0), "");
    }

    function test_revert_zeroAmount() public {
        StoaSettler.EIP3009Authorization memory auth =
            _makeAuth(0, keccak256("zero-amt"));
        vm.expectRevert(StoaSettler.ZeroAmount.selector);
        settler.settle(auth, recipients, bps, bytes32(0), "");
    }

    function test_revert_emptyRecipients() public {
        StoaSettler.EIP3009Authorization memory auth =
            _makeAuth(10e6, keccak256("empty-r"));
        address[] memory r = new address[](0);
        uint16[] memory b = new uint16[](0);
        vm.expectRevert(StoaSettler.ZeroRecipients.selector);
        settler.settle(auth, r, b, bytes32(0), "");
    }

    function test_revert_lengthMismatch() public {
        StoaSettler.EIP3009Authorization memory auth =
            _makeAuth(10e6, keccak256("mismatch"));
        uint16[] memory shortBps = new uint16[](2);
        shortBps[0] = 6_000;
        shortBps[1] = 4_000;
        vm.expectRevert(StoaSettler.LengthMismatch.selector);
        settler.settle(auth, recipients, shortBps, bytes32(0), "");
    }

    function test_revert_invalidAuthSignature() public {
        // Build an auth, then corrupt the signature.
        StoaSettler.EIP3009Authorization memory auth =
            _makeAuth(10e6, keccak256("bad-sig"));
        auth.s = bytes32(uint256(auth.s) ^ 1);

        vm.expectRevert(MockUSDC.InvalidSigner.selector);
        settler.settle(auth, recipients, bps, bytes32(0), "");
    }

    function test_revert_bpsSumInvalid_bubblesFromSplitter() public {
        StoaSettler.EIP3009Authorization memory auth =
            _makeAuth(10e6, keccak256("bad-bps"));
        uint16[] memory wrongBps = new uint16[](4);
        wrongBps[0] = 5_000;
        wrongBps[1] = 2_000;
        wrongBps[2] = 1_500;
        wrongBps[3] = 500; // sums to 9_000
        vm.expectRevert(abi.encodeWithSelector(Splitter.InvalidBpsSum.selector, 9_000));
        settler.settle(auth, recipients, wrongBps, bytes32(0), "");
    }

    // ---------------------- reentrancy ----------------------

    function test_reentrancy_blockedViaMaliciousRecipient() public {
        // Spin up a token with on-transfer hooks and a separate settler stack
        // that uses it. The malicious recipient sits in the split list and
        // tries to reenter when it receives its share.
        HookedUSDC hooked = new HookedUSDC();
        Splitter sp = new Splitter();
        TracePin tp = new TracePin();
        StoaSettler ss = new StoaSettler(address(hooked), address(sp), address(tp));

        address payer2 = vm.addr(payerPk);
        hooked.mint(payer2, 1_000e6);

        MaliciousRecipient bad = new MaliciousRecipient();

        address[] memory r = new address[](2);
        r[0] = address(bad);
        r[1] = makeAddr("benign");
        uint16[] memory b = new uint16[](2);
        b[0] = 4_000;
        b[1] = 6_000;

        // Build an auth against the hooked token's domain.
        StoaSettler.EIP3009Authorization memory auth =
            StoaSettler.EIP3009Authorization({
                from: payer2,
                to: address(ss),
                value: 10e6,
                validAfter: 0,
                validBefore: block.timestamp + 1 hours,
                nonce: keccak256("reenter-nonce"),
                v: 0,
                r: bytes32(0),
                s: bytes32(0)
            });
        bytes32 structHash = keccak256(
            abi.encode(
                hooked.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
                auth.from,
                auth.to,
                auth.value,
                auth.validAfter,
                auth.validBefore,
                auth.nonce
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", hooked.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 rs, bytes32 sigS) = vm.sign(payerPk, digest);
        auth.v = v;
        auth.r = rs;
        auth.s = sigS;

        bad.arm(ss, auth, r, b);

        vm.expectRevert(); // ReentrancyGuard-driven bubble-up
        ss.settle(auth, r, b, bytes32(0), "");
    }
}

// Pull Vm in for Log decoding above.
import {Vm} from "forge-std/Vm.sol";
