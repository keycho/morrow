// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {FletchCommits} from "../src/FletchCommits.sol";

/// deploy FletchCommits to robinhood chain.
///
/// required env vars (see .env.example at the repo root):
///   DEPLOYER_PRIVATE_KEY   funds the deploy, pays gas in eth
///   PUBLISHER_ADDRESS      the address allowed to call commit()
///   FLETCH_RPC_URL         robinhood chain json-rpc endpoint
///
/// run from packages/contracts:
///   forge script script/Deploy.s.sol --rpc-url $FLETCH_RPC_URL --broadcast
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address publisher = vm.envAddress("PUBLISHER_ADDRESS");

        vm.startBroadcast(deployerKey);
        FletchCommits commits = new FletchCommits(publisher);
        vm.stopBroadcast();

        console.log("FletchCommits deployed at", address(commits));
        console.log("publisher set to", publisher);
        console.log("next: put this address in FLETCH_COMMITS_ADDRESS in .env");
    }
}
