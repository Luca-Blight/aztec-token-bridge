pragma solidity >=0.8.20;

import {TokenPortal} from "./TokenPortal.sol";

import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";


contract UniswapPortal {



    // Using a struct here to avoid stack too deep errors
    struct LocalSwapVars {
        IERC20 inputAsset;
        IERC20 outputAsset;
        bytes32 contentHash;
    }
    
    ISwapRouter public constant ROUTER = ISwapRouter(0xE592427A0AEce92De3EbC44e9952151FEc589004);
    IRegistry public registry;
    bytes32 public l2UniswapAddress;


    function initialize(address _registry, bytes32 _l2UniswapAddress) external {
        registry = IRegistry(_registry);
        l2UniswapAddress = _l2UniswapAddress;
    }


        /**
    * @notice Exit with funds from L2, perform swap on L1 and deposit output asset to L2 again publicly
    * @dev `msg.value` indicates fee to submit message to inbox. Currently, anyone can call this method on your behalf.
    * They could call it with 0 fee causing the sequencer to never include in the rollup.
    * In this case, you will have to cancel the message and then make the deposit later
    * @param _inputTokenPortal - The ethereum address of the input token portal
    * @param _inAmount - The amount of assets to swap (same amount as withdrawn from L2)
    * @param _uniswapFeeTier - The fee tier for the swap on UniswapV3
    * @param _outputTokenPortal - The ethereum address of the output token portal
    * @param _amountOutMinimum - The minimum amount of output assets to receive from the swap (slippage protection)
    * @param _aztecRecipient - The aztec address to receive the output assets
    * @param _secretHashForL1ToL2Message - The hash of the secret consumable message. The hash should be 254 bits (so it can fit in a Field element)
    * @param _withCaller - When true, using `msg.sender` as the caller, otherwise address(0)
    * @return A hash of the L1 to L2 message inserted in the Inbox
    */
    function swapPublic(
        address _inputTokenPortal,
        uint256 _inAmount,
        uint24 _uniswapFeeTier,
        address _outputTokenPortal,
        uint256 _amountOutMinimum,
        bytes32 _aztecRecipient,
        bytes32 _secretHashForL1ToL2Message,
        bool _withCaller,
        // Avoiding stack too deep
        PortalDataStructures.OutboxMessageMetadata[2] calldata _outboxMessageMetadata
    )   public returns (bytes32, uint256) {

        LocalSwapVars memory swapVars;

        // is this suggesting that there are two token portal contracts?
        swapVars.inputAsset = TokenPortal(_inputTokenPortal).underlying();
        swapVars.outputAsset = TokenPortal(_outputTokenPortal).underlying();

        // Withdraw the input asset from the L2 via its portal
        {
            TokenPortal(_inputTokenPortal).withdraw(address(this), 
                _inAmount, 
                true, 
                _outboxMessageMetadata[0]._l2BlockNumber, 
                _outboxMessageMetadata[0]._leftIndex, 
                _outboxMessageMetadata[0]._path
            );
        }

        // Hash the swap public method call to be included in the outbox message 
        // Does this hash imitate the L2-to-L1 message?
        {
            swapVars.contentHash = Hash.sha256ToField(
                abi.encodeWithSignature(
                    "swap_public(address, uint256, uint24, address, uint256, bytes32, bytes32, address)",
                    _inputTokenPortal,
                    _inAmount,
                    _uniswapFeeTier,
                    _outputTokenPortal,
                    _amountOutMinimum,
                    _aztecRecipient,
                    _secretHashForL1ToL2Message,
                    _withCaller ? msg.sender : address(0)
                )
            );
        }

        // Consume the outbox message(L2-to-L1) -> create swap params ->    
        // approve router address to spend input asset -> perform swap -> 
        // approve output asset -> deposit to L2 via its portal
        {
            IOutbox outbox = IRollup(registry.getRollup()).OUTBOX();

            outbox.consume(
                DataStructures.L2ToL1Msg({
                    sender: DataStructures.L2Actor(l2UniswapAddress, 1),
                    recipient: DataStructures.L1Actor(address(this), block.chainid),
                    content: swapVars.contentHash
                }),
                _outboxMessageMetadata[1]._l2BlockNumber,
                _outboxMessageMetadata[1]._leafIndex,
                _outboxMessageMetadata[1]._path
            );

            ISwapRouter.ExactInputSingleParams memory swapParams; // why declare here?

            {
                swapParams = ISwapRouter.ExactInputSingleParams({
                    tokenIn: address(swapVars.inputAsset),
                    tokenOut: address(swapVars.outputAsset),
                    fee: _uniswapFeeTier,
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountIn: _inAmount,
                    amountOutMinimum: _amountOutMinimum,
                    sqrtPriceLimitX96: 0
                });
            }

            // Note, safeApprove was deprecated from OpenZeppelin
            swapVars.inputAsset.approve(address(ROUTER), _inAmount); // why does ISwapRouter need to be wrapped in a contract?

            // Perform the swap on L1
            uint256 amountOut = ROUTER.exactInputSingle(swapParams);

            // Approve the output asset to be deposited to the L2 via its portal. 
            // In other words its gives the portal contract the authority to move the funds to the L1
            swapVars.outputAsset.approve(address(_outputTokenPortal), amountOut);

            // Run the portal function to deposit amount and send the output asset to the L2
            return (
                TokenPortal(_outputTokenPortal).depositToAztecPublic(
                    _aztecRecipient, 
                    amountOut, 
                    _secretHashForL1ToL2Message
                ),
                amountOut
            );
        }
    }

      /**
   * @notice Exit with funds from L2, perform swap on L1 and deposit output asset to L2 again privately
   * @dev `msg.value` indicates fee to submit message to inbox. Currently, anyone can call this method on your behalf.
   * They could call it with 0 fee causing the sequencer to never include in the rollup.
   * In this case, you will have to cancel the message and then make the deposit later
   * @param _inputTokenPortal - The ethereum address of the input token portal
   * @param _inAmount - The amount of assets to swap (same amount as withdrawn from L2)
   * @param _uniswapFeeTier - The fee tier for the swap on UniswapV3
   * @param _outputTokenPortal - The ethereum address of the output token portal
   * @param _amountOutMinimum - The minimum amount of output assets to receive from the swap (slippage protection)
   * @param _secretHashForRedeemingMintedNotes - The hash of the secret to redeem minted notes privately on Aztec. The hash should be 254 bits (so it can fit in a Field element)
   * @param _secretHashForL1ToL2Message - The hash of the secret consumable message. The hash should be 254 bits (so it can fit in a Field element)
   * @param _withCaller - When true, using `msg.sender` as the caller, otherwise address(0)
   * @return A hash of the L1 to L2 message inserted in the Inbox
   */


   function swapPrivate(
    address _inputTokenPortal,
    uint256 _inAmount,
    uint24 _uniswapFeeTier,
    address _outputTokenPortal,
    uint256 _amountOutMinimum,
    bytes32 _secretHashForRedeemingMintedNotes,
    bytes32 _secretHashForL1ToL2Message,
    bool _withCaller,

    // Avoiding stack too deep
    PortalDataStructures.OutboxMessageMetadata[2] calldata _outboxMessageMetadata
   ) public returns (bytes32, uint256) {

    LocalSwapVars memory swapVars;

    swapVars.inputAsset = TokenPortal(_inputTokenPortal).underlying();
    swapVars.outputAsset = TokenPortal(_outputTokenPortal).underlying();


    {
        TokenPortal(_inputTokenPortal).withdraw(
            address(this),
            _inAmount,
            true,
            _outboxMessageMetaData[0]._l2BlockNumber,
            _outboxMessageMetaData[0]._leafIndex,
            _outboxMessageMetaData[0]._path
        );
    }

    {
        IOutbox outbox = IRollup(registry.getRollup()).OUTBOX();

        outbox.consume(
            DataStructures.L2ToL1Msg(
                {
                    sender: DataStructures.L2Actor(l2UniswapAddress, 1),
                    recipient: DataStructures.L1Actor(address(this), block.chainId),
                    content: swapVars.contentHash
                }
            ),
            _outboxMessageMetaData[1]._l2BlockNumber,
            _outboxMessageMetaData[1]._leafIndex,
            _outboxMessageMetaData[1]._path

        );
    }

    // Perform the swap

    ISwapRouter.ExactInputSingleParams memory swapParams;
    {
        swapParams = ISwapRouter.ExactInputSingleParams({
            tokenIn: address(swapVars.inputAsset),
            tokenOut: address(swapVars.outputAsset),
            fee: _uniswapFeeTier,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: _inAmount,
            amountOutMinimum: _amountOutMinimum,
            sqrtPriceLimitX96: 0
        });
    }

    // Approve the input asset to be spent by the router
    swapVars.inputAsset.approve(address(ROUTER), _inAmount);
    // Perform the swap
    uint256 amountOut = ROUTER.exactInputSingle(swapParams);

    swapVars.outputAsset.approve(address(_outputTokenPortal), amountOut);

    return (
        TokenPortal(_outputTokenPortal).depositToAztecPrivate(
            _secretHashForRedeemingMintedNotes,
            amountOut,
            _secretHashForL1ToL2Message
        ),
    );

   }

}