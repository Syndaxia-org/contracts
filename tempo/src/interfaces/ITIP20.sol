// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Satflows SAS
pragma solidity ^0.8.24;

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

interface ITIP20 is IERC20 {
    // 32-byte memo for payment reconciliation — native to Tempo TIP-20 stablecoins.
    // Falls back to IERC20.transfer() for plain bridged ERC-20 tokens.
    function transferWithMemo(address to, uint256 value, bytes32 memo) external returns (bool);
}
