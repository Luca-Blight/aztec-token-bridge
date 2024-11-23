import { expect } from "@jest/globals";
import {
  type AztecAddress,
  type AztecNode,
  type DebugLogger,
  EthAddress,
  ExtendedNote,
  type FieldsOf,
  Fr,
  type L1TokenManager,
  L1TokenPortalManager,
  type L2AmountClaim,
  type L2RedeemableAmountClaim,
  Note,
  type PXE,
  type SiblingPath,
  type TxHash,
  type TxReceipt,
  type Wallet,
  deployL1Contract,
  retryUntil,
} from "@aztec/aztec.js";
import { type L1ContractAddresses } from "@aztec/ethereum";
import {
  TestERC20Abi,
  TestERC20Bytecode,
  TokenPortalAbi,
  TokenPortalBytecode,
} from "@aztec/l1-artifacts";
import { TokenContract } from "@aztec/noir-contracts.js/Token";
import { TokenBridgeContract } from "@aztec/noir-contracts.js/TokenBridge";

import {
  type Account,
  type Chain,
  type Hex,
  type HttpTransport,
  type PublicClient,
  type WalletClient,
  getContract,
} from "viem";

import { mintTokensToPrivate } from "../fixtures/token_utils.js";

/**
 * Deploy L1 token and portal, initialize portal, deploy a non native l2 token contract, its L2 bridge contract and attach is to the portal.
 * @param wallet - the wallet instance
 * @param walletClient - A viem WalletClient.
 * @param publicClient - A viem PublicClient.
 * @param rollupRegistryAddress - address of rollup registry to pass to initialize the token portal
 * @param owner - owner of the L2 contract
 * @param underlyingERC20Address - address of the underlying ERC20 contract to use (if none supplied, it deploys one)
 * @returns l2 contract instance, bridge contract instance, token portal instance, token portal address and the underlying ERC20 instance
 */
export async function deployAndInitializeTokenAndBridgeContracts(
  wallet: Wallet,
  walletClient: WalletClient<HttpTransport, Chain, Account>,
  publicClient: PublicClient<HttpTransport, Chain>,
  rollupRegistryAddress: EthAddress,
  owner: AztecAddress,
  underlyingERC20Address?: EthAddress
): Promise<{
  /**
   * The L2 token contract instance.
   */
  token: TokenContract;
  /**
   * The L2 bridge contract instance.
   */
  bridge: TokenBridgeContract;
  /**
   * The token portal contract address.
   */
  tokenPortalAddress: EthAddress;
  /**
   * The token portal contract instance
   */
  tokenPortal: any;
  /**
   * The underlying ERC20 contract instance.
   */
  underlyingERC20: any;
}> {
  if (!underlyingERC20Address) {
    underlyingERC20Address = await deployL1Contract(
      walletClient,
      publicClient,
      TestERC20Abi,
      TestERC20Bytecode
    ).then(({ address }) => address);
  }
  const underlyingERC20 = getContract({
    address: underlyingERC20Address!.toString(),
    abi: TestERC20Abi,
    client: walletClient,
  });

  // deploy the token portal
  const { address: tokenPortalAddress } = await deployL1Contract(
    walletClient,
    publicClient,
    TokenPortalAbi,
    TokenPortalBytecode
  );
  const tokenPortal = getContract({
    address: tokenPortalAddress.toString(),
    abi: TokenPortalAbi,
    client: walletClient,
  });

  // deploy l2 token
  const token = await TokenContract.deploy(
    wallet,
    owner,
    "TokenName",
    "TokenSymbol",
    18
  )
    .send()
    .deployed();

  // deploy l2 token bridge and attach to the portal
  const bridge = await TokenBridgeContract.deploy(
    wallet,
    token.address,
    tokenPortalAddress
  )
    .send()
    .deployed();

  if ((await token.methods.get_admin().simulate()) !== owner.toBigInt()) {
    throw new Error(`Token admin is not ${owner}`);
  }

  if (!(await bridge.methods.get_token().simulate()).equals(token.address)) {
    throw new Error(`Bridge token is not ${token.address}`);
  }

  // make the bridge a minter on the token:
  await token.methods.set_minter(bridge.address, true).send().wait();
  if ((await token.methods.is_minter(bridge.address).simulate()) === 1n) {
    throw new Error(`Bridge is not a minter`);
  }

  // initialize portal
  await tokenPortal.write.initialize(
    [
      rollupRegistryAddress.toString(),
      underlyingERC20Address!.toString(),
      bridge.address.toString(),
    ],
    {} as any
  );

  return { token, bridge, tokenPortalAddress, tokenPortal, underlyingERC20 };
}

