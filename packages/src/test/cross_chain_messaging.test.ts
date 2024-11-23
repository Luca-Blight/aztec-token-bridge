import { beforeAll, describe, beforeEach, expect, jest, it} from '@jest/globals'
import { AccountWallet, AztecAddress, BatchCall, type DebugLogger, EthAddress, Fr, computeAuthWitMessageHash, createDebugLogger, createPXEClient, waitForPXE, L1ToL2Message, L1Actor, L2Actor, type PXE, type Wallet } from '@aztec/aztec.js';
import { getInitialTestAccountsWallets } from '@aztec/accounts/testing';
import { TokenContract } from '@aztec/noir-contracts.js/Token';
import { sha256ToField } from '@aztec/foundation/crypto';
import { TokenBridgeContract } from '@aztec/noir-contracts.js/TokenBridge';
import { createAztecNodeClient } from '@aztec/circuit-types';
import { deployInstance, registerContractClass } from '@aztec/aztec.js/deployment';
import { SchnorrAccountContractArtifact } from '@aztec/accounts/schnorr';

import { CrossChainTestHarness } from "./shared/cross_chain_test_harness.js";
import { mnemonicToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http, toFunctionSelector } from "viem";
import { foundry } from 'viem/chains';


const { PXE_URL = 'http://localhost:8080', ETHEREUM_HOST = 'http://localhost:8545' } = process.env;
const MNEMONIC = 'test test test test test test test test test test test junk';
const hdAccount = mnemonicToAccount(MNEMONIC);
const aztecNode = createAztecNodeClient(PXE_URL);

export const NO_L1_TO_L2_MSG_ERROR =
  /No non-nullified L1 to L2 message found for message hash|Tried to consume nonexistent L1-to-L2 message/;

async function publicDeployAccounts(sender: Wallet, accountsToDeploy: Wallet[], pxe: PXE) {
    const accountAddressesToDeploy = await Promise.all(
        accountsToDeploy.map(async a => {
            const address = await a.getAddress();
            const isDeployed = await pxe.isContractPubliclyDeployed(address);
            return { address, isDeployed };
        })
    ).then(results => results.filter(result => !result.isDeployed).map(result => result.address));
    if (accountAddressesToDeploy.length === 0) return
    const instances = await Promise.all(accountAddressesToDeploy.map(account => sender.getContractInstance(account)));
    const batch = new BatchCall(sender, [
        (await registerContractClass(sender, SchnorrAccountContractArtifact)).request(),
        ...instances.map(instance => deployInstance(sender, instance!).request()),
    ]);
    await batch.send().wait();
}

describe('e2e_cross_chain_messaging', () => {
  jest.setTimeout(90_000);

  let logger: DebugLogger;
  let wallets: AccountWallet[];
  let user1Wallet: AccountWallet;
  let user2Wallet: AccountWallet;
  let ethAccount: EthAddress;
  let ownerAddress: AztecAddress;

  let crossChainTestHarness: CrossChainTestHarness;
  let l2Token: TokenContract;
  let l2Bridge: TokenBridgeContract;
  let outbox: any;

  beforeAll(async () => {
    logger = createDebugLogger('aztec:e2e_uniswap');
    const pxe = createPXEClient(PXE_URL);
    await waitForPXE(pxe);
    wallets = await getInitialTestAccountsWallets(pxe);

    // deploy the accounts publicly to use public authwits
    await publicDeployAccounts(wallets[0], wallets, pxe);
  })

  beforeEach(async () => {
    logger = createDebugLogger('aztec:e2e_uniswap');
    const pxe = createPXEClient(PXE_URL);
    await waitForPXE(pxe);

    const walletClient = createWalletClient({
      account: hdAccount,
      chain: foundry,
      transport: http(ETHEREUM_HOST),
    });
    const publicClient = createPublicClient({
      chain: foundry,
      transport: http(ETHEREUM_HOST),
    });

    crossChainTestHarness = await CrossChainTestHarness.new(
      aztecNode,
      pxe,
      publicClient,
      walletClient,
      wallets[0],
      logger,
    );
      
      
    //   this.tokenPortalAddress,
    //   this.underlyingERC20Address,
    //   this.l1ContractAddresses.outboxAddress,
    //   this.publicClient,
    //   this.walletClient,
    //   this.logger

    l2Token = crossChainTestHarness.l2Token;
    l2Bridge = crossChainTestHarness.l2Bridge;
    ethAccount = crossChainTestHarness.ethAccount;
    ownerAddress = crossChainTestHarness.ownerAddress;
    outbox = crossChainTestHarness.outbox;
    user1Wallet = wallets[0];
    user2Wallet = wallets[1];
  });
    
    
    it("Privately deposit funds from L1 -> L2 and withdraw back to L1", async () => {
      // Generate a claim secret using pedersen
      const l1TokenBalance = 1000000n;
      const bridgeAmount = 100n;

      // 1. Mint tokens on L1
      await crossChainTestHarness.mintTokensOnL1(l1TokenBalance);

      // 2. Deposit tokens to the TokenPortal
      const claim = await crossChainTestHarness.sendTokensToPortalPrivate(
        bridgeAmount
      );
      expect(await crossChainTestHarness.getL1BalanceOf(ethAccount)).toBe(
        l1TokenBalance - bridgeAmount
      );

      await crossChainTestHarness.makeMessageConsumable(claim.messageHash);

      // 3. Consume L1 -> L2 message and mint private tokens on L2
      await crossChainTestHarness.consumeMessageOnAztecAndMintPrivately(claim);
      // tokens were minted privately in a TransparentNote which the owner (person who knows the secret) must redeem:
      await crossChainTestHarness.redeemShieldPrivatelyOnL2(
        bridgeAmount,
        claim.redeemSecret
      );
      await crossChainTestHarness.expectPrivateBalanceOnL2(
        ownerAddress,
        bridgeAmount
      );

      // time to withdraw the funds again!
      logger.info("Withdrawing funds from L2");

      // 4. Give approval to bridge to burn owner's funds:
      const withdrawAmount = 9n;
      const nonce = Fr.random();
      await user1Wallet.createAuthWit({
        caller: l2Bridge.address,
        action: l2Token.methods.burn(ownerAddress, withdrawAmount, nonce),
      });

      // 5. Withdraw owner's funds from L2 to L1
      const l2ToL1Message =
        crossChainTestHarness.getL2ToL1MessageLeaf(withdrawAmount);
      const l2TxReceipt =
        await crossChainTestHarness.withdrawPrivateFromAztecToL1(
          withdrawAmount,
          nonce
        );
      await crossChainTestHarness.expectPrivateBalanceOnL2(
        ownerAddress,
        bridgeAmount - withdrawAmount
      );

      const [l2ToL1MessageIndex, siblingPath] =
        await aztecNode.getL2ToL1MessageMembershipWitness(
          l2TxReceipt.blockNumber!,
          l2ToL1Message
        );

      // Since the outbox is only consumable when the block is proven, we need to set the block to be proven
      await rollup.write.setAssumeProvenThroughBlockNumber([
        await rollup.read.getPendingBlockNumber(),
      ]);

      // Check balance before and after exit.
      expect(await crossChainTestHarness.getL1BalanceOf(ethAccount)).toBe(
        l1TokenBalance - bridgeAmount
      );
      await crossChainTestHarness.withdrawFundsFromBridgeOnL1(
        withdrawAmount,
        l2TxReceipt.blockNumber!,
        l2ToL1MessageIndex,
        siblingPath
      );
        expect(await crossChainTestHarness.getL1BalanceOf(ethAccount)).toBe(
        l1TokenBalance - bridgeAmount + withdrawAmount
    );
  });
});

