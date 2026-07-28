// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {HederaResponseCodes} from "@hiero-ledger/hiero-contracts/common/HederaResponseCodes.sol";
import {HederaTokenService} from "@hiero-ledger/hiero-contracts/token-service/HederaTokenService.sol";
import {PrizeClaimToken} from "./PrizeClaimToken.sol";

contract HackathonTreasury is Ownable, ReentrancyGuard, EIP712, HederaTokenService {
    using SafeERC20 for IERC20;

    bytes32 public constant AWARD_APPROVAL_TYPEHASH =
        keccak256(
            "AwardApproval(bytes32 awardId,bytes32 hackathonId,bytes32 submissionId,bytes32 trackId,address winner,uint256 amount,uint8 settlementMode,uint256 expiresAt)"
        );

    enum SettlementMode {
        AutonomousPayout,
        ClaimToken
    }

    enum AwardStatus {
        None,
        Proposed,
        Approved,
        ClaimMinted,
        Redeemed,
        PaidOut,
        Refunded
    }

    struct Hackathon {
        address organizer;
        address judge;
        address payoutToken;
        uint256 autonomousThreshold;
        uint256 totalBudget;
        uint256 totalReserved;
        bool exists;
    }

    struct TrackBudget {
        uint256 budget;
        uint256 reserved;
        uint256 paid;
    }

    struct Submission {
        bytes32 hackathonId;
        bytes32 trackId;
        address payoutRecipient;
        bytes32 repoHash;
        bool exists;
    }

    struct Award {
        bytes32 hackathonId;
        bytes32 submissionId;
        bytes32 trackId;
        address winner;
        uint256 amount;
        SettlementMode settlementMode;
        AwardStatus status;
        bytes32 evidenceHash;
    }

    struct TrackFundingInput {
        bytes32 trackId;
        uint256 budget;
    }

    struct AwardApproval {
        bytes32 awardId;
        bytes32 hackathonId;
        bytes32 submissionId;
        bytes32 trackId;
        address winner;
        uint256 amount;
        uint8 settlementMode;
        uint256 expiresAt;
    }

    address public immutable agentRelayer;
    PrizeClaimToken public immutable prizeClaimToken;

    mapping(bytes32 => Hackathon) public hackathons;
    mapping(bytes32 => mapping(bytes32 => TrackBudget)) public trackBudgets;
    mapping(bytes32 => Submission) public submissions;
    mapping(bytes32 => Award) public awards;

    event HackathonCreated(bytes32 indexed hackathonId, address indexed organizer, address indexed judge, address payoutToken, uint256 autonomousThreshold);
    event TreasuryFunded(bytes32 indexed hackathonId, bytes32 indexed trackId, address indexed sponsor, address payoutToken, uint256 amount, uint256 newBudget);
    event SubmissionRegistered(bytes32 indexed hackathonId, bytes32 indexed trackId, bytes32 indexed submissionId, address payoutRecipient, bytes32 repoHash);
    event EvaluationFinalized(bytes32 indexed submissionId, bool eligible, uint16 qualityScore, bytes32 evidenceHash);
    event AwardProposed(bytes32 indexed awardId, bytes32 indexed submissionId, address indexed winner, uint256 amount, uint8 settlementMode, bytes32 evidenceHash);
    event AwardApproved(bytes32 indexed awardId, address indexed signer, uint8 settlementMode);
    event ClaimMinted(bytes32 indexed awardId, address indexed claimant, address indexed claimToken, int64 serialNumber, string metadataURI);
    event ClaimRedeemed(bytes32 indexed awardId, address indexed claimant, int64 serialNumber);
    event PayoutReleased(bytes32 indexed awardId, address indexed recipient, address indexed payoutToken, uint256 amount);
    event Refunded(bytes32 indexed hackathonId, bytes32 indexed trackId, address indexed recipient, uint256 amount);

    error Unauthorized();
    error HackathonExists(bytes32 hackathonId);
    error HackathonMissing(bytes32 hackathonId);
    error SubmissionMissing(bytes32 submissionId);
    error AwardMissing(bytes32 awardId);
    error InvalidAwardStatus(bytes32 awardId, AwardStatus expected, AwardStatus actual);
    error BudgetExceeded(bytes32 hackathonId, bytes32 trackId, uint256 requested, uint256 available);
    error InvalidSignature();
    error ApprovalExpired(uint256 expiresAt);
    error InvalidApprovalPayload();
    error InvalidSettlementMode(uint8 settlementMode);
    error HederaAssociationFailed(int256 responseCode);

    constructor(address initialOwner, address agentRelayer_, PrizeClaimToken prizeClaimToken_)
        Ownable(initialOwner)
        EIP712("JudgeBuddyTreasury", "1")
    {
        agentRelayer = agentRelayer_;
        prizeClaimToken = prizeClaimToken_;
    }

    modifier onlyAgent() {
        if (msg.sender != agentRelayer && msg.sender != owner()) revert Unauthorized();
        _;
    }

    /// @notice Associates this treasury with an HTS payout token so it can be funded with one.
    /// @dev On Hedera an account — contracts included — must be associated with an HTS token
    ///      before it can receive any. Without this, bootstrapHackathon's safeTransferFrom into
    ///      the treasury reverts with TOKEN_NOT_ASSOCIATED_TO_ACCOUNT. Call once per payout token,
    ///      with value to cover the association fee, before the first bootstrap using that token.
    ///      Plain EVM ERC-20 payout tokens need no association and can skip this entirely.
    function associatePayoutToken(address token) external payable onlyOwner returns (int256 responseCode) {
        responseCode = associateToken(address(this), token);
        if (responseCode != HederaResponseCodes.SUCCESS) revert HederaAssociationFailed(responseCode);
    }

    /// @notice Creates the HTS collection the prize-claim NFTs are minted from.
    /// @dev A recovery path, and the reason this exists is worth recording. PrizeClaimToken's own
    ///      initializeClaimCollection is onlyOwner, and deployment transfers that ownership to this
    ///      treasury so nothing else can mint claims. Before this function existed, a deployment
    ///      that skipped collection creation — or whose creation reverted for want of an attached
    ///      fee — could never create it afterwards: the only account permitted to call it was a
    ///      contract with no way to ask, and prizeClaimToken is immutable so it could not be
    ///      repointed either. That stranded the entire claim-token settlement branch permanently
    ///      and cost a redeploy to undo.
    ///
    ///      Creating an HTS token costs roughly 20 HBAR, forwarded from msg.value.
    function initializeClaimCollection(string calldata name, string calldata symbol)
        external
        payable
        onlyOwner
        returns (address tokenAddress)
    {
        tokenAddress = prizeClaimToken.initializeClaimCollection{value: msg.value}(name, symbol);
    }

    function bootstrapHackathon(
        bytes32 hackathonId,
        address judge,
        address payoutToken,
        uint256 autonomousThreshold,
        TrackFundingInput[] calldata tracks
    ) external nonReentrant {
        if (hackathons[hackathonId].exists) revert HackathonExists(hackathonId);
        if (judge == address(0) || payoutToken == address(0) || tracks.length == 0) revert InvalidApprovalPayload();

        Hackathon storage hackathon = hackathons[hackathonId];
        hackathon.organizer = msg.sender;
        hackathon.judge = judge;
        hackathon.payoutToken = payoutToken;
        hackathon.autonomousThreshold = autonomousThreshold;
        hackathon.exists = true;

        uint256 totalFunding;
        for (uint256 i = 0; i < tracks.length; i++) {
            TrackFundingInput calldata track = tracks[i];
            trackBudgets[hackathonId][track.trackId].budget += track.budget;
            totalFunding += track.budget;
            emit TreasuryFunded(hackathonId, track.trackId, msg.sender, payoutToken, track.budget, trackBudgets[hackathonId][track.trackId].budget);
        }

        hackathon.totalBudget = totalFunding;
        IERC20(payoutToken).safeTransferFrom(msg.sender, address(this), totalFunding);
        emit HackathonCreated(hackathonId, msg.sender, judge, payoutToken, autonomousThreshold);
    }

    function fundTrack(bytes32 hackathonId, bytes32 trackId, uint256 amount) external nonReentrant {
        Hackathon storage hackathon = hackathons[hackathonId];
        if (!hackathon.exists) revert HackathonMissing(hackathonId);
        trackBudgets[hackathonId][trackId].budget += amount;
        hackathon.totalBudget += amount;
        IERC20(hackathon.payoutToken).safeTransferFrom(msg.sender, address(this), amount);
        emit TreasuryFunded(hackathonId, trackId, msg.sender, hackathon.payoutToken, amount, trackBudgets[hackathonId][trackId].budget);
    }

    function registerSubmission(
        bytes32 submissionId,
        bytes32 hackathonId,
        bytes32 trackId,
        address payoutRecipient,
        bytes32 repoHash
    ) external onlyAgent {
        if (!hackathons[hackathonId].exists) revert HackathonMissing(hackathonId);
        submissions[submissionId] = Submission({
            hackathonId: hackathonId,
            trackId: trackId,
            payoutRecipient: payoutRecipient,
            repoHash: repoHash,
            exists: true
        });
        emit SubmissionRegistered(hackathonId, trackId, submissionId, payoutRecipient, repoHash);
    }

    function recordEvaluation(bytes32 submissionId, bool eligible, uint16 qualityScore, bytes32 evidenceHash) external onlyAgent {
        if (!submissions[submissionId].exists) revert SubmissionMissing(submissionId);
        emit EvaluationFinalized(submissionId, eligible, qualityScore, evidenceHash);
    }

    function proposeAward(
        bytes32 awardId,
        bytes32 submissionId,
        address winner,
        uint256 amount,
        uint8 settlementMode,
        bytes32 evidenceHash
    ) external onlyAgent {
        if (!submissions[submissionId].exists) revert SubmissionMissing(submissionId);
        if (awards[awardId].status != AwardStatus.None) revert InvalidAwardStatus(awardId, AwardStatus.None, awards[awardId].status);
        if (settlementMode > uint8(SettlementMode.ClaimToken)) revert InvalidSettlementMode(settlementMode);

        Submission storage submission = submissions[submissionId];
        _requireAvailableBudget(submission.hackathonId, submission.trackId, amount);

        awards[awardId] = Award({
            hackathonId: submission.hackathonId,
            submissionId: submissionId,
            trackId: submission.trackId,
            winner: winner,
            amount: amount,
            settlementMode: SettlementMode(settlementMode),
            status: AwardStatus.Proposed,
            evidenceHash: evidenceHash
        });

        emit AwardProposed(awardId, submissionId, winner, amount, settlementMode, evidenceHash);
    }

    function executeAutonomousPayout(bytes32 awardId) external onlyAgent nonReentrant {
        Award storage award = awards[awardId];
        if (award.status == AwardStatus.None) revert AwardMissing(awardId);
        if (award.status != AwardStatus.Proposed) revert InvalidAwardStatus(awardId, AwardStatus.Proposed, award.status);

        Hackathon storage hackathon = hackathons[award.hackathonId];
        if (award.amount > hackathon.autonomousThreshold) revert BudgetExceeded(award.hackathonId, award.trackId, award.amount, hackathon.autonomousThreshold);
        if (award.settlementMode != SettlementMode.AutonomousPayout) revert InvalidSettlementMode(uint8(award.settlementMode));

        TrackBudget storage track = trackBudgets[award.hackathonId][award.trackId];
        _requireAvailableBudget(award.hackathonId, award.trackId, award.amount);

        award.status = AwardStatus.PaidOut;
        track.paid += award.amount;
        IERC20(hackathon.payoutToken).safeTransfer(award.winner, award.amount);

        emit AwardApproved(awardId, msg.sender, uint8(award.settlementMode));
        emit PayoutReleased(awardId, award.winner, hackathon.payoutToken, award.amount);
    }

    function executeApprovedAward(AwardApproval calldata approval, bytes calldata signature) external nonReentrant {
        if (block.timestamp > approval.expiresAt) revert ApprovalExpired(approval.expiresAt);
        Award storage award = awards[approval.awardId];
        if (award.status == AwardStatus.None) revert AwardMissing(approval.awardId);
        if (award.status != AwardStatus.Proposed) revert InvalidAwardStatus(approval.awardId, AwardStatus.Proposed, award.status);
        if (
            award.hackathonId != approval.hackathonId ||
            award.submissionId != approval.submissionId ||
            award.trackId != approval.trackId ||
            award.winner != approval.winner ||
            award.amount != approval.amount ||
            uint8(award.settlementMode) != approval.settlementMode
        ) revert InvalidApprovalPayload();

        bytes32 digest = getAwardApprovalDigest(approval);
        address signer = ECDSA.recover(digest, signature);
        Hackathon storage hackathon = hackathons[approval.hackathonId];
        if (signer != hackathon.judge && signer != hackathon.organizer) revert InvalidSignature();

        TrackBudget storage track = trackBudgets[approval.hackathonId][approval.trackId];
        _requireAvailableBudget(approval.hackathonId, approval.trackId, approval.amount);

        award.status = AwardStatus.Approved;
        emit AwardApproved(approval.awardId, signer, approval.settlementMode);

        if (SettlementMode(approval.settlementMode) == SettlementMode.ClaimToken) {
            string memory metadataURI = string(abi.encodePacked("jb://claim/", Strings.toHexString(uint256(approval.awardId), 32)));
            int64 serialNumber = prizeClaimToken.mintClaim(approval.awardId, approval.winner, metadataURI);

            track.reserved += approval.amount;
            hackathon.totalReserved += approval.amount;
            award.status = AwardStatus.ClaimMinted;

            emit ClaimMinted(approval.awardId, approval.winner, prizeClaimToken.claimCollection(), serialNumber, metadataURI);
            return;
        }

        award.status = AwardStatus.PaidOut;
        track.paid += approval.amount;
        IERC20(hackathon.payoutToken).safeTransfer(approval.winner, approval.amount);
        emit PayoutReleased(approval.awardId, approval.winner, hackathon.payoutToken, approval.amount);
    }

    function redeemClaim(bytes32 awardId) external nonReentrant {
        Award storage award = awards[awardId];
        if (award.status != AwardStatus.ClaimMinted) revert InvalidAwardStatus(awardId, AwardStatus.ClaimMinted, award.status);

        Hackathon storage hackathon = hackathons[award.hackathonId];
        TrackBudget storage track = trackBudgets[award.hackathonId][award.trackId];
        (address claimant, int64 serialNumber, ) = prizeClaimToken.consumeClaim(awardId);

        award.status = AwardStatus.Redeemed;
        track.reserved -= award.amount;
        track.paid += award.amount;
        hackathon.totalReserved -= award.amount;

        IERC20(hackathon.payoutToken).safeTransfer(claimant, award.amount);
        emit ClaimRedeemed(awardId, claimant, serialNumber);
        emit PayoutReleased(awardId, claimant, hackathon.payoutToken, award.amount);
    }

    function refundRemaining(bytes32 hackathonId, bytes32 trackId, address recipient, uint256 amount) external nonReentrant {
        Hackathon storage hackathon = hackathons[hackathonId];
        if (!hackathon.exists) revert HackathonMissing(hackathonId);
        if (msg.sender != hackathon.organizer && msg.sender != owner()) revert Unauthorized();

        TrackBudget storage track = trackBudgets[hackathonId][trackId];
        uint256 available = _availableBudget(track);
        if (amount > available) revert BudgetExceeded(hackathonId, trackId, amount, available);

        track.budget -= amount;
        hackathon.totalBudget -= amount;
        IERC20(hackathon.payoutToken).safeTransfer(recipient, amount);
        emit Refunded(hackathonId, trackId, recipient, amount);
    }

    function getAwardApprovalDigest(AwardApproval calldata approval) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                AWARD_APPROVAL_TYPEHASH,
                approval.awardId,
                approval.hackathonId,
                approval.submissionId,
                approval.trackId,
                approval.winner,
                approval.amount,
                approval.settlementMode,
                approval.expiresAt
            )
        );
        return _hashTypedDataV4(structHash);
    }

    function _requireAvailableBudget(bytes32 hackathonId, bytes32 trackId, uint256 amount) private view {
        TrackBudget storage track = trackBudgets[hackathonId][trackId];
        uint256 available = _availableBudget(track);
        if (amount > available) revert BudgetExceeded(hackathonId, trackId, amount, available);
    }

    function _availableBudget(TrackBudget storage track) private view returns (uint256) {
        return track.budget - track.reserved - track.paid;
    }
}
