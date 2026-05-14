// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title TracePin
/// @notice Pins reasoning-trace commitments on-chain so InsightAgent's analyses are
///         tamper-evident and publicly verifiable. Stores nothing — the hash and URI
///         are surfaced via the TracePinned event indexed for off-chain lookups.
contract TracePin {
    event TracePinned(
        address indexed pinner,
        bytes32 indexed traceHash,
        string uri,
        uint256 timestamp
    );

    /// @notice Pin a reasoning-trace hash. The hash is a keccak256 of the canonical JSON
    ///         trace; the URI points to the off-chain artifact (IPFS, R2, etc.).
    /// @param traceHash  keccak256 commitment to the off-chain trace document
    /// @param uri        Off-chain location of the trace document
    function pinTrace(bytes32 traceHash, string calldata uri) external {
        emit TracePinned(msg.sender, traceHash, uri, block.timestamp);
    }
}