it('Publicly deposit funds from L1 -> L2 and withdraw back to L1', async () => {
  const l1TokenBalance = 1000000n;
  const bridgeAmount = 100n;

  // 1. Mint tokens on L1
  logger.verbose(`1. Mint tokens on L1`);
  await crossChainTestHarness.mintTokensOnL1(l1TokenBalance);

  // 2. Deposit tokens to the TokenPortal
  logger.verbose(`2. Deposit tokens to the TokenPortal`);
  const claim = await crossChainTestHarness.sendTokensToPortalPublic(bridgeAmount);
  const msgHash = Fr.fromString(claim.messageHash);
  expect(await crossChainTestHarness.getL1BalanceOf(ethAccount)).toBe(l1TokenBalance - bridgeAmount);

  // Wait for the message to be available for consumption
  logger.verbose(`Wait for the message to be available for consumption`);
  await crossChainTestHarness.makeMessageConsumable(msgHash);

  // Check message leaf index matches
  const maybeIndexAndPath = await aztecNode.getL1ToL2MessageMembershipWitness('latest', msgHash);
  expect(maybeIndexAndPath).toBeDefined();
  const messageLeafIndex = maybeIndexAndPath![0];
  expect(messageLeafIndex).toEqual(claim.messageLeafIndex);

  // 3. Consume L1 -> L2 message and mint public tokens on L2
  logger.verbose('3. Consume L1 -> L2 message and mint public tokens on L2');
  await crossChainTestHarness.consumeMessageOnAztecAndMintPublicly(claim);
  await crossChainTestHarness.expectPublicBalanceOnL2(ownerAddress, bridgeAmount);
  const afterBalance = bridgeAmount;

  // Time to withdraw the funds again!
  logger.info('Withdrawing funds from L2');

  // 4. Give approval to bridge to burn owner's funds:
  const withdrawAmount = 9n;
  const nonce = Fr.random();
  await user1Wallet
    .setPublicAuthWit(
      {
        caller: l2Bridge.address,
        action: l2Token.methods.burn_public(ownerAddress, withdrawAmount, nonce).request(),
      },
      true,
    )
    .send()
    .wait();

  // 5. Withdraw owner's funds from L2 to L1
  logger.verbose('5. Withdraw owner funds from L2 to L1');
  const l2ToL1Message = crossChainTestHarness.getL2ToL1MessageLeaf(withdrawAmount);
  const l2TxReceipt = await crossChainTestHarness.withdrawPublicFromAztecToL1(withdrawAmount, nonce);
  await crossChainTestHarness.expectPublicBalanceOnL2(ownerAddress, afterBalance - withdrawAmount);

  // Check balance before and after exit.
  expect(await crossChainTestHarness.getL1BalanceOf(ethAccount)).toBe(l1TokenBalance - bridgeAmount);

  const [l2ToL1MessageIndex, siblingPath] = await aztecNode.getL2ToL1MessageMembershipWitness(
    l2TxReceipt.blockNumber!,
    l2ToL1Message,
  );

  await t.assumeProven();

  await crossChainTestHarness.withdrawFundsFromBridgeOnL1(
    withdrawAmount,
    l2TxReceipt.blockNumber!,
    l2ToL1MessageIndex,
    siblingPath,
  );
  expect(await crossChainTestHarness.getL1BalanceOf(ethAccount)).toBe(l1TokenBalance - bridgeAmount + withdrawAmount);
  }, 120_000);
});