/**
 * A Class for testing cross chain interactions, contains common interactions
 * shared between cross chain tests.
 */
export class CrossChainTestHarness {
  static async new(
    aztecNode: AztecNode,
    pxeService: PXE,
    publicClient: PublicClient<HttpTransport, Chain>,
    walletClient: WalletClient<HttpTransport, Chain, Account>,
    wallet: Wallet,
    logger: DebugLogger,
    underlyingERC20Address?: EthAddress
  ): Promise<CrossChainTestHarness> {
    
    const ethAccount = EthAddress.fromString(
      (await walletClient.getAddresses())[0]
    );
    const l1ContractAddresses = (await pxeService.getNodeInfo())
      .l1ContractAddresses;

    // Deploy and initialize all required contracts
    logger.info("Deploying and initializing token, portal and its bridge...");
    const { token, bridge, tokenPortalAddress, underlyingERC20 } =
      await deployAndInitializeTokenAndBridgeContracts(
        wallet,
        walletClient,
        publicClient,
        l1ContractAddresses.registryAddress,
        wallet.getAddress(),
        underlyingERC20Address
      );
    logger.info("Deployed and initialized token, portal and its bridge.");

    return new CrossChainTestHarness(
      aztecNode,
      pxeService,
      logger,
      token,
      bridge,
      ethAccount,
      tokenPortalAddress,
      underlyingERC20.address,
      publicClient,
      walletClient,
      l1ContractAddresses,
      wallet
    );
  }

  private readonly l1TokenManager: L1TokenManager;
  private readonly l1TokenPortalManager: L1TokenPortalManager;

  public readonly ownerAddress: AztecAddress;

  constructor(
    /** Aztec node instance. */
    public aztecNode: AztecNode,
    /** Private eXecution Environment (PXE). */
    public pxeService: PXE,
    /** Logger. */
    public logger: DebugLogger,

    /** L2 Token contract. */
    public l2Token: TokenContract,
    /** L2 Token bridge contract. */
    public l2Bridge: TokenBridgeContract,

    /** Eth account to interact with. */
    public ethAccount: EthAddress,

    /** Portal address. */
    public tokenPortalAddress: EthAddress,
    /** Underlying token for portal tests. */
    public underlyingERC20Address: EthAddress,
    /** Viem Public client instance. */
    public publicClient: PublicClient<HttpTransport, Chain>,
    /** Viem Wallet Client instance. */
    public walletClient: WalletClient<HttpTransport, Chain, Account>,

    /** Deployment addresses for all L1 contracts */
    public readonly l1ContractAddresses: L1ContractAddresses,

    /** Wallet of the owner. */
    public readonly ownerWallet: Wallet
  ) {
    this.l1TokenPortalManager = new L1TokenPortalManager(
      this.tokenPortalAddress,
      this.underlyingERC20Address,
      this.l1ContractAddresses.outboxAddress,
      this.publicClient,
      this.walletClient,
      this.logger
    );
    this.l1TokenManager = this.l1TokenPortalManager.getTokenManager();
    this.ownerAddress = this.ownerWallet.getAddress();
  }

  async mintTokensOnL1(amount: bigint) {
    await this.l1TokenManager.mint(amount, this.ethAccount.toString());
    expect(
      await this.l1TokenManager.getL1TokenBalance(this.ethAccount.toString())
    ).toEqual(amount);
  }

