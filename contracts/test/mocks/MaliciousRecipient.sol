// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StoaSettler} from "../../src/StoaSettler.sol";

/// @notice ERC-777-style hook receiver wired to reenter StoaSettler on receipt.
///         Only triggers when paired with a token that calls `onTokenTransfer`
///         on transfer destinations (see HookedUSDC). Used to verify that
///         StoaSettler's ReentrancyGuard rejects the nested call.
contract MaliciousRecipient {
    StoaSettler public settler;
    StoaSettler.EIP3009Authorization public storedAuth;
    address[] public storedRecipients;
    uint16[] public storedBps;
    bool public attempted;

    function arm(
        StoaSettler _settler,
        StoaSettler.EIP3009Authorization calldata _auth,
        address[] calldata _recipients,
        uint16[] calldata _bps
    ) external {
        settler = _settler;
        storedAuth = _auth;
        delete storedRecipients;
        delete storedBps;
        for (uint256 i; i < _recipients.length; ++i) {
            storedRecipients.push(_recipients[i]);
            storedBps.push(_bps[i]);
        }
    }

    /// @notice Triggered by HookedUSDC._update when this contract is the
    ///         transfer destination. Attempts a reentry into StoaSettler.settle —
    ///         must revert due to ReentrancyGuard.
    function onTokenTransfer() external {
        if (address(settler) == address(0)) return; // not armed
        attempted = true;
        settler.settle(storedAuth, storedRecipients, storedBps, bytes32(0), "");
    }
}
