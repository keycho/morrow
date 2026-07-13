// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FletchCommits
/// @notice merkle root registry for the fletch off-hours fair value oracle.
///         every cycle the publisher commits the root of all fair value
///         observations. anyone can verify a published price against the
///         committed root with a merkle proof.
/// @dev    leaf scheme (mirrors packages/engine/src/merkle.ts):
///         leaf = keccak256(utf8("tokenId|cycleId|fairValue8dp|confidence|unixSeconds"))
///         interior nodes hash the sorted pair; odd nodes are promoted.
///         informational feed. not for use in liquidations, settlement, or
///         as sole pricing source. no warranty.
contract FletchCommits {
    struct Commit {
        bytes32 merkleRoot;
        uint64 observationCount;
        uint64 committedAt;
    }

    address public owner;
    address public pendingOwner;
    address public publisher;

    mapping(uint64 => Commit) private _commits;
    uint64 public latestCycleId;
    uint64 public commitCount;

    event Committed(uint64 indexed cycleId, bytes32 merkleRoot, uint64 observationCount);
    event PublisherChanged(address indexed previousPublisher, address indexed newPublisher);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotPendingOwner();
    error NotPublisher();
    error ZeroAddress();
    error EmptyRoot();
    error AlreadyCommitted(uint64 cycleId);
    error UnknownCycle(uint64 cycleId);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyPublisher() {
        if (msg.sender != publisher) revert NotPublisher();
        _;
    }

    constructor(address initialPublisher) {
        if (initialPublisher == address(0)) revert ZeroAddress();
        owner = msg.sender;
        publisher = initialPublisher;
        emit PublisherChanged(address(0), initialPublisher);
    }

    // --- ownership, two-step ------------------------------------------------

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previous = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, owner);
    }

    function setPublisher(address newPublisher) external onlyOwner {
        if (newPublisher == address(0)) revert ZeroAddress();
        emit PublisherChanged(publisher, newPublisher);
        publisher = newPublisher;
    }

    // --- commits --------------------------------------------------------------

    function commit(bytes32 merkleRoot, uint64 cycleId, uint64 observationCount)
        external
        onlyPublisher
    {
        if (merkleRoot == bytes32(0)) revert EmptyRoot();
        if (_commits[cycleId].merkleRoot != bytes32(0)) revert AlreadyCommitted(cycleId);
        _commits[cycleId] = Commit({
            merkleRoot: merkleRoot,
            observationCount: observationCount,
            committedAt: uint64(block.timestamp)
        });
        if (cycleId > latestCycleId) latestCycleId = cycleId;
        commitCount += 1;
        emit Committed(cycleId, merkleRoot, observationCount);
    }

    function getCommit(uint64 cycleId)
        external
        view
        returns (bytes32 merkleRoot, uint64 observationCount, uint64 committedAt)
    {
        Commit storage c = _commits[cycleId];
        return (c.merkleRoot, c.observationCount, c.committedAt);
    }

    /// @notice verify a leaf against the committed root for a cycle.
    /// @dev sorted-pair keccak256 fold, identical to the typescript builder.
    function verify(bytes32 leaf, bytes32[] calldata proof, uint64 cycleId)
        external
        view
        returns (bool)
    {
        bytes32 root = _commits[cycleId].merkleRoot;
        if (root == bytes32(0)) revert UnknownCycle(cycleId);
        bytes32 computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 sibling = proof[i];
            computed = computed <= sibling
                ? keccak256(abi.encodePacked(computed, sibling))
                : keccak256(abi.encodePacked(sibling, computed));
        }
        return computed == root;
    }
}
