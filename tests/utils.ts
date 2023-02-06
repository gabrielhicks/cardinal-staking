import {
  findMintEditionId,
  findMintMetadataId,
  findRuleSetId,
  findTokenRecordId,
} from "@cardinal/common";
import {
  createCreateOrUpdateInstruction,
  PROGRAM_ID as TOKEN_AUTH_RULES_ID,
} from "@metaplex-foundation/mpl-token-auth-rules";
import {
  createCreateInstruction,
  createCreateMasterEditionV3Instruction,
  createCreateMetadataAccountV2Instruction,
  createMintInstruction,
  TokenStandard,
} from "@metaplex-foundation/mpl-token-metadata";
import { encode } from "@msgpack/msgpack";
import type { Wallet } from "@project-serum/anchor/dist/cjs/provider";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import type {
  Connection,
  PublicKey,
  SendTransactionError,
  Signer,
} from "@solana/web3.js";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  sendAndConfirmRawTransaction,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";

export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function newAccountWithLamports(
  connection: Connection,
  lamports = LAMPORTS_PER_SOL * 10,
  keypair = Keypair.generate()
): Promise<Keypair> {
  const account = keypair;
  const signature = await connection.requestAirdrop(
    account.publicKey,
    lamports
  );
  await connection.confirmTransaction(signature, "confirmed");
  return account;
}

export const createMint = async (
  connection: Connection,
  wallet: Wallet,
  config?: MintConfig
): Promise<[PublicKey, PublicKey]> => {
  const mintKeypair = Keypair.generate();
  const mintId = mintKeypair.publicKey;
  const [tx, ata] = await createMintTx(
    connection,
    mintKeypair.publicKey,
    wallet.publicKey,
    config
  );
  await executeTransaction(connection, tx, wallet, { signers: [mintKeypair] });
  return [ata, mintId];
};

export type MintConfig = {
  target?: PublicKey;
  amount?: number;
  decimals?: number;
};
export const createMintTx = async (
  connection: Connection,
  mintId: PublicKey,
  authority: PublicKey,
  config?: MintConfig
): Promise<[Transaction, PublicKey]> => {
  const target = config?.target ?? authority;
  const ata = getAssociatedTokenAddressSync(mintId, target, true);
  return [
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: authority,
        newAccountPubkey: mintId,
        space: MINT_SIZE,
        lamports: await getMinimumBalanceForRentExemptMint(connection),
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(
        mintId,
        config?.decimals ?? 0,
        authority,
        authority
      ),
      createAssociatedTokenAccountInstruction(authority, ata, target, mintId),
      createMintToInstruction(mintId, ata, authority, config?.amount ?? 1)
    ),
    ata,
  ];
};

export const createMasterEdition = async (
  connection: Connection,
  wallet: Wallet,
  config?: { target?: PublicKey }
): Promise<[PublicKey, PublicKey]> => {
  const mintKeypair = Keypair.generate();
  const mintId = mintKeypair.publicKey;
  const target = config?.target ?? wallet.publicKey;
  const ata = getAssociatedTokenAddressSync(mintId, target, true);
  const tx = await createMasterEditionTx(
    connection,
    mintKeypair.publicKey,
    wallet.publicKey,
    config
  );
  await executeTransaction(connection, tx, wallet, { signers: [mintKeypair] });
  return [ata, mintId];
};

export const createMasterEditionTx = async (
  connection: Connection,
  mintId: PublicKey,
  authority: PublicKey,
  config?: { target?: PublicKey }
) => {
  const target = config?.target ?? authority;
  const ata = getAssociatedTokenAddressSync(mintId, target);
  const metadataId = findMintMetadataId(mintId);
  const editionId = findMintEditionId(mintId);

  return new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: authority,
      newAccountPubkey: mintId,
      space: MINT_SIZE,
      lamports: await getMinimumBalanceForRentExemptMint(connection),
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(mintId, 0, authority, authority),
    createAssociatedTokenAccountInstruction(authority, ata, target, mintId),
    createMintToInstruction(mintId, ata, authority, 1),
    createCreateMetadataAccountV2Instruction(
      {
        metadata: metadataId,
        mint: mintId,
        updateAuthority: authority,
        mintAuthority: authority,
        payer: authority,
      },
      {
        createMetadataAccountArgsV2: {
          data: {
            name: `name-${Math.random()}`,
            symbol: "SYMB",
            uri: `uri-${Math.random()}`,
            sellerFeeBasisPoints: 0,
            creators: [{ address: authority, share: 100, verified: true }],
            collection: null,
            uses: null,
          },
          isMutable: true,
        },
      }
    ),
    createCreateMasterEditionV3Instruction(
      {
        edition: editionId,
        mint: mintId,
        updateAuthority: authority,
        mintAuthority: authority,
        metadata: metadataId,
        payer: authority,
      },
      { createMasterEditionArgs: { maxSupply: 0 } }
    )
  );
};