  getL1BalanceOf(address: EthAddress) {
    return this.l1TokenManager.getL1TokenBalance(address.toString());
  }

  sendTokensToPortalPublic(bridgeAmount: bigint, mint = false) {
    return this.l1TokenPortalManager.bridgeTokensPublic(
      this.ownerAddress,
      bridgeAmount,
      mint
    );
  }

  sendTokensToPortalPrivate(bridgeAmount: bigint, mint = false) {
    return this.l1TokenPortalManager.bridgeTokensPrivate(
      this.ownerAddress,
      bridgeAmount,
      mint
    );
  }

  async mintTokensPublicOnL2(amount: bigint) {
    this.logger.info("Minting tokens on L2 publicly");
    await this.l2Token.methods
      .mint_public(this.ownerAddress, amount)
      .send()
      .wait();
  }

  async mintTokensPrivateOnL2(amount: bigint) {
    await mintTokensToPrivate(
      this.l2Token,
      this.ownerWallet,
      this.ownerAddress,
      amount
    );
  }

  async sendL2PublicTransfer(
    transferAmount: bigint,
    receiverAddress: AztecAddress
  ) {
    // send a transfer tx to force through rollup with the message included
    await this.l2Token.methods
      .transfer_public(this.ownerAddress, receiverAddress, transferAmount, 0)
      .send()
      .wait();
  }

  async consumeMessageOnAztecAndMintPrivately(
    claim: Pick<
      L2RedeemableAmountClaim,
      "claimAmount" | "claimSecret" | "messageLeafIndex" | "redeemSecretHash"
    >
  ) {
    this.logger.info("Consuming messages on L2 privately");
    const {
      claimAmount,
      claimSecret: secretForL2MessageConsumption,
      messageLeafIndex,
      redeemSecretHash,
    } = claim;
    const consumptionReceipt = await this.l2Bridge.methods
      .claim_private(
        redeemSecretHash,
        claimAmount,
        secretForL2MessageConsumption,
        messageLeafIndex
      )
      .send()
      .wait();

    await this.addPendingShieldNoteToPXE(
      claimAmount.toBigInt(),
      redeemSecretHash,
      consumptionReceipt.txHash
    );
  }

  async consumeMessageOnAztecAndMintPublicly(
    claim: Pick<
      L2AmountClaim,
      "claimAmount" | "claimSecret" | "messageLeafIndex"
    >
  ) {
    this.logger.info("Consuming messages on L2 Publicly");
    const { claimAmount, claimSecret, messageLeafIndex } = claim;
    await this.l2Bridge.methods
      .claim_public(
        this.ownerAddress,
        claimAmount,
        claimSecret,
        messageLeafIndex
      )
      .send()
      .wait();
  }

  async withdrawPrivateFromAztecToL1(
    withdrawAmount: bigint,
    nonce: Fr = Fr.ZERO
  ): Promise<FieldsOf<TxReceipt>> {
    const withdrawReceipt = await this.l2Bridge.methods
      .exit_to_l1_private(
        this.l2Token.address,
        this.ethAccount,
        withdrawAmount,
        EthAddress.ZERO,
        nonce
      )
      .send()
      .wait();

    return withdrawReceipt;
  }

  async withdrawPublicFromAztecToL1(
    withdrawAmount: bigint,
    nonce: Fr = Fr.ZERO
  ): Promise<FieldsOf<TxReceipt>> {
    const withdrawReceipt = await this.l2Bridge.methods
      .exit_to_l1_public(
        this.ethAccount,
        withdrawAmount,
        EthAddress.ZERO,
        nonce
      )
      .send()
      .wait();

    return withdrawReceipt;
  }

  async getL2PrivateBalanceOf(owner: AztecAddress) {
    return await this.l2Token.methods
      .balance_of_private(owner)
      .simulate({ from: owner });
  }

