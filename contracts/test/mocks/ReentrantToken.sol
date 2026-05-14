// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Splitter} from "../../src/Splitter.sol";

/// @notice Malicious ERC-20 that reenters Splitter.distribute on transfer.
///         Used only by tests to confirm ReentrancyGuard kicks in.
contract ReentrantToken is ERC20 {
    Splitter public splitter;
    bool public reentered;
    address[] private _recipients;
    uint256[] private _bps;
    uint256 private _amt;

    constructor() ERC20("Reentrant", "REE") {}

    function setSplitter(Splitter s) external {
        splitter = s;
    }

    function arm(address[] calldata recipients, uint256[] calldata bps, uint256 amount) external {
        delete _recipients;
        delete _bps;
        for (uint256 i; i < recipients.length; ++i) {
            _recipients.push(recipients[i]);
            _bps.push(bps[i]);
        }
        _amt = amount;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (
            !reentered
                && address(splitter) != address(0)
                && (to == address(splitter) || from == address(splitter))
        ) {
            reentered = true;
            splitter.distribute(address(this), _recipients, _bps, _amt);
        }
    }
}
