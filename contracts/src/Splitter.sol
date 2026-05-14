// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Splitter
/// @notice Atomic basis-point splitter used by Stoa to distribute settlement amounts
///         across recipients in a single transaction. Push-pattern: pulls `amount` of
///         `token` from the caller, then transfers each recipient's BPS-weighted share.
/// @dev    Sum of basisPoints MUST equal 10_000. The last recipient absorbs any rounding
///         dust so the contract never retains a residual balance from a successful split.
contract Splitter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;

    error InvalidBpsSum(uint256 actual);
    error LengthMismatch();
    error ZeroRecipients();
    error ZeroAmount();
    error ZeroRecipient();
    error ZeroBps();

    event Distributed(
        address indexed token,
        address indexed payer,
        uint256 totalAmount,
        address[] recipients,
        uint256[] basisPoints
    );

    /// @notice Pull `amount` of `token` from `msg.sender` and split across `recipients`
    ///         in proportion to `basisPoints`. The last recipient receives any rounding
    ///         dust to keep the contract balance flat post-distribution.
    /// @param token        ERC-20 to distribute (USDC on Arc Testnet for Stoa's use case)
    /// @param recipients   Non-empty list of recipient addresses; none may be zero
    /// @param basisPoints  Same-length list of weights; each > 0, summing to exactly 10_000
    /// @param amount       Total token amount to pull from caller and distribute (> 0)
    function distribute(
        address token,
        address[] calldata recipients,
        uint256[] calldata basisPoints,
        uint256 amount
    ) external nonReentrant {
        uint256 n = recipients.length;
        if (n == 0) revert ZeroRecipients();
        if (n != basisPoints.length) revert LengthMismatch();
        if (amount == 0) revert ZeroAmount();

        uint256 bpsSum;
        for (uint256 i; i < n; ++i) {
            uint256 bps = basisPoints[i];
            if (bps == 0) revert ZeroBps();
            bpsSum += bps;
        }
        if (bpsSum != BPS_DENOMINATOR) revert InvalidBpsSum(bpsSum);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        uint256 distributed;
        uint256 lastIndex = n - 1;
        for (uint256 i; i < n; ++i) {
            address to = recipients[i];
            if (to == address(0)) revert ZeroRecipient();

            uint256 share;
            if (i == lastIndex) {
                share = amount - distributed;
            } else {
                share = (amount * basisPoints[i]) / BPS_DENOMINATOR;
                distributed += share;
            }
            IERC20(token).safeTransfer(to, share);
        }

        emit Distributed(token, msg.sender, amount, recipients, basisPoints);
    }
}