  async expectPrivateBalanceOnL2(owner: AztecAddress, expectedBalance: bigint) {
    const balance = await this.getL2PrivateBalanceOf(owner);
    this.logger.info(`Account ${owner} balance: ${balance}`);
    expect(balance).toBe(expectedBalance);
  }

  async getL2PublicBalanceOf(owner: AztecAddress) {
    return await this.l2Token.methods.balance_of_public(owner).simulate();
  }

  async expectPublicBalanceOnL2(owner: AztecAddress, expectedBalance: bigint) {
    const balance = await this.getL2PublicBalanceOf(owner);
    expect(balance).toBe(expectedBalance);
  }

  getL2ToL1MessageLeaf(
    withdrawAmount: bigint,
    callerOnL1: EthAddress = EthAddress.ZERO
  ): Fr {
    return this.l1TokenPortalManager.getL2ToL1MessageLeaf(
      withdrawAmount,
      this.ethAccount,
      this.l2Bridge.address,
      callerOnL1
    );
  }

  withdrawFundsFromBridgeOnL1(
    amount: bigint,
    blockNumber: number | bigint,
    messageIndex: bigint,
    siblingPath: SiblingPath<number>
  ) {
    return this.l1TokenPortalManager.withdrawFunds(
      amount,
      this.ethAccount,
      BigInt(blockNumber),
      messageIndex,
      siblingPath
    );
  }

  async shieldFundsOnL2(shieldAmount: bigint, secretHash: Fr) {
    this.logger.info("Shielding funds on L2");
    const shieldReceipt = await this.l2Token.methods
      .shield(this.ownerAddress, shieldAmount, secretHash, 0)
      .send()
      .wait();

    await this.addPendingShieldNoteToPXE(
      shieldAmount,
      secretHash,
      shieldReceipt.txHash
    );
  }

  async addPendingShieldNoteToPXE(
    shieldAmount: bigint,
    secretHash: Fr,
    txHash: TxHash
  ) {
    this.logger.info("Adding note to PXE");
    const note = new Note([new Fr(shieldAmount), secretHash]);
    const extendedNote = new ExtendedNote(
      note,
      this.ownerAddress,
      this.l2Token.address,
      TokenContract.storage.pending_shields.slot,
      TokenContract.notes.TransparentNote.id,
      txHash
    );
    await this.ownerWallet.addNote(extendedNote);
  }

  async redeemShieldPrivatelyOnL2(shieldAmount: bigint, secret: Fr) {
    this.logger.info("Spending note in private call");
    await this.l2Token.methods
      .redeem_shield(this.ownerAddress, shieldAmount, secret)
      .send()
      .wait();
  }

  async transferToPublicOnL2(amount: bigint, nonce = Fr.ZERO) {
    this.logger.info("Transferring tokens to public");
    await this.l2Token.methods
      .transfer_to_public(this.ownerAddress, this.ownerAddress, amount, nonce)
      .send()
      .wait();
  }

  /**
   * Makes message available for consumption.
   * @dev Does that by performing 2 unrelated transactions on L2 to progress the rollup by 2 blocks and then waits for
   * message to be processed by archiver. We need to progress by 2 because there is a 1 block lag between when
   * the message is sent to Inbox and when the subtree containing the message is included in the block and then when
   * it's included it becomes available for consumption in the next block because the l1 to l2 message tree.
   */
  async makeMessageConsumable(msgHash: Fr | Hex) {
    const frMsgHash =
      typeof msgHash === "string" ? Fr.fromString(msgHash) : msgHash;
    const currentL2BlockNumber = await this.aztecNode.getBlockNumber();
    // We poll isL1ToL2MessageSynced endpoint until the message is available
    await retryUntil(
      async () =>
        await this.aztecNode.isL1ToL2MessageSynced(
          frMsgHash,
          currentL2BlockNumber
        ),
      "message sync",
      10
    );

    await this.mintTokensPublicOnL2(0n);
    await this.mintTokensPublicOnL2(0n);
  }
}