export async function executeTransaction(
  connection: Connection,
  tx: Transaction,
  wallet: Wallet,
  config?: { signers?: Signer[]; silent?: boolean }
): Promise<string> {
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.feePayer = wallet.publicKey;
  tx = await wallet.signTransaction(tx);
  if (config?.signers) {
    tx.partialSign(...(config?.signers ?? []));
  }
  try {
    const txid = await sendAndConfirmRawTransaction(connection, tx.serialize());
    return txid;
  } catch (e) {
    if (!config?.silent) {
      handleError(e);
    }
    throw e;
  }
}

export const handleError = (e: any) => {
  const message = (e as SendTransactionError).message ?? "";
  const logs = (e as SendTransactionError).logs;
  if (logs) {
    console.log(logs, message);
  } else {
    console.log(e, message);
  }
};

export const createProgrammableAsset = async (
  connection: Connection,
  wallet: Wallet
): Promise<[PublicKey, PublicKey, PublicKey]> => {
  const mintKeypair = Keypair.generate();
  const mintId = mintKeypair.publicKey;
  const [tx, ata, rulesetId] = createProgrammableAssetTx(
    mintKeypair.publicKey,
    wallet.publicKey
  );
  await executeTransaction(connection, tx, wallet, { signers: [mintKeypair] });
  return [ata, mintId, rulesetId];
};

export const createProgrammableAssetTx = (
  mintId: PublicKey,
  authority: PublicKey
): [Transaction, PublicKey, PublicKey] => {
  const metadataId = findMintMetadataId(mintId);
  const masterEditionId = findMintEditionId(mintId);
  const ataId = getAssociatedTokenAddressSync(mintId, authority);
  const rulesetName = `rs-${Math.floor(Date.now() / 1000)}`;
  const rulesetId = findRuleSetId(authority, rulesetName);
  const rulesetIx = createCreateOrUpdateInstruction(
    {
      payer: authority,
      ruleSetPda: rulesetId,
    },
    {
      createOrUpdateArgs: {
        __kind: "V1",
        serializedRuleSet: encode([
          1,
          authority.toBuffer().reduce((acc, i) => {
            acc.push(i);
            return acc;
          }, [] as number[]),
          rulesetName,
          {
            "Transfer:WalletToWallet": "Pass",
            "Transfer:Owner": "Pass",
            "Transfer:Delegate": "Pass",
            "Transfer:TransferDelegate": "Pass",
            "Delegate:Staking": "Pass",
          },
        ]),
      },
    }
  );
  const createIx = createCreateInstruction(
    {
      metadata: metadataId,
      masterEdition: masterEditionId,
      mint: mintId,
      authority: authority,
      payer: authority,
      splTokenProgram: TOKEN_PROGRAM_ID,
      sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      updateAuthority: authority,
    },
    {
      createArgs: {
        __kind: "V1",
        assetData: {
          name: `NFT - ${Math.floor(Date.now() / 1000)}`,
          symbol: "PNF",
          uri: "uri",
          sellerFeeBasisPoints: 0,
          creators: [
            {
              address: authority,
              share: 100,
              verified: false,
            },
          ],
          primarySaleHappened: false,
          isMutable: true,
          tokenStandard: TokenStandard.ProgrammableNonFungible,
          collection: null,
          uses: null,
          collectionDetails: null,
          ruleSet: rulesetId,
        },
        decimals: 0,
        printSupply: { __kind: "Zero" },
      },
    }
  );
  const createIxWithSigner = {
    ...createIx,
    keys: createIx.keys.map((k) =>
      k.pubkey.toString() === mintId.toString() ? { ...k, isSigner: true } : k
    ),
  };
  const mintIx = createMintInstruction(
    {
      token: ataId,
      tokenOwner: authority,
      metadata: metadataId,
      masterEdition: masterEditionId,
      tokenRecord: findTokenRecordId(mintId, ataId),
      mint: mintId,
      payer: authority,
      authority: authority,
      sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      splAtaProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      splTokenProgram: TOKEN_PROGRAM_ID,
      authorizationRules: rulesetId,
      authorizationRulesProgram: TOKEN_AUTH_RULES_ID,
    },
    {
      mintArgs: {
        __kind: "V1",
        amount: 1,
        authorizationData: null,
      },
    }
  );
  return [
    new Transaction().add(rulesetIx, createIxWithSigner, mintIx),
    ataId,
    rulesetId,
  ];
};
