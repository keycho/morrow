// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FletchCommits} from "../src/FletchCommits.sol";

contract FletchCommitsTest is Test {
    FletchCommits internal commits;
    address internal owner = address(this);
    address internal publisher = address(0xBEEF);
    address internal stranger = address(0xCAFE);

    function setUp() public {
        commits = new FletchCommits(publisher);
    }

    // --- helpers mirroring the typescript merkle builder --------------------

    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b
            ? keccak256(abi.encodePacked(a, b))
            : keccak256(abi.encodePacked(b, a));
    }

    function leaf(string memory canonical) internal pure returns (bytes32) {
        return keccak256(bytes(canonical));
    }

    // --- commit access control ----------------------------------------------

    function test_publisherCanCommit() public {
        vm.prank(publisher);
        commits.commit(bytes32(uint256(1)), 100, 5);
        (bytes32 root, uint64 count, uint64 at) = commits.getCommit(100);
        assertEq(root, bytes32(uint256(1)));
        assertEq(count, 5);
        assertGt(at, 0);
        assertEq(commits.latestCycleId(), 100);
        assertEq(commits.commitCount(), 1);
    }

    function test_strangerCannotCommit() public {
        vm.prank(stranger);
        vm.expectRevert(FletchCommits.NotPublisher.selector);
        commits.commit(bytes32(uint256(1)), 100, 5);
    }

    function test_ownerCannotCommitUnlessPublisher() public {
        vm.expectRevert(FletchCommits.NotPublisher.selector);
        commits.commit(bytes32(uint256(1)), 100, 5);
    }

    function test_cannotDoubleCommitCycle() public {
        vm.startPrank(publisher);
        commits.commit(bytes32(uint256(1)), 100, 5);
        vm.expectRevert(abi.encodeWithSelector(FletchCommits.AlreadyCommitted.selector, uint64(100)));
        commits.commit(bytes32(uint256(2)), 100, 5);
        vm.stopPrank();
    }

    function test_cannotCommitEmptyRoot() public {
        vm.prank(publisher);
        vm.expectRevert(FletchCommits.EmptyRoot.selector);
        commits.commit(bytes32(0), 100, 5);
    }

    function test_latestCycleIdTracksMax() public {
        vm.startPrank(publisher);
        commits.commit(bytes32(uint256(1)), 200, 5);
        commits.commit(bytes32(uint256(2)), 150, 5); // late backfill
        vm.stopPrank();
        assertEq(commits.latestCycleId(), 200);
        assertEq(commits.commitCount(), 2);
    }

    // --- ownership ------------------------------------------------------------

    function test_twoStepOwnershipTransfer() public {
        address newOwner = address(0xD00D);
        commits.transferOwnership(newOwner);
        // still the old owner until accepted
        assertEq(commits.owner(), owner);
        vm.prank(newOwner);
        commits.acceptOwnership();
        assertEq(commits.owner(), newOwner);
        assertEq(commits.pendingOwner(), address(0));
    }

    function test_onlyPendingOwnerCanAccept() public {
        commits.transferOwnership(address(0xD00D));
        vm.prank(stranger);
        vm.expectRevert(FletchCommits.NotPendingOwner.selector);
        commits.acceptOwnership();
    }

    function test_onlyOwnerCanStartTransfer() public {
        vm.prank(stranger);
        vm.expectRevert(FletchCommits.NotOwner.selector);
        commits.transferOwnership(stranger);
    }

    function test_ownerRotatesPublisher() public {
        commits.setPublisher(stranger);
        assertEq(commits.publisher(), stranger);
        vm.prank(stranger);
        commits.commit(bytes32(uint256(1)), 100, 1);
        vm.prank(publisher);
        vm.expectRevert(FletchCommits.NotPublisher.selector);
        commits.commit(bytes32(uint256(2)), 101, 1);
    }

    function test_zeroAddressGuards() public {
        vm.expectRevert(FletchCommits.ZeroAddress.selector);
        commits.setPublisher(address(0));
        vm.expectRevert(FletchCommits.ZeroAddress.selector);
        commits.transferOwnership(address(0));
        vm.expectRevert(FletchCommits.ZeroAddress.selector);
        new FletchCommits(address(0));
    }

    // --- merkle verification ----------------------------------------------------

    function test_verifyThreeLeafTree() public {
        // canonical fletch leaves: tokenId|cycleId|fairValue8dp|confidence|ts
        bytes32 a = leaf("1|2950000|249.12345678|87|1770000000");
        bytes32 b = leaf("2|2950000|210.00000000|90|1770000000");
        bytes32 c = leaf("3|2950000|130.55500000|72|1770000000");

        // level 1: pair(a,b), c promoted. root = pair(that, c).
        bytes32 ab = hashPair(a, b);
        bytes32 root = hashPair(ab, c);

        vm.prank(publisher);
        commits.commit(root, 2950000, 3);

        // proof for a: sibling b, then sibling c
        bytes32[] memory proofA = new bytes32[](2);
        proofA[0] = b;
        proofA[1] = c;
        assertTrue(commits.verify(a, proofA, 2950000));

        // proof for c: promoted at level 1, sibling ab at level 2
        bytes32[] memory proofC = new bytes32[](1);
        proofC[0] = ab;
        assertTrue(commits.verify(c, proofC, 2950000));

        // tampered leaf fails
        bytes32 tampered = leaf("1|2950000|999.99999999|87|1770000000");
        assertFalse(commits.verify(tampered, proofA, 2950000));
    }

    function test_verifyUnknownCycleReverts() public {
        bytes32[] memory proof = new bytes32[](0);
        vm.expectRevert(abi.encodeWithSelector(FletchCommits.UnknownCycle.selector, uint64(42)));
        commits.verify(bytes32(uint256(1)), proof, 42);
    }

    function test_singleLeafTree() public {
        bytes32 a = leaf("1|100|100.00000000|50|1770000000");
        vm.prank(publisher);
        commits.commit(a, 100, 1);
        bytes32[] memory emptyProof = new bytes32[](0);
        assertTrue(commits.verify(a, emptyProof, 100));
    }
}
