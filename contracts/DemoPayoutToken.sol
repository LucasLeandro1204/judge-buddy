// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title DemoPayoutToken
/// @notice Six-decimal payout token for the JudgeBuddy testnet deployment.
/// @dev Deliberately a plain ERC-20 rather than an HTS token. On Hedera, receiving an HTS token
///      requires the recipient — including a contract — to be associated with it first, and
///      HackathonTreasury has no association call. A native EVM ERC-20 needs no association, so
///      the full award-to-settlement loop can be demonstrated end to end on testnet without a
///      manual association step for every sponsor, judge and winner.
///
///      Production programs are expected to fund treasuries with a real HTS stablecoin; that path
///      additionally requires HackathonTreasury.associatePayoutToken to be called before funding.
contract DemoPayoutToken is ERC20, Ownable {
    uint8 private constant DECIMALS = 6;

    /// @notice Anyone may mint up to this much per call, so demo participants can self-serve.
    uint256 public constant FAUCET_LIMIT = 100_000 * 10 ** 6;

    event FaucetMint(address indexed recipient, uint256 amount);

    error FaucetLimitExceeded(uint256 requested, uint256 limit);

    constructor(address initialOwner) ERC20("JudgeBuddy Demo USD", "jbUSD") Ownable(initialOwner) {}

    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }

    /// @notice Mints to an arbitrary recipient. Owner only, for seeding sponsor accounts.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Self-serve faucet so a reviewer can fund a treasury without asking us for tokens.
    function faucet(uint256 amount) external {
        if (amount > FAUCET_LIMIT) revert FaucetLimitExceeded(amount, FAUCET_LIMIT);
        _mint(msg.sender, amount);
        emit FaucetMint(msg.sender, amount);
    }
}
