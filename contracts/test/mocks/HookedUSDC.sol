// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MockUSDC} from "./MockUSDC.sol";

/// @notice MockUSDC variant that calls `onTokenTransfer()` on the recipient
///         when it has code. Lets us simulate an ERC-777-style hook
///         on a transfer destination and verify that StoaSettler's
///         ReentrancyGuard rejects a reentry attempt from a malicious
///         recipient mid-distribution.
interface ITokenReceiver {
    function onTokenTransfer() external;
}

contract HookedUSDC is MockUSDC {
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        // Propagate any revert from the recipient's hook so reentrancy
        // protection in upstream callers (StoaSettler) surfaces correctly.
        if (to.code.length > 0) {
            ITokenReceiver(to).onTokenTransfer();
        }
    }
}
