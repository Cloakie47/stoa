// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {Splitter} from "./Splitter.sol";
import {TracePin} from "./TracePin.sol";

/// @notice Subset of EIP-3009 supported by Circle USDC.
interface IERC3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title StoaSettler
/// @notice Atomic verify+split+settle entrypoint for Stoa.
///
///         A payer signs an EIP-3009 `transferWithAuthorization` over USDC with
///         this contract as the recipient. A facilitator (or any caller) then
///         submits the auth alongside split parameters; this contract pulls the
///         USDC via the signed authorization, splits it across the configured
///         recipients via {Splitter}, and optionally pins a reasoning-trace hash
///         via {TracePin}. All three steps occur in one transaction.
///
/// @dev    Designed to be called from the x402 facilitator's `stoa-split-evm`
///         scheme handler, but is reusable by any caller (e.g. the InsightAgent
///         bot can call it directly to settle Polymarket builder fees).
contract StoaSettler is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    Splitter public immutable splitter;
    TracePin public immutable tracePin;

    /// @notice An EIP-3009 transferWithAuthorization signed by the payer.
    /// @dev    `to` MUST equal this contract's address — otherwise we'd pull
    ///         funds somewhere we can't subsequently distribute from.
    struct EIP3009Authorization {
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    error InvalidAuthTo();
    error LengthMismatch();
    error ZeroAmount();
    error ZeroRecipients();

    event StoaSettled(
        address indexed payer,
        uint256 amount,
        address[] recipients,
        uint16[] bps,
        bytes32 indexed traceHash,
        string ipfsCid,
        bytes32 authNonce
    );

    constructor(address _usdc, address _splitter, address _tracePin) {
        usdc = IERC20(_usdc);
        splitter = Splitter(_splitter);
        tracePin = TracePin(_tracePin);
    }

    /// @notice One-shot settlement: pull the payer's USDC via signed authorization,
    ///         split it across `recipients` in `bps` proportions, and (optionally)
    ///         pin a reasoning-trace hash.
    /// @param auth        EIP-3009 transferWithAuthorization signed by the payer.
    ///                    `auth.to` must be `address(this)`. `auth.value` must be > 0.
    /// @param recipients  Same arguments forwarded to {Splitter-distribute}.
    /// @param bps         Basis-point weights as uint16 (saves calldata vs uint256).
    ///                    Splitter still enforces that they sum to 10_000.
    /// @param traceHash   If non-zero, calls {TracePin-pinTrace}. If zero, the
    ///                    trace-pin step is skipped entirely.
    /// @param ipfsCid     URI passed through to TracePin when traceHash != 0.
    function settle(
        EIP3009Authorization calldata auth,
        address[] calldata recipients,
        uint16[] calldata bps,
        bytes32 traceHash,
        string calldata ipfsCid
    ) external nonReentrant {
        if (auth.to != address(this)) revert InvalidAuthTo();
        if (auth.value == 0) revert ZeroAmount();
        if (recipients.length == 0) revert ZeroRecipients();
        if (recipients.length != bps.length) revert LengthMismatch();

        // The USDC contract validates the EIP-3009 signature internally.
        // A bad sig reverts here and bubbles up; no need for duplicate checks.
        IERC3009(address(usdc)).transferWithAuthorization(
            auth.from,
            auth.to,
            auth.value,
            auth.validAfter,
            auth.validBefore,
            auth.nonce,
            auth.v,
            auth.r,
            auth.s
        );

        uint256 n = bps.length;
        uint256[] memory bpsU256 = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            bpsU256[i] = bps[i];
        }

        usdc.forceApprove(address(splitter), auth.value);
        splitter.distribute(address(usdc), recipients, bpsU256, auth.value);

        if (traceHash != bytes32(0)) {
            tracePin.pinTrace(traceHash, ipfsCid);
        }

        emit StoaSettled(
            auth.from, auth.value, recipients, bps, traceHash, ipfsCid, auth.nonce
        );
    }
}
