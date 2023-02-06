import {
  decodeIdlAccount,
  findMintEditionId,
  findMintMetadataId,
  getBatchedMultipleAccounts,
  METADATA_PROGRAM_ID,
  tryDecodeIdlAccount,
  tryGetAccount,
  tryNull,
} from "@cardinal/common";
import { tokenManager } from "@cardinal/token-manager/dist/cjs/programs";
import {
  CRANK_KEY,
  getRemainingAccountsForKind,
  TOKEN_MANAGER_ADDRESS,
  TokenManagerKind,
  TokenManagerState,
} from "@cardinal/token-manager/dist/cjs/programs/tokenManager";
import {
  findMintCounterId,
  findTokenManagerAddress,
} from "@cardinal/token-manager/dist/cjs/programs/tokenManager/pda";
import { PROGRAM_ID as TOKEN_AUTH_RULES_ID } from "@metaplex-foundation/mpl-token-auth-rules";
import {
  Metadata,
  TokenStandard,
} from "@metaplex-foundation/mpl-token-metadata";
import { BN } from "@project-serum/anchor";
import type { Wallet } from "@project-serum/anchor/dist/cjs/provider";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  unpackMint,
} from "@solana/spl-token";
import type { Connection, PublicKey } from "@solana/web3.js";
import {
  Keypair,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";

import type { CardinalRewardDistributor } from "./idl/cardinal_reward_distributor";
import type { CardinalStakePool } from "./idl/cardinal_stake_pool";
import type {
  GroupRewardDistributorKind,
  GroupRewardDistributorMetadataKind,
  GroupRewardDistributorPoolKind,
} from "./programs/groupRewardDistributor";
import { getGroupRewardEntry } from "./programs/groupRewardDistributor/accounts";
import { findGroupRewardEntryId } from "./programs/groupRewardDistributor/pda";
import {
  withClaimGroupRewards,
  withCloseGroupRewardEntry,
  withInitGroupRewardDistributor,
  withInitGroupRewardEntry,
  withUpdateGroupRewardDistributor,
} from "./programs/groupRewardDistributor/transaction";
import type { RewardDistributorKind } from "./programs/rewardDistributor";
import {
  REWARD_DISTRIBUTOR_IDL,
  REWARD_MANAGER,
  rewardDistributorProgram,
} from "./programs/rewardDistributor";
import {
  getRewardDistributor,
  getRewardEntry,
} from "./programs/rewardDistributor/accounts";
import {
  findRewardDistributorId,
  findRewardEntryId,
} from "./programs/rewardDistributor/pda";
import {
  withInitRewardDistributor,
  withInitRewardEntry,
  withUpdateRewardEntry,
} from "./programs/rewardDistributor/transaction";
import {
  ReceiptType,
  STAKE_POOL_IDL,
  stakePoolProgram,
} from "./programs/stakePool";
import {
  getStakeEntries,
  getStakeEntry,
  getStakePool,
} from "./programs/stakePool/accounts";
import { findStakeEntryId } from "./programs/stakePool/pda";
import {
  withAddToGroupEntry,
  withAuthorizeStakeEntry,
  withInitGroupStakeEntry,
  withInitStakeEntry,
  withInitStakeMint,
  withInitStakePool,
  withInitUngrouping,
  withRemoveFromGroupEntry,
  withUpdateTotalStakeSeconds,
} from "./programs/stakePool/transaction";
import {
  findStakeEntryIdFromMint,
  remainingAccountsForInitStakeEntry,
  shouldReturnReceipt,
} from "./programs/stakePool/utils";
import { findTokenRecordId } from "./utils";

/**
 * Convenience call to create a stake pool
 * @param connection - Connection to use
 * @param wallet - Wallet to use
 * @param requiresCollections - (Optional) List of required collections pubkeys
 * @param requiresCreators - (Optional) List of required creators pubkeys
 * @param requiresAuthorization - (Optional) Boolean to require authorization
 * @param overlayText - (Optional) Text to overlay on receipt mint tokens
 * @param imageUri - (Optional) Image URI for stake pool
 * @param resetOnStake - (Optional) Boolean to reset an entry's total stake seconds on unstake
 * @param cooldownSeconds - (Optional) Number of seconds for token to cool down before returned to the staker
 * @param rewardDistributor - (Optional) Parameters to creat reward distributor
 * @returns
 */
export const createStakePool = async (
  connection: Connection,
  wallet: Wallet,
  params: {
    requiresCollections?: PublicKey[];
    requiresCreators?: PublicKey[];
    requiresAuthorization?: boolean;
    overlayText?: string;
    imageUri?: string;
    resetOnStake?: boolean;
    cooldownSeconds?: number;
    minStakeSeconds?: number;
    endDate?: BN;
    doubleOrResetEnabled?: boolean;
    rewardDistributor?: {
      rewardMintId: PublicKey;
      rewardAmount?: BN;
      rewardDurationSeconds?: BN;
      rewardDistributorKind?: RewardDistributorKind;
      maxSupply?: BN;
      supply?: BN;
    };
  }
): Promise<[Transaction, PublicKey, PublicKey?]> => {
  const transaction = new Transaction();

  const [, stakePoolId] = await withInitStakePool(
    transaction,
    connection,
    wallet,
    params
  );
  let rewardDistributorId;
  if (params.rewardDistributor) {
    [, rewardDistributorId] = await withInitRewardDistributor(
      transaction,
      connection,
      wallet,
      {
        stakePoolId: stakePoolId,
        rewardMintId: params.rewardDistributor.rewardMintId,
        rewardAmount: params.rewardDistributor.rewardAmount,
        rewardDurationSeconds: params.rewardDistributor.rewardDurationSeconds,
        kind: params.rewardDistributor.rewardDistributorKind,
        maxSupply: params.rewardDistributor.maxSupply,
        supply: params.rewardDistributor.supply,
      }
    );
  }
  return [transaction, stakePoolId, rewardDistributorId];
};

/**
 * Convenience call to create a reward distributor
 * @param connection - Connection to use
 * @param wallet - Wallet to use
 * @param rewardMintId - (Optional) Reward mint id
 * @param rewardAmount - (Optional) Reward amount
 * @param rewardDurationSeconds - (Optional) Reward duration in seconds
 * @param rewardDistributorKind - (Optional) Reward distributor kind Mint or Treasury
 * @param maxSupply - (Optional) Max supply
 * @param supply - (Optional) Supply
 * @returns
 */
export const createRewardDistributor = async (
  connection: Connection,
  wallet: Wallet,
  params: {
    stakePoolId: PublicKey;
    rewardMintId: PublicKey;
    rewardAmount?: BN;
    rewardDurationSeconds?: BN;
    kind?: RewardDistributorKind;
    maxSupply?: BN;
    supply?: BN;
  }
): Promise<[Transaction, PublicKey]> =>
  withInitRewardDistributor(new Transaction(), connection, wallet, params);

/**
 * Convenience call to create a stake entry
 * @param connection - Connection to use
 * @param wallet - Wallet to use
 * @param stakePoolId - Stake pool ID
 * @param originalMintId - Original mint ID
 * @param user - (Optional) User pubkey in case the person paying for the transaction and
 * stake entry owner are different
 * @returns
 */
export const createStakeEntry = async (
  connection: Connection,
  wallet: Wallet,
  params: {
    stakePoolId: PublicKey;
    originalMintId: PublicKey;
  }
): Promise<[Transaction, PublicKey]> => {
  const stakeEntryId = await findStakeEntryIdFromMint(
    connection,
    wallet.publicKey,
    params.stakePoolId,
    params.originalMintId
  );
  return [
    await withInitStakeEntry(new Transaction(), connection, wallet, {
      stakePoolId: params.stakePoolId,
      stakeEntryId,
      originalMintId: params.originalMintId,
    }),
    stakeEntryId,
  ];
};

/**
 * Convenience call to create a stake entry
 * @param connection - Connection to use
 * @param wallet - Wallet to use
 * @param stakePoolId - Stake pool ID
 * @param originalMintId - Original mint ID
 * @returns
 */
export const initializeRewardEntry = async (
  connection: Connection,
  wallet: Wallet,
  params: {
    stakePoolId: PublicKey;
    originalMintId: PublicKey;
    multiplier?: BN;
  }
): Promise<Transaction> => {
  const stakeEntryId = await findStakeEntryIdFromMint(
    connection,
    wallet.publicKey,
    params.stakePoolId,
    params.originalMintId
  );
  const stakeEntryData = await tryGetAccount(() =>
    getStakeEntry(connection, stakeEntryId)
  );

  const transaction = new Transaction();
  if (!stakeEntryData) {
    await withInitStakeEntry(transaction, connection, wallet, {
      stakePoolId: params.stakePoolId,
      stakeEntryId,
      originalMintId: params.originalMintId,
    });
  }

  const rewardDistributorId = findRewardDistributorId(params.stakePoolId);
  await withInitRewardEntry(transaction, connection, wallet, {
    stakeEntryId: stakeEntryId,
    rewardDistributorId: rewardDistributorId,
  });

  await withUpdateRewardEntry(transaction, connection, wallet, {
    stakePoolId: params.stakePoolId,
    rewardDistributorId: rewardDistributorId,
    stakeEntryId: stakeEntryId,
    multiplier: params.multiplier ?? new BN(1), //TODO default multiplier
  });
  return transaction;
};

/**
 * Convenience call to authorize a stake entry
 * @param connection - Connection to use
 * @param wallet - Wallet to use
 * @param stakePoolId - Stake pool ID
 * @param originalMintId - Original mint ID
 * @returns
 */
export const authorizeStakeEntry = (
  connection: Connection,
  wallet: Wallet,
  params: {
    stakePoolId: PublicKey;
    originalMintId: PublicKey;
  }
) => {
  return withAuthorizeStakeEntry(new Transaction(), connection, wallet, {
    stakePoolId: params.stakePoolId,
    originalMintId: params.originalMintId,
  });
};

/**
 * Convenience call to create a stake entry and a stake mint
 * @param connection - Connection to use
 * @param wallet - Wallet to use
 * @param stakePoolId - Stake pool ID
 * @param originalMintId - Original mint ID
 * @param amount - (Optional) Amount of tokens to be staked, defaults to 1
 * @returns
 */
export const createStakeEntryAndStakeMint = async (
  connection: Connection,
  wallet: Wallet,
  params: {
    stakePoolId: PublicKey;
    originalMintId: PublicKey;
    receiptName?: string;
  }
): Promise<[Transaction, PublicKey, Keypair | undefined]> => {
  let transaction = new Transaction();
  const stakeEntryId = await findStakeEntryIdFromMint(
    connection,
    wallet.publicKey,
    params.stakePoolId,
    params.originalMintId
  );
  const stakeEntryData = await tryGetAccount(() =>
    getStakeEntry(connection, stakeEntryId)
  );
  if (!stakeEntryData) {
    transaction = (
      await createStakeEntry(connection, wallet, {
        stakePoolId: params.stakePoolId,
        originalMintId: params.originalMintId,
      })
    )[0];
  }

  let stakeMintKeypair: Keypair | undefined;
  if (!stakeEntryData?.parsed.stakeMint) {
    stakeMintKeypair = Keypair.generate();
    const stakePool = await getStakePool(connection, params.stakePoolId);

    await withInitStakeMint(transaction, connection, wallet, {
      stakePoolId: params.stakePoolId,
      stakeEntryId: stakeEntryId,
      originalMintId: params.originalMintId,
      stakeMintKeypair,
      name:
        params.receiptName ??
        `POOl${stakePool.parsed.identifier.toString()} RECEIPT`,
      symbol: `POOl${stakePool.parsed.identifier.toString()}`,
    });
  }

  return [transaction, stakeEntryId, stakeMintKeypair];
};

/**
 * Convenience method to claim rewards
 * @param connection - Connection to use
 * @param wallet - Wallet to use
 * @param stakePoolId - Stake pool id
 * @param stakeEntryId - Original mint id
 * @returns
 */
export const claimRewards = async (
  connection: Connection,
  wallet: Wallet,
  params: {
    stakePoolId: PublicKey;
    stakeEntryIds: PublicKey[];
    lastStaker?: PublicKey;
    payer?: PublicKey;
    skipRewardMintTokenAccount?: boolean;
  }
): Promise<Transaction[]> => {
  /////// derive ids ///////
  const rewardDistributorId = findRewardDistributorId(params.stakePoolId);
  const rewardEntryIds = params.stakeEntryIds.map((stakeEntryId) =>
    findRewardEntryId(rewardDistributorId, stakeEntryId)
  );

  /////// get accounts ///////
  const rewardDistributorData = await tryNull(() =>
    getRewardDistributor(connection, rewardDistributorId)
  );
  if (!rewardDistributorData) throw "No reward distributor found";
  const rewardEntryInfos = await getBatchedMultipleAccounts(
    connection,
    rewardEntryIds
  );

  const rewardMintTokenAccountId = getAssociatedTokenAddressSync(
    rewardDistributorData.parsed.rewardMint,
    params.lastStaker ?? wallet.publicKey,
    true
  );
  const txs: Transaction[] = [];
  for (let i = 0; i < params.stakeEntryIds.length; i++) {
    const stakeEntryId = params.stakeEntryIds[i]!;
    const rewardEntryId = rewardEntryIds[i];
    const tx = new Transaction();
    /////// update seconds ///////
    await withUpdateTotalStakeSeconds(tx, connection, wallet, {
      stakeEntryId,
      lastStaker: wallet.publicKey,
    });
    /////// init ata ///////
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        params.payer ?? wallet.publicKey,
        rewardMintTokenAccountId,
        params.lastStaker ?? wallet.publicKey,
        rewardDistributorData.parsed.rewardMint
      )
    );
    /////// init entry ///////
    if (!rewardEntryInfos[i]?.data) {
      const ix = await rewardDistributorProgram(connection, wallet)
        .methods.initRewardEntry()
        .accounts({
          rewardEntry: rewardEntryId,
          stakeEntry: stakeEntryId,
          rewardDistributor: rewardDistributorData.pubkey,
          payer: params.payer ?? wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      tx.add(ix);
    }
    /////// claim rewards ///////
    const ix = await rewardDistributorProgram(connection, wallet)
      .methods.claimRewards()
      .accounts({
        rewardEntry: rewardEntryId,
        rewardDistributor: rewardDistributorData.pubkey,
        stakeEntry: stakeEntryId,
        stakePool: params.stakePoolId,
        rewardMint: rewardDistributorData.parsed.rewardMint,
        userRewardMintTokenAccount: rewardMintTokenAccountId,
        rewardManager: REWARD_MANAGER,
        user: params.payer ?? wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        {
          pubkey: getAssociatedTokenAddressSync(
            rewardDistributorData.parsed.rewardMint,
            rewardDistributorData.pubkey,
            true
          ),
          isSigner: false,
          isWritable: true,
        },
      ])
      .instruction();
    tx.add(ix);
    txs.push(tx);
  }
  return txs;
};

/**
 * Convenience method to stake tokens
 * @param connection - Connection to use
 * @param wallet - Wallet to use
 * @param stakePoolId - Stake pool id
 * @param originalMintId - Original mint id
 * @param userOriginalMintTokenAccountId - User's original mint token account id
 * @param receiptType - (Optional) ReceiptType to be received back. If none provided, none will be claimed
 * @param user - (Optional) User pubkey in case the person paying for the transaction and
 * stake entry owner are different
 * @param amount - (Optional) Amount of tokens to be staked, defaults to 1
 * @returns
 */
export const stake = async (
  connection: Connection,
  wallet: Wallet,
  params: {
    stakePoolId: PublicKey;
    originalMintId: PublicKey;
    userOriginalMintTokenAccountId: PublicKey;
    receiptType?: ReceiptType;
    amount?: BN;
  }
): Promise<Transaction> => {
  /////// derive ids ///////
  const mintMetadataId = findMintMetadataId(params.originalMintId);

  /////// get accounts ///////
  const [mintAccountInfo, metadataAccountInfo] =
    await connection.getMultipleAccountsInfo([
      params.originalMintId,
      mintMetadataId,
    ]);

  /////// deserialize accounts ///////
  const mintInfo = unpackMint(params.originalMintId, mintAccountInfo ?? null);
  const mintMetadata = metadataAccountInfo
    ? Metadata.fromAccountInfo(metadataAccountInfo)[0]
    : null;
  const stakeEntryId = findStakeEntryId(
    wallet.publicKey,
    params.stakePoolId,
    params.originalMintId,
    Number(mintInfo.supply.toString()) > 1
  );
  const stakeEntryData = await tryNull(() =>
    getStakeEntry(connection, stakeEntryId)
  );

  /////// start transaction ///////
  const transaction = new Transaction();

  /////// init entry ///////
  if (!stakeEntryData) {
    const ix = await stakePoolProgram(connection, wallet)
      .methods.initEntry(wallet.publicKey)
      .accounts({
        stakeEntry: stakeEntryId,
        stakePool: params.stakePoolId,
        originalMint: params.originalMintId,
        originalMintMetadata: findMintMetadataId(params.originalMintId),
        payer: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        remainingAccountsForInitStakeEntry(
          params.stakePoolId,
          params.originalMintId
        )
      )
      .instruction();
    transaction.add(ix);
  }

  if (
    mintMetadata?.tokenStandard === TokenStandard.ProgrammableNonFungible &&
    mintMetadata.programmableConfig?.ruleSet
  ) {
    /////// programmable ///////
    transaction.add(
      await stakePoolProgram(connection, wallet)
        .methods.stakeProgrammable(params.amount ?? new BN(1))
        .accountsStrict({
          stakeEntry: stakeEntryId,
          stakePool: params.stakePoolId,
          originalMint: params.originalMintId,
          systemProgram: SystemProgram.programId,
          user: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          tokenMetadataProgram: METADATA_PROGRAM_ID,
          userOriginalMintTokenAccount: params.userOriginalMintTokenAccountId,
          userOriginalMintTokenRecord: findTokenRecordId(
            params.originalMintId,
            params.userOriginalMintTokenAccountId
          ),
          mintMetadata: mintMetadataId,
          mintEdition: findMintEditionId(params.originalMintId),
          authorizationRules: mintMetadata.programmableConfig?.ruleSet,
          sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
          authorizationRulesProgram: TOKEN_AUTH_RULES_ID,
        })
        .instruction()
    );
  } else {
    /////// non-programmable ///////
    const stakeEntryOriginalMintTokenAccountId = getAssociatedTokenAddressSync(
      params.originalMintId,
      stakeEntryId,
      true
    );
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        stakeEntryOriginalMintTokenAccountId,
        stakeEntryId,
        params.originalMintId
      )
    );
    const ix = await stakePoolProgram(connection, wallet)
      .methods.stake(params.amount || new BN(1))
      .accounts({
        stakeEntry: stakeEntryId,
        stakePool: params.stakePoolId,
        stakeEntryOriginalMintTokenAccount:
          stakeEntryOriginalMintTokenAccountId,
        originalMint: params.originalMintId,
        user: wallet.publicKey,
        userOriginalMintTokenAccount: params.userOriginalMintTokenAccountId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    transaction.add(ix);

    /////// receipts ///////
    if (params.receiptType && params.receiptType !== ReceiptType.None) {
      const receiptMintId =
        params.receiptType === ReceiptType.Receipt
          ? stakeEntryData?.parsed.stakeMint
          : params.originalMintId;
      if (!receiptMintId) {
        throw "Stake entry has no stake mint. Initialize stake mint first.";
      }
      if (
        stakeEntryData?.parsed.stakeMintClaimed ||
        stakeEntryData?.parsed.originalMintClaimed
      ) {
        throw "Receipt has already been claimed.";
      }
      if (
        !stakeEntryData?.parsed ||
        stakeEntryData.parsed.amount.toNumber() === 0
      ) {
        const tokenManagerId = findTokenManagerAddress(receiptMintId);
        const tokenManagerReceiptMintTokenAccountId =
          getAssociatedTokenAddressSync(receiptMintId, tokenManagerId, true);
        transaction.add(
          createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            tokenManagerReceiptMintTokenAccountId,
            tokenManagerId,
            receiptMintId
          )
        );
        const ix = await stakePoolProgram(connection, wallet)
          .methods.claimReceiptMint()
          .accounts({
            stakeEntry: stakeEntryId,
            originalMint: params.originalMintId,
            receiptMint: receiptMintId,
            stakeEntryReceiptMintTokenAccount: getAssociatedTokenAddressSync(
              receiptMintId,
              stakeEntryId,
              true
            ),
            user: wallet.publicKey,
            userReceiptMintTokenAccount: getAssociatedTokenAddressSync(
              receiptMintId,
              wallet.publicKey,
              true
            ),
            tokenManagerReceiptMintTokenAccount:
              tokenManagerReceiptMintTokenAccountId,
            tokenManager: tokenManagerId,
            mintCounter: findMintCounterId(receiptMintId),
            tokenProgram: TOKEN_PROGRAM_ID,
            tokenManagerProgram: TOKEN_MANAGER_ADDRESS,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .remainingAccounts(
            getRemainingAccountsForKind(
              receiptMintId,
              params.receiptType === ReceiptType.Original
                ? TokenManagerKind.Edition
                : TokenManagerKind.Managed
            )
          )
          .instruction();
        transaction.add(ix);
      }
    }
  }
  return transaction;
};

/**
 * Convenience method to unstake tokens
 * @param connection - Connection to use
 * @param wallet - Wallet to use
 * @param stakePoolId - Stake pool ID
 * @param originalMintId - Original mint ID
 * @returns
 */
export const unstake = async (
  connection: Connection,
  wallet: Wallet,
  params: {
    stakePoolId: PublicKey;
    originalMintId: PublicKey;
    skipRewardMintTokenAccount?: boolean;
  }
): Promise<Transaction> => {
  /////// derive ids ///////
  const mintMetadataId = findMintMetadataId(params.originalMintId);
  const rewardDistributorId = findRewardDistributorId(params.stakePoolId);
  const userOriginalMintTokenAccountId = getAssociatedTokenAddressSync(
    params.originalMintId,
    wallet.publicKey
  );

  /////// get accounts ///////
  const [
    mintAccountInfo,
    metadataAccountInfo,
    rewardDistributorInfo,
    stakePoolInfo,
  ] = await connection.getMultipleAccountsInfo([
    params.originalMintId,
    mintMetadataId,
    findRewardDistributorId(params.stakePoolId),
    params.stakePoolId,
  ]);

  /////// deserialize accounts ///////
  const mintInfo = unpackMint(params.originalMintId, mintAccountInfo ?? null);
  const mintMetadata = metadataAccountInfo
    ? Metadata.fromAccountInfo(metadataAccountInfo)[0]
    : null;
  const rewardDistributorData = rewardDistributorInfo
    ? tryDecodeIdlAccount<"rewardDistributor", CardinalRewardDistributor>(
        rewardDistributorInfo,
        "rewardDistributor",
        REWARD_DISTRIBUTOR_IDL
      )
    : null;
  if (!stakePoolInfo?.data) throw "Stake pool not found";
  const stakePoolData = decodeIdlAccount<"stakePool", CardinalStakePool>(
    stakePoolInfo,
    "stakePool",
    STAKE_POOL_IDL
  );
  const stakeEntryId = findStakeEntryId(
    wallet.publicKey,
    params.stakePoolId,
    params.originalMintId,
    Number(mintInfo.supply.toString()) > 1
  );

  /////// start transaction ///////
  const transaction = new Transaction();

  /////// init user token account ///////
  transaction.add(
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      userOriginalMintTokenAccountId,
      wallet.publicKey,
      params.originalMintId
    )
  );

  if (rewardDistributorData?.parsed) {
    /////// update total stake seconds ///////
    const updateIx = await stakePoolProgram(connection, wallet)
      .methods.updateTotalStakeSeconds()
      .accountsStrict({
        stakeEntry: stakeEntryId,
        lastStaker: wallet.publicKey,
      })
      .instruction();
    transaction.add(updateIx);

    /////// claim rewards ///////
    const rewardEntryId = findRewardEntryId(rewardDistributorId, stakeEntryId);
    const rewardEntry = await tryGetAccount(() =>
      getRewardEntry(connection, rewardEntryId)
    );
    const userRewardMintTokenAccount = getAssociatedTokenAddressSync(
      rewardDistributorData.parsed.rewardMint,
      wallet.publicKey,
      true
    );
    if (!rewardEntry) {
      const ix = await rewardDistributorProgram(connection, wallet)
        .methods.initRewardEntry()
        .accountsStrict({
          rewardEntry: findRewardEntryId(rewardDistributorId, stakeEntryId),
          rewardDistributor: rewardDistributorId,
          stakeEntry: stakeEntryId,
          payer: wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      transaction.add(ix);
    }
    const ix = await rewardDistributorProgram(connection, wallet)
      .methods.claimRewards()
      .accountsStrict({
        rewardEntry: rewardEntryId,
        rewardDistributor: rewardDistributorId,
        stakeEntry: stakeEntryId,
        stakePool: params.stakePoolId,
        rewardMint: rewardDistributorData.parsed.rewardMint,
        userRewardMintTokenAccount: userRewardMintTokenAccount,
        rewardManager: REWARD_MANAGER,
        user: wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        {
          pubkey: getAssociatedTokenAddressSync(
            rewardDistributorData.parsed.rewardMint,
            rewardDistributorId,
            true
          ),
          isSigner: false,
          isWritable: true,
        },
      ])
      .instruction();
    transaction.add(ix);
  }
  if (
    mintMetadata?.tokenStandard === TokenStandard.ProgrammableNonFungible &&
    mintMetadata.programmableConfig?.ruleSet
  ) {
    /////// programmable ///////
    const ix = await stakePoolProgram(connection, wallet)
      .methods.unstakeProgrammable()
      .accountsStrict({
        stakeEntry: stakeEntryId,
        stakePool: params.stakePoolId,
        originalMint: params.originalMintId,
        systemProgram: SystemProgram.programId,
        user: wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenMetadataProgram: METADATA_PROGRAM_ID,
        userOriginalMintTokenAccount: userOriginalMintTokenAccountId,
        userOriginalMintTokenRecord: findTokenRecordId(
          params.originalMintId,
          userOriginalMintTokenAccountId
        ),
        mintMetadata: mintMetadataId,
        mintEdition: findMintEditionId(params.originalMintId),
        authorizationRules: mintMetadata.programmableConfig?.ruleSet,
        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        authorizationRulesProgram: TOKEN_AUTH_RULES_ID,
      })
      .instruction();
    transaction.add(ix);
  } else {
    /////// non-programmable ///////
    const stakeEntry = await getStakeEntry(connection, stakeEntryId);

    if (
      stakeEntry.parsed.stakeMintClaimed ||
      stakeEntry.parsed.originalMintClaimed
    ) {
      /////// receipts ///////
      const receiptMint =
        stakeEntry.parsed.stakeMint && stakeEntry.parsed.stakeMintClaimed
          ? stakeEntry.parsed.stakeMint
          : stakeEntry.parsed.originalMint;

      const tokenManagerId = findTokenManagerAddress(receiptMint);
      const tokenManagerData = await tryNull(() =>
        tokenManager.accounts.getTokenManager(connection, tokenManagerId)
      );

      if (
        tokenManagerData &&
        shouldReturnReceipt(stakePoolData.parsed, stakeEntry.parsed)
      ) {
        const ix = await stakePoolProgram(connection, wallet)
          .methods.returnReceiptMint()
          .accountsStrict({
            stakeEntry: stakeEntryId,
            receiptMint: receiptMint,
            tokenManager: tokenManagerData.pubkey,
            tokenManagerTokenAccount: getAssociatedTokenAddressSync(
              receiptMint,
              tokenManagerId,
              true
            ),
            userReceiptMintTokenAccount: getAssociatedTokenAddressSync(
              receiptMint,
              wallet.publicKey,
              true
            ),
            user: wallet.publicKey,
            collector: CRANK_KEY,
            tokenProgram: TOKEN_PROGRAM_ID,
            tokenManagerProgram: TOKEN_MANAGER_ADDRESS,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .remainingAccounts([
            ...(tokenManagerData.parsed.state === TokenManagerState.Claimed
              ? getRemainingAccountsForKind(
                  receiptMint,
                  tokenManagerData.parsed.kind
                )
              : []),
            // assume stake entry receipt mint account is already created
            {
              pubkey: getAssociatedTokenAddressSync(
                receiptMint,
                stakeEntryId,
                true
              ),
              isSigner: false,
              isWritable: true,
            },
          ])
          .instruction();
        transaction.add(ix);
      }
    }
    const stakeEntryOriginalMintTokenAccountId = getAssociatedTokenAddressSync(
      params.originalMintId,
      stakeEntryId,
      true
    );
    const program = stakePoolProgram(connection, wallet);
    const ix = await program.methods
      .unstake()
      .accountsStrict({
        stakePool: params.stakePoolId,
        stakeEntry: stakeEntryId,
        originalMint: params.originalMintId,
        stakeEntryOriginalMintTokenAccount:
          stakeEntryOriginalMintTokenAccountId,
        user: wallet.publicKey,
        userOriginalMintTokenAccount: userOriginalMintTokenAccountId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(
        stakeEntry.parsed.stakeMint
          ? [
              {
                pubkey: getAssociatedTokenAddressSync(
                  stakeEntry.parsed.stakeMint,
                  stakeEntryId,
                  true
                ),
                isSigner: false,
                isWritable: false,
              },
            ]
          : []
      )
      .instruction();
    transaction.add(ix);
  }
  return transaction;
};

/**
 * Convenience call to create a group entry
 * @param connection - Connection to use
 * @param wallet - Wallet to use
 * @param params
 * stakePoolId - Stake pool ID
 * originalMintId - Original mint ID
 * user - (Optional) User pubkey in case the person paying for the transaction and
 * stake entry owner are different
 * @returns
 */
export const createGroupEntry = async (
  connection: Connection,
  wallet: Wallet,
  params: {
    stakeEntryIds: PublicKey[];
    groupCooldownSeconds?: number;
    groupStakeSeconds?: number;
  }
): Promise<[Transaction, PublicKey]> => {
  if (!params.stakeEntryIds.length) throw new Error("No stake entry found");
  const [transaction, groupEntryId] = await withInitGroupStakeEntry(
    new Transaction(),
    connection,
    wallet,
    {
      groupCooldownSeconds: params.groupCooldownSeconds,
      groupStakeSeconds: params.groupStakeSeconds,
    }
  );

  await Promise.all(
    params.stakeEntryIds.map((stakeEntryId) =>
      withAddToGroupEntry(transaction, connection, wallet, {
        groupEntryId,
        stakeEntryId,
      })
    )
  );

  return [transaction, groupEntryId];
};

/**
 * Convenience call to create a group reward distributor
 * @param connection - Connection to use
 * @param wallet - Wallet to use
 * @param params
 *  rewardMintId - (Optional) Reward mint id
 *  authorizedPools - Authorized stake pool ids
 *  rewardAmount - (Optional) Reward amount
 *  rewardDurationSeconds - (Optional) Reward duration in seconds
 *  rewardKind - (Optional) Reward distributor kind Mint or Treasury
 *  poolKind - (Optional) Reward distributor pool validation kind NoRestriction, AllFromSinglePool or EachFromSeparatePool
 *  metadataKind - (Optional) Reward distributor metadata validation kind NoRestriction, UniqueNames or UniqueSymbols
 *  supply - (Optional) Supply
 *  baseAdder - (Optional) Base adder value that will be add to the calculated multiplier
 *  baseAdderDecimals - (Optional) Base adder decimals
 *  baseMultiplier - (Optional) Base multiplier value that will be multiplied by the calculated multiplier
 *  baseMultiplierDecimals - (Optional) Base multiplier decimals
 *  multiplierDecimals - (Optional) Multiplier decimals
 *  maxSupply - (Optional) Max supply
 *  minCooldownSeconds - (Optional) number;
 *  minStakeSeconds - (Optional) number;
 *  groupCountMultiplier - (Optional) Group Count Multiplier if provided will multiplied the total reward to this number and total groups that this user has
 *  groupCountMultiplierDecimals - (Optional) Group Count Multiplier decimals
 *  minGroupSize - (Optional) min group size
 *  maxRewardSecondsReceived - (Optional) max reward seconds received
 * @returns
 */
export const createGroupRewardDistributor = async (
  connection: Connection,
  wallet: Wallet,
  params: {
    rewardMintId: PublicKey;
    authorizedPools: PublicKey[];
    rewardAmount?: BN;
    rewardDurationSeconds?: BN;
    rewardKind?: GroupRewardDistributorKind;
    poolKind?: GroupRewardDistributorPoolKind;
    metadataKind?: GroupRewardDistributorMetadataKind;
    supply?: BN;
    baseAdder?: BN;
    baseAdderDecimals?: number;
    baseMultiplier?: BN;
    baseMultiplierDecimals?: number;
    multiplierDecimals?: number;
    maxSupply?: BN;
    minCooldownSeconds?: number;
    minStakeSeconds?: number;
    groupCountMultiplier?: BN;
    groupCountMultiplierDecimals?: number;
    minGroupSize?: number;
    maxRewardSecondsReceived?: BN;
  }
): Promise<[Transaction, PublicKey]> =>
  withInitGroupRewardDistributor(new Transaction(), connection, wallet, params);

/**
 * Convenience call to update a group reward distributor
 * @param connection - Connection to use
 * @param wallet - Wallet to use
 * @param params
 * groupRewardDistributorId - Group reward distributor id
 * authorizedPools - Authorized stake pool ids
 * rewardAmount - (Optional) Reward amount
 * rewardDurationSeconds - (Optional) Reward duration in seconds
 * poolKind - (Optional) Reward distributor pool validation kind NoRestriction, AllFromSinglePool or EachFromSeparatePool
 * metadataKind - (Optional) Reward distributor metadata validation kind NoRestriction, UniqueNames or UniqueSymbols
 * baseAdder - (Optional) Base adder value that will be add to the calculated multiplier
 * baseAdderDecimals - (Optional) Base adder decimals
 * baseMultiplier - (Optional) Base multiplier value that will be multiplied by the calculated multiplier
 * baseMultiplierDecimals - (Optional) Base multiplier decimals
 * multiplierDecimals - (Optional) Multiplier decimals
 * maxSupply - (Optional) Max supply
 * minCooldownSeconds - (Optional) number;
 * minStakeSeconds - (Optional) number;
 * groupCountMultiplier - (Optional) Group Count Multiplier if provided will multiplied the total reward to this number and total groups that this user has
 * groupCountMultiplierDecimals - (Optional) Group Count Multiplier decimals
 * minGroupSize - (Optional) min group size
 * maxRewardSecondsReceived - (Optional) max reward seconds received
 * @returns
 */
export const updateGroupRewardDistributor = async (
  connection: Connection,
  wallet: Wallet,
  params: {
    groupRewardDistributorId: PublicKey;
    authorizedPools: PublicKey[];
    rewardAmount?: BN;
    rewardDurationSeconds?: BN;
    poolKind?: GroupRewardDistributorPoolKind;
    metadataKind?: GroupRewardDistributorMetadataKind;
    baseAdder?: BN;
    baseAdderDecimals?: number;
    baseMultiplier?: BN;
    baseMultiplierDecimals?: number;
    multiplierDecimals?: number;
    maxSupply?: BN;
    minCooldownSeconds?: number;
    minStakeSeconds?: number;
    groupCountMultiplier?: BN;
    groupCountMultiplierDecimals?: number;
    minGroupSize?: number;
    maxRewardSecondsReceived?: BN;
  }
): Promise<Transaction> =>
  withUpdateGroupRewardDistributor(
    new Transaction(),
    connection,
    wallet,
    params
  );

/**
 * Convenience method to claim rewards
 * @param connection - Connection to use
 * @param wallet - Wallet to use
 * @param params
 * groupRewardDistributorId - Group reward distributor ID
 * groupEntryId - Group entry ID
 * stakeEntryIds - Stake entry IDs
 * @returns
 */
export const claimGroupRewards = async (
  connection: Connection,
  wallet: Wallet,
  params: {
    groupRewardDistributorId: PublicKey;
    groupEntryId: PublicKey;
    stakeEntryIds: PublicKey[];
  }
): Promise<[Transaction]> => {
  const transaction = new Transaction();

  const groupRewardEntryId = findGroupRewardEntryId(
    params.groupRewardDistributorId,
    params.groupEntryId
  );

  const groupRewardEntry = await tryGetAccount(() =>
    getGroupRewardEntry(connection, groupRewardEntryId)
  );
  if (!groupRewardEntry) {
    const stakeEntriesData = await getStakeEntries(
      connection,
      params.stakeEntryIds
    );

    const stakeEntries = await Promise.all(
      stakeEntriesData.map((stakeEntry) => {
        const rewardDistributorId = findRewardDistributorId(
          stakeEntry.parsed.pool
        );
        return {
          stakeEntryId: stakeEntry.pubkey,
          originalMint: stakeEntry.parsed.originalMint,
          rewardDistributorId,
        };
      })
    );

    await withInitGroupRewardEntry(transaction, connection, wallet, {
      groupRewardDistributorId: params.groupRewardDistributorId,
      groupEntryId: params.groupEntryId,
      stakeEntries,
    });
  }

  await withClaimGroupRewards(transaction, connection, wallet, {
    groupRewardDistributorId: params.groupRewardDistributorId,
    groupEntryId: params.groupEntryId,
  });

  return [transaction];
};

/**
 * Convenience method to close group stake entry
 * @param connection - Connection to use
 * @param wallet - Wallet to use
 * @param params
 * groupRewardDistributorId - Group reward distributor ID
 * groupEntryId - Group entry ID
 * stakeEntryIds - Stake entry IDs
 * @returns
 */
export const closeGroupEntry = async (
  connection: Connection,
  wallet: Wallet,
  params: {
    groupRewardDistributorId: PublicKey;
    groupEntryId: PublicKey;
    stakeEntryIds: PublicKey[];
  }
): Promise<[Transaction]> => {
  const [transaction] = await claimGroupRewards(connection, wallet, params);

  await withCloseGroupRewardEntry(transaction, connection, wallet, {
    groupEntryId: params.groupEntryId,
    groupRewardDistributorId: params.groupRewardDistributorId,
  });

  await Promise.all(
    params.stakeEntryIds.map((stakeEntryId) =>
      withRemoveFromGroupEntry(transaction, connection, wallet, {
        groupEntryId: params.groupEntryId,
        stakeEntryId,
      })
    )
  );
  return [transaction];
};

/**
 * Convenience method to init ungrouping
 * @param connection - Connection to use
 * @param wallet - Wallet to use
 * @param params
 * groupRewardDistributorId - Group reward distributor ID
 * groupEntryId - Group entry ID
 * stakeEntryIds - Stake entry IDs
 * @returns
 */
export const initUngrouping = async (
  connection: Connection,
  wallet: Wallet,
  params: {
    groupEntryId: PublicKey;
  }
): Promise<[Transaction]> => {
  const transaction = new Transaction();

  await withInitUngrouping(transaction, connection, wallet, {
    groupEntryId: params.groupEntryId,
  });

  return [transaction];
};
