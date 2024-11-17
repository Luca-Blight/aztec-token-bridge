pragma solidity >=0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// Messaging
import {IRegistry} from "@aztec/l1-contracts/src/core/interfaces/messagebridge/IRegistry.sol";
import {IInbox} from "@aztec/l1-contracts/src/core/interfaces/messagebridge/IInbox.sol";
import {IOutbox} from "@aztec/l1-contracts/src/core/interfaces/messagebridge/IOutbox.sol";
import {DataStructures} from "@aztec/l1-contracts/src/core/libraries/DataStructures.sol";
import {Hash} from "@aztec/l1-contracts/src/core/libraries/Hash.sol";



contract TokenPortal {
    using SafeERC20 for IERC20;



    IRegistry public registry;
    IERC20 public underlying;
    bytes32 public l2Bridge;


    event DepositToAztecPublic(
        bytes32 to, 
        uint256 amount, 
        bytes32 secretHash, 
        bytes32 key, 
        uint256 nonce
    );

    event DepositToAztecPrivate(
        bytes32 secretHashForRedeemingMintedNotes,
        uint256 amount,
        bytes32 secretHashForL2MessageConsumption,
        bytes32 key,
        uint256 index
    );


    function initialize(address _registry, address _underlying, bytes32 _l2Bridge) external {
        registry = IRegistry(_registry);
        underlying = IERC20(_underlying);
        l2Bridge = _l2Bridge;
    }

    /**
    * @notice Deposit funds into the portal and adds an L2 message which can only be consumed publicly on Aztec
    * @param _to - The aztec address of the recipient
    * @param _amount - The amount to deposit
    * @param _secretHash - The hash of the secret consumable message. The hash should be 254 bits (so it can fit in a Field element)
    * @return The key of the entry in the Inbox and its leaf index
    */

    function depositToAztecPublic(bytes32 _to, uint256 _amount, bytes32 _secretHash) external returns (bytes32, uint256)
    {

        // Preamble
        IInbox inbox = IRollup(registry.getRollup()).getInbox();
        DataStructures.L2Actor memory actor = DataStructures.L2Actor(l2Bridge,1);

        // Hash the message content to be reconstructed in the receiving contract
        bytes32 contentHash = Hash.sha256ToField(abi.encodeWithSignature("mint_public(bytes32,uint256)", _to, _amount));

        //hold the tokens in the portal
        underlying.safeTransferFrom(msg.sender, address(this), _amount);

        // Send message to rollup
        (bytes32 key, uint256 index) = inbox.sendL2Message(actor, contentHash, _secretHash);

        emit DepositToAztecPublic(_to, _amount, _secretHash, key, index);

        return (key, index);

        
    }

    /**
    * @notice Deposit funds into the portal and adds an L2 message which can only be consumed privately on Aztec
    * @param _secretHashForRedeemingMintedNotes - The hash of the secret to redeem minted notes privately on Aztec. The hash should be 254 bits (so it can fit in a Field element)
    * @param _secretHashForL2MessageConsumption - The hash of the secret consumable L1 to L2 message. The hash should be 254 bits (so it can fit in a Field element)
    * @param _amount - The amount to deposit
    * @return The key of the entry in the Inbox and its leaf index
    */
    function depositToAztecPrivate(
        bytes32 _secretHashForRedeemingMintedNotes,
        bytes32 _secretHashForL2MessageConsumption,
        uint256 _amount
    ) external returns (bytes32, uint256){

        // Preamble
        IInbox inbox = IRollup(registry.getRollup()).INBOX();
        DataStructures.L2Actor memory actor = DataStructures.L2(l2Bridge, 1);

        // Hash the message content to be reconstructed in the receiving contract
        bytes32 contentHash = Hash.sha256ToField(abi.encodeWithSignature(
            "mint_private(bytes32,uint256)", _secretHashForRedeemingMintedNotes, _amount
        )
        ); 

        // Hold the tokens in the portal
        underlying.safeTransferFrom(msg.sender, address(this), _amount);

        // Send message to rollup
        (bytes32 key, uint256 index) = inbox.sendL2Message(actor, contentHash, _secretHashForL2MessageConsumption);
         
         // Emit event
         emit DepositToAztecPrivate(
            _secretHashForRedeemingMintedNotes, _amount, _secretHasForL2MessageConsumption, key, index
         );

        return (key, index);


    }

}