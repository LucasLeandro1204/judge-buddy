// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {HederaResponseCodes} from "@hiero-ledger/hiero-contracts/common/HederaResponseCodes.sol";
import {HederaTokenService} from "@hiero-ledger/hiero-contracts/token-service/HederaTokenService.sol";
import {IHederaTokenService} from "@hiero-ledger/hiero-contracts/token-service/IHederaTokenService.sol";

contract PrizeClaimToken is Ownable, HederaTokenService {
    struct ClaimRecord {
        bool exists;
        bool redeemed;
        address claimant;
        int64 serialNumber;
        string metadataURI;
    }

    address public claimCollection;
    mapping(bytes32 => ClaimRecord) public claims;

    event ClaimCollectionCreated(address indexed tokenAddress, string name, string symbol);
    event ClaimMinted(bytes32 indexed claimId, address indexed claimant, int64 serialNumber, string metadataURI);
    event ClaimBurned(bytes32 indexed claimId, address indexed claimant, int64 serialNumber);

    error HederaTokenError(int256 responseCode);
    error ClaimAlreadyExists(bytes32 claimId);
    error ClaimCollectionMissing();
    error ClaimMissing(bytes32 claimId);
    error ClaimRedeemed(bytes32 claimId);

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Creates the HTS non-fungible collection that backs prize claims.
    /// @dev Must be payable. HederaTokenService.createNonFungibleToken forwards msg.value to the
    ///      HTS system contract and token creation carries a real HBAR fee, so a non-payable
    ///      version always failed with INSUFFICIENT_TX_FEE. Call this with value from the deploy
    ///      script, before ownership moves to the treasury.
    function initializeClaimCollection(string memory name, string memory symbol) external payable onlyOwner returns (address tokenAddress) {
        if (claimCollection != address(0)) {
            return claimCollection;
        }

        IHederaTokenService.TokenKey[] memory keys = new IHederaTokenService.TokenKey[](4);
        keys[0] = _contractKey(1);
        keys[1] = _contractKey(2);
        keys[2] = _contractKey(4);
        keys[3] = _contractKey(16);

        IHederaTokenService.HederaToken memory token;
        token.name = name;
        token.symbol = symbol;
        token.treasury = address(this);
        token.memo = "JudgeBuddy prize claims";
        token.tokenSupplyType = true;
        token.maxSupply = 500000;
        token.freezeDefault = false;
        token.tokenKeys = keys;
        // autoRenewAccount must be a real account; address(0) is rejected by the HTS system
        // contract. This contract is the token treasury, so it renews itself.
        token.expiry = IHederaTokenService.Expiry({
            second: 0,
            autoRenewAccount: address(this),
            autoRenewPeriod: 7_776_000
        });

        (int responseCode, address created) = createNonFungibleToken(token);
        _requireSuccess(responseCode);
        claimCollection = created;
        emit ClaimCollectionCreated(created, name, symbol);
        return created;
    }

    function mintClaim(bytes32 claimId, address claimant, string calldata metadataURI) external onlyOwner returns (int64 serialNumber) {
        if (claimCollection == address(0)) revert ClaimCollectionMissing();
        if (claims[claimId].exists) revert ClaimAlreadyExists(claimId);

        bytes[] memory metadata = new bytes[](1);
        metadata[0] = bytes(metadataURI);
        (int responseCode, , int64[] memory serials) = mintToken(claimCollection, 0, metadata);
        _requireSuccess(responseCode);

        serialNumber = serials[0];
        claims[claimId] = ClaimRecord({
            exists: true,
            redeemed: false,
            claimant: claimant,
            serialNumber: serialNumber,
            metadataURI: metadataURI
        });

        emit ClaimMinted(claimId, claimant, serialNumber, metadataURI);
    }

    function consumeClaim(bytes32 claimId) external onlyOwner returns (address claimant, int64 serialNumber, string memory metadataURI) {
        ClaimRecord storage claim = claims[claimId];
        if (!claim.exists) revert ClaimMissing(claimId);
        if (claim.redeemed) revert ClaimRedeemed(claimId);

        claim.redeemed = true;
        claimant = claim.claimant;
        serialNumber = claim.serialNumber;
        metadataURI = claim.metadataURI;

        int64[] memory serials = new int64[](1);
        serials[0] = serialNumber;
        (int responseCode, ) = burnToken(claimCollection, 0, serials);
        _requireSuccess(responseCode);

        emit ClaimBurned(claimId, claimant, serialNumber);
    }

    function grantClaimantKyc(bytes32 claimId) external onlyOwner returns (int64 responseCode) {
        ClaimRecord storage claim = claims[claimId];
        if (!claim.exists) revert ClaimMissing(claimId);
        responseCode = grantTokenKyc(claimCollection, claim.claimant);
        _requireSuccess(responseCode);
    }

    function freezeClaimant(bytes32 claimId) external onlyOwner returns (int64 responseCode) {
        ClaimRecord storage claim = claims[claimId];
        if (!claim.exists) revert ClaimMissing(claimId);
        responseCode = freezeToken(claimCollection, claim.claimant);
        _requireSuccess(responseCode);
    }

    function unfreezeClaimant(bytes32 claimId) external onlyOwner returns (int64 responseCode) {
        ClaimRecord storage claim = claims[claimId];
        if (!claim.exists) revert ClaimMissing(claimId);
        responseCode = unfreezeToken(claimCollection, claim.claimant);
        _requireSuccess(responseCode);
    }

    function _contractKey(uint256 keyType) private view returns (IHederaTokenService.TokenKey memory) {
        return IHederaTokenService.TokenKey({
            keyType: keyType,
            key: IHederaTokenService.KeyValue({
                inheritAccountKey: false,
                contractId: address(this),
                ed25519: "",
                ECDSA_secp256k1: "",
                delegatableContractId: address(0)
            })
        });
    }

    function _requireSuccess(int256 responseCode) private pure {
        if (responseCode != HederaResponseCodes.SUCCESS) {
            revert HederaTokenError(responseCode);
        }
    }
}
