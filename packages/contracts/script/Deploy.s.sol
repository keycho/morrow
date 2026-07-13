// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MorrowCommits} from "../src/MorrowCommits.sol";

/// deploy MorrowCommits to robinhood chain.
///
/// required env vars (see .env.example at the repo root):
///   DEPLOYER_PRIVATE_KEY   funds the deploy, pays gas in eth
///   PUBLISHER_ADDRESS      the address allowed to call commit()
///   MORROW_RPC_URL         robinhood chain json-rpc endpoint
///
/// run from packages/contracts:
///   forge script script/Deploy.s.sol --rpc-url $MORROW_RPC_URL --broadcast
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address publisher = vm.envAddress("PUBLISHER_ADDRESS");

        vm.startBroadcast(deployerKey);
        MorrowCommits commits = new MorrowCommits(publisher);
        vm.stopBroadcast();

        console.log("MorrowCommits deployed at", address(commits));
        console.log("publisher set to", publisher);
        console.log("next: put this address in MORROW_COMMITS_ADDRESS in .env");
    }
}
