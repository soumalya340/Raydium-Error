import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Launchpad } from "../target/types/launchpad";
import { PublicKey } from "@solana/web3.js";
import {
  setAuthority,
  AuthorityType,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { assert } from "chai";
import { createMemeMint } from "./utils";
import { wrapSol, NATIVE_MINT, LAMPORTS_PER_SOL } from "./wsol";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  mplTokenMetadata,
  findMetadataPda,
  fetchAllMetadata,
  fetchMetadata,
} from "@metaplex-foundation/mpl-token-metadata";
import { publicKey } from "@metaplex-foundation/umi";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

describe("Launchpad", () => {
  let memeMint: PublicKey;
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const user = provider.wallet;
  const program = anchor.workspace.Launchpad as Program<Launchpad>;

  before(async () => {
    memeMint = await createMemeMint();
  });
  it("should create a target config and new pool", async () => {
    // Step 1: Set up the sender
    const sender = user;
    const payer = (sender as any).payer;

    const connection = provider.connection;

    try {
      const targetAmount = new BN(2 * LAMPORTS_PER_SOL); // 2 SOL in lamports as BN

      await program.methods
        .initTargetConfig(targetAmount)
        .accounts({
          tokenMint: NATIVE_MINT, // ✅ Quote token (WSOL)
          pairTokenMint: memeMint, // ✅ Meme token
        })
        .rpc();
    } catch (error) {
      console.error("Error creating target config:", error);
      throw error;
    }

    const [targetConfigPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("config"), // TargetConfig::CONFIG_PREFIX
        NATIVE_MINT.toBuffer(), // token_mint
        memeMint.toBuffer(), // pair_token_mint
      ],
      program.programId
    );
    console.log("Target config PDA:", targetConfigPda.toBase58());

    // Step 6: Derive PDAs (these are automatic!)
    const [poolPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("bound_pool"), // From IDL seeds
        memeMint.toBuffer(),
        NATIVE_MINT.toBuffer(),
      ],
      program.programId
    );
    console.log("Pool PDA:", poolPda.toBase58());

    const [poolSigner] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("signer"), // From IDL seeds
        poolPda.toBuffer(),
      ],
      program.programId
    );

    console.log("Pool signer Address:", poolSigner.toBase58());

    // Create quote vault token account(owned by pool signer PDA)
    const quoteVault = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      NATIVE_MINT,
      poolSigner,
      true
    );
    console.log("Quote vault:", quoteVault.address.toBase58());

    // Create Associated Token Account for meme tokens (owned by pool signer)
    const memeVault = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      memeMint,
      poolSigner,
      true
    );
    console.log("meme vault", memeVault.address.toBase58());

    console.log("Setting authority of meme mint to pool signer...");
    try {
      // Change the mint authority from payer to pool signer
      const tx = await setAuthority(
        connection,
        payer,
        memeMint, // the mint account, not the vault
        payer, // current mint authority
        AuthorityType.MintTokens,
        poolSigner // new mint authority
      );
    } catch (error) {
      console.error("Error setting authority of meme mint:", error);
      throw error;
    }

    // CREATE FEE FEE QUOTE VAULT

    const BP_FEE_KEY_PUBKEY = new PublicKey(
      "CvBMs2LEp8KbfCvPNMawR5cFyQ1k9ac7xrtCoxu1Y2gH"
    );

    // Create Associated Token Account for fee vault (owned by fee authority)
    const feeQuoteVault = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      NATIVE_MINT,
      BP_FEE_KEY_PUBKEY
    );
    console.log("Fee quote vault:", feeQuoteVault.address.toBase58());

    // CALL INITIALIZE_POOL
    try {
      const tx = await program.methods
        .newPool()
        .accounts({
          memeMint: memeMint,
          quoteVault: quoteVault.address,
          quoteMint: NATIVE_MINT,
          feeQuoteVault: feeQuoteVault.address,
          memeVault: memeVault.address,
          targetConfig: targetConfigPda,
        })
        .rpc();
    } catch (error) {
      console.error("Error initializing pool:", error);
      throw error;
    }

    const poolAccount = await program.account.boundPool.fetch(poolPda);
    assert.equal(poolAccount.memeReserve.mint.toBase58(), memeMint.toBase58());
    assert.equal(
      poolAccount.quoteReserve.mint.toBase58(),
      NATIVE_MINT.toBase58()
    );
    assert.equal(
      poolAccount.feeVaultQuote.toBase58(),
      feeQuoteVault.address.toBase58()
    );
    assert.equal(
      poolAccount.memeReserve.vault.toBase58(),
      memeVault.address.toBase58()
    );
  });
  // it("should create metadata", async () => {
  //   // Import the correct metadata program ID
  //   const METADATA_PROGRAM_ID = new PublicKey(
  //     "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
  //   );

  //   const [poolPda] = PublicKey.findProgramAddressSync(
  //     [Buffer.from("bound_pool"), memeMint.toBuffer(), NATIVE_MINT.toBuffer()],
  //     program.programId
  //   );
  //   const [poolSigner] = PublicKey.findProgramAddressSync(
  //     [Buffer.from("signer"), poolPda.toBuffer()],
  //     program.programId
  //   );
  //   const [memeMplMetadata] = PublicKey.findProgramAddressSync(
  //     [
  //       Buffer.from("metadata"),
  //       METADATA_PROGRAM_ID.toBuffer(),
  //       memeMint.toBuffer(),
  //     ],
  //     METADATA_PROGRAM_ID
  //   );

  //   try {
  //     const tx = await program.methods
  //       .createMetadata("meme", "MEME", "https://meme.com")
  //       .accounts({
  //         memeMint: memeMint,
  //         pool: poolPda,
  //         memeMplMetadata: memeMplMetadata,
  //       })
  //       .accountsPartial({
  //         poolSigner: poolSigner,
  //         metadataProgram: METADATA_PROGRAM_ID,
  //       })
  //       .rpc();

  //     // const umi = createUmi("http://127.0.0.1:8899").use(mplTokenMetadata());
  //     // const assetPda = findMetadataPda(umi, {
  //     //   mint: publicKey(memeMint.toBase58()),
  //     // });
  //     // const asset = await fetchMetadata(umi, assetPda);

  //     // console.log("Asset:", asset);
  //   } catch (error) {
  //     console.error("Error creating metadata:", error);
  //     throw error;
  //   }
  // });
  // it("Should Swap Sol for Meme", async () => {
  //   const sender = user;
  //   const payer = (sender as any).payer;
  //   const connection = provider.connection;

  //   // Step 2: Derive target config PDA (should already exist from previous test)
  //   const [targetConfigPda] = PublicKey.findProgramAddressSync(
  //     [
  //       Buffer.from("config"), // TargetConfig::CONFIG_PREFIX
  //       NATIVE_MINT.toBuffer(), // token_mint (quote)
  //       memeMint.toBuffer(), // pair_token_mint (meme)
  //     ],
  //     program.programId
  //   );

  //   // Step 3: Derive pool PDA (should already exist from previous test)
  //   const [poolPda] = PublicKey.findProgramAddressSync(
  //     [
  //       Buffer.from("bound_pool"), // BoundPool prefix
  //       memeMint.toBuffer(), // meme mint
  //       NATIVE_MINT.toBuffer(), // quote mint (WSOL)
  //     ],
  //     program.programId
  //   );

  //   console.log("Pool PDA:", poolPda.toBase58());

  //   // Step 4: Derive pool signer PDA
  //   const [poolSigner] = PublicKey.findProgramAddressSync(
  //     [
  //       Buffer.from("signer"), // Pool signer prefix
  //       poolPda.toBuffer(),
  //     ],
  //     program.programId
  //   );

  //   // Step 5: Get existing quote vault (WSOL vault owned by pool signer)
  //   const quoteVault = await getOrCreateAssociatedTokenAccount(
  //     connection,
  //     payer,
  //     NATIVE_MINT,
  //     poolSigner,
  //     true // allowOwnerOffCurve for PDA
  //   );

  //   // Step 6: Get existing meme vault (meme token vault owned by pool signer)
  //   const memeVault = await getOrCreateAssociatedTokenAccount(
  //     connection,
  //     payer,
  //     memeMint,
  //     poolSigner,
  //     true // allowOwnerOffCurve for PDA
  //   );

  //   // Step 7: Verify pool account exists and get its state
  //   try {
  //     const poolAccount = await program.account.boundPool.fetch(poolPda);
  //     console.log(
  //       "Meme reserve tokens:",
  //       poolAccount.memeReserve.tokens.toString()
  //     );
  //     console.log(
  //       "Quote reserve tokens:",
  //       poolAccount.quoteReserve.tokens.toString()
  //     );
  //     console.log("Pool locked:", poolAccount.locked);

  //     // Verify the vaults match what we expect
  //     assert.equal(
  //       poolAccount.memeReserve.vault.toBase58(),
  //       memeVault.address.toBase58(),
  //       "Meme vault mismatch"
  //     );
  //     assert.equal(
  //       poolAccount.quoteReserve.vault.toBase58(),
  //       quoteVault.address.toBase58(),
  //       "Quote vault mismatch"
  //     );
  //   } catch (error) {
  //     console.error("Pool account not found or invalid:", error);
  //     throw error;
  //   }

  //   // Step 8: Verify target config exists
  //   try {
  //     await program.account.targetConfig.fetch(targetConfigPda);
  //   } catch (error) {
  //     console.error("Target config not found:", error);
  //     throw error;
  //   }

  //   // CORE FUNCTIONALITY test for swap_y
  //   // TODO: Add swap logic here
  //   // 0. Wrap SOL
  //   const userSolTokenAccount = await wrapSol(connection, payer, 1);
  //   const userWsolBalanceBefore = await getAccount(
  //     connection,
  //     userSolTokenAccount
  //   );

  //   if (userWsolBalanceBefore.amount === BigInt(0)) {
  //     const userSolTokenAccount = await wrapSol(connection, payer, 1);
  //   }
  //   // Get WSOL balance
  //   const userWsolBalance = await getAccount(connection, userSolTokenAccount);

  //   // 1. Get the user's meme token account (user_meme)
  //   const userMemeTokenAccount = await getOrCreateAssociatedTokenAccount(
  //     connection,
  //     payer,
  //     memeMint,
  //     payer.publicKey
  //   );
  //   // 2. Get the user's quote token account (user_quote)
  //   const userQuoteTokenAccount = await getOrCreateAssociatedTokenAccount(
  //     connection,
  //     payer,
  //     NATIVE_MINT,
  //     payer.publicKey
  //   );

  //   // Amount to Swap
  //   let coinInAmount = new BN(LAMPORTS_PER_SOL);
  //   let coinXMinValue = new BN(0);

  //   const tx = await program.methods
  //     .getSwapYAmt(coinInAmount, coinXMinValue)
  //     .accounts({
  //       pool: poolPda,
  //       quoteVault: quoteVault.address,
  //     })
  //     .rpc();

  //   const swapTx = await program.methods
  //     .swapY(coinInAmount, coinXMinValue)
  //     .accounts({
  //       pool: poolPda,
  //       quoteVault: quoteVault.address,
  //       memeVault: memeVault.address,
  //       userMeme: userMemeTokenAccount.address,
  //       userSol: userQuoteTokenAccount.address,
  //     })
  //     .rpc();

  //   // ===== POST-SWAP VERIFICATION =====
  //   console.log("\n🔍 Starting post-swap verification...");

  //   // Fetch updated pool account
  //   const updatedPoolAccount = await program.account.boundPool.fetch(poolPda);

  //   // Get updated user token balances
  //   const updatedUserWsolBalance = await getAccount(
  //     connection,
  //     userQuoteTokenAccount.address
  //   );
  //   const updatedUserMemeBalance = await getAccount(
  //     connection,
  //     userMemeTokenAccount.address
  //   );

  //   // Get updated vault balances
  //   const updatedQuoteVaultBalance = await getAccount(
  //     connection,
  //     quoteVault.address
  //   );
  //   const updatedMemeVaultBalance = await getAccount(
  //     connection,
  //     memeVault.address
  //   );

  //   // Verify user received meme tokens
  //   assert(
  //     updatedUserMemeBalance.amount > BigInt(0),
  //     "User should have received meme tokens"
  //   );

  //   // Verify user WSOL decreased
  //   assert(
  //     updatedUserWsolBalance.amount < userWsolBalance.amount,
  //     "User WSOL balance should have decreased"
  //   );

  //   // 2. **Pool reserve updates verification**
  //   console.log("\n Checking pool reserve updates...");

  //   const initialMemeReserve = BigInt("690000000000000"); // 690B initial tokens
  //   const initialQuoteReserve = BigInt(0); // Started with 0 SOL

  //   console.log(" Pool Reserve Changes:");
  //   console.log(`  Quote reserve before: ${initialQuoteReserve.toString()}`);
  //   console.log(
  //     `  Quote reserve after: ${updatedPoolAccount.quoteReserve.tokens.toString()}`
  //   );
  //   console.log(`  Meme reserve before: ${initialMemeReserve.toString()}`);
  //   console.log(
  //     `  Meme reserve after: ${updatedPoolAccount.memeReserve.tokens.toString()}`
  //   );

  //   // Verify quote reserve increased (received SOL)
  //   assert(
  //     BigInt(updatedPoolAccount.quoteReserve.tokens.toString()) >
  //       initialQuoteReserve,
  //     "Pool quote reserve should have increased"
  //   );

  //   // Verify meme reserve decreased (sent meme tokens)
  //   assert(
  //     BigInt(updatedPoolAccount.memeReserve.tokens.toString()) <
  //       initialMemeReserve,
  //     "Pool meme reserve should have decreased"
  //   );

  //   // 3. **Fee calculation and collection tests**
  //   console.log("\n Checking fee calculations...");

  //   // Get fee vault balance
  //   const BP_FEE_KEY_PUBKEY = new PublicKey(
  //     "CvBMs2LEp8KbfCvPNMawR5cFyQ1k9ac7xrtCoxu1Y2gH"
  //   );
  //   const feeQuoteVault = await getOrCreateAssociatedTokenAccount(
  //     connection,
  //     payer,
  //     NATIVE_MINT,
  //     BP_FEE_KEY_PUBKEY
  //   );
  //   const feeVaultBalance = await getAccount(connection, feeQuoteVault.address);

  //   console.log(" Fee Collection Verification:");
  //   console.log(
  //     `  Pool admin fees quote: ${updatedPoolAccount.adminFeesQuote.toString()}`
  //   );
  //   console.log(
  //     `  Pool admin fees meme: ${updatedPoolAccount.adminFeesMeme.toString()}`
  //   );
  //   console.log(`  Fee vault balance: ${feeVaultBalance.amount.toString()}`);

  //   // Calculate expected fee (1% of input SOL)
  //   const inputAmount = BigInt(LAMPORTS_PER_SOL.toString());
  //   const expectedFee = inputAmount / BigInt(100); // 1% fee

  //   console.log(`  Input amount: ${inputAmount.toString()}`);
  //   console.log(`  Expected fee (1%): ${expectedFee.toString()}`);
  //   console.log(
  //     `  Actual admin fee: ${updatedPoolAccount.adminFeesQuote.toString()}`
  //   );

  //   // Verify admin fees are collected correctly
  //   assert(
  //     BigInt(updatedPoolAccount.adminFeesQuote.toString()) > BigInt(0),
  //     "Pool should have collected admin fees"
  //   );

  //   // Verify fee percentage is approximately correct (allowing for bonding curve calculations)
  //   const feePercentage =
  //     (BigInt(updatedPoolAccount.adminFeesQuote.toString()) * BigInt(100)) /
  //     inputAmount;
  //   console.log(`  Actual fee percentage: ${feePercentage.toString()}%`);

  //   assert(
  //     feePercentage >= BigInt(0) && feePercentage <= BigInt(2), // Allow 0-2% range for bonding curve math
  //     `Fee percentage should be reasonable, got ${feePercentage}%`
  //   );

  //   // 4. **Vault balance consistency checks**
  //   console.log("\n Checking vault balance consistency...");

  //   console.log("Vault Balance Verification:");
  //   console.log(
  //     `  Quote vault balance: ${updatedQuoteVaultBalance.amount.toString()}`
  //   );
  //   console.log(
  //     `  Pool quote reserve: ${updatedPoolAccount.quoteReserve.tokens.toString()}`
  //   );
  //   console.log(
  //     `  Meme vault balance: ${updatedMemeVaultBalance.amount.toString()}`
  //   );
  //   console.log(
  //     `  Pool meme reserve: ${updatedPoolAccount.memeReserve.tokens.toString()}`
  //   );

  //   // Verify vault balances match pool reserves (minus fees)
  //   // Quote vault should equal pool reserve + admin fees
  //   const expectedQuoteVaultBalance =
  //     BigInt(updatedPoolAccount.quoteReserve.tokens.toString()) +
  //     BigInt(updatedPoolAccount.adminFeesQuote.toString());

  //   console.log(
  //     `  Expected quote vault balance: ${expectedQuoteVaultBalance.toString()}`
  //   );

  //   // Allow small difference due to potential rounding
  //   const quoteVaultDiff =
  //     updatedQuoteVaultBalance.amount - expectedQuoteVaultBalance;
  //   assert(
  //     quoteVaultDiff >= BigInt(-1000) && quoteVaultDiff <= BigInt(1000),
  //     `Quote vault balance mismatch: ${quoteVaultDiff.toString()}`
  //   );

  //   // 5. **Pool lock status verification**
  //   console.log("\n Checking pool lock status...");

  //   console.log("Pool Status Verification:");
  //   console.log(`  Pool locked: ${updatedPoolAccount.locked}`);
  //   console.log(
  //     `  Meme reserve remaining: ${updatedPoolAccount.memeReserve.tokens.toString()}`
  //   );

  //   // Pool should not be locked yet (still has meme tokens)
  //   assert(
  //     !updatedPoolAccount.locked,
  //     "Pool should not be locked after single swap"
  //   );

  //   assert(
  //     BigInt(updatedPoolAccount.memeReserve.tokens.toString()) > BigInt(0),
  //     "Pool should still have meme tokens remaining"
  //   );

  //   // 6. **Math verification - conservation of tokens**
  //   console.log("\n Checking token conservation...");

  //   const solSpent = userWsolBalance.amount - updatedUserWsolBalance.amount;
  //   const memeReceived = updatedUserMemeBalance.amount;
  //   const poolQuoteIncrease = BigInt(
  //     updatedPoolAccount.quoteReserve.tokens.toString()
  //   );
  //   const poolMemeDecrease =
  //     initialMemeReserve -
  //     BigInt(updatedPoolAccount.memeReserve.tokens.toString());
  //   const adminFeesQuote = BigInt(updatedPoolAccount.adminFeesQuote.toString());
  //   const adminFeesMeme = BigInt(updatedPoolAccount.adminFeesMeme.toString());

  //   console.log("Token Conservation Check:");
  //   console.log(`  SOL spent by user: ${solSpent.toString()}`);
  //   console.log(`  SOL added to pool: ${poolQuoteIncrease.toString()}`);
  //   console.log(`  SOL admin fees: ${adminFeesQuote.toString()}`);
  //   console.log(
  //     `  Total SOL accounted: ${(
  //       poolQuoteIncrease + adminFeesQuote
  //     ).toString()}`
  //   );
  //   console.log(`  ----`);
  //   console.log(`  MEME received by user: ${memeReceived.toString()}`);
  //   console.log(`  MEME removed from pool: ${poolMemeDecrease.toString()}`);
  //   console.log(`  MEME admin fees: ${adminFeesMeme.toString()}`);
  //   console.log(
  //     `  Total MEME accounted: ${(memeReceived + adminFeesMeme).toString()}`
  //   );

  //   // SOL conservation: user spent = pool increase + fees
  //   assert(
  //     solSpent === poolQuoteIncrease + adminFeesQuote,
  //     `SOL not conserved: spent ${solSpent}, accounted ${
  //       poolQuoteIncrease + adminFeesQuote
  //     }`
  //   );

  //   // MEME conservation: pool decrease = user received + fees
  //   assert(
  //     poolMemeDecrease === memeReceived + adminFeesMeme,
  //     `MEME not conserved: decreased ${poolMemeDecrease}, accounted ${
  //       memeReceived + adminFeesMeme
  //     }`
  //   );
  // });
  // it("Should Swap Meme for Sol", async () => {
  //   console.log("Setting up meme to sol swap test...");
  //   const sender = user;
  //   const payer = (sender as any).payer;
  //   const connection = provider.connection;

  //   const [targetConfigPda] = PublicKey.findProgramAddressSync(
  //     [
  //       Buffer.from("config"), // TargetConfig::CONFIG_PREFIX
  //       NATIVE_MINT.toBuffer(), // token_mint (quote)
  //       memeMint.toBuffer(), // pair_token_mint (meme)
  //     ],
  //     program.programId
  //   );

  //   const [poolPda] = PublicKey.findProgramAddressSync(
  //     [
  //       Buffer.from("bound_pool"), // BoundPool prefix
  //       memeMint.toBuffer(), // meme mint
  //       NATIVE_MINT.toBuffer(), // quote mint (WSOL)
  //     ],
  //     program.programId
  //   );

  //   const [poolSigner] = PublicKey.findProgramAddressSync(
  //     [
  //       Buffer.from("signer"), // Pool signer prefix
  //       poolPda.toBuffer(),
  //     ],
  //     program.programId
  //   );

  //   const quoteVault = await getOrCreateAssociatedTokenAccount(
  //     connection,
  //     payer,
  //     NATIVE_MINT,
  //     poolSigner,
  //     true // allowOwnerOffCurve for PDA
  //   );

  //   const memeVault = await getOrCreateAssociatedTokenAccount(
  //     connection,
  //     payer,
  //     memeMint,
  //     poolSigner,
  //     true // allowOwnerOffCurve for PDA
  //   );

  //   try {
  //     await program.account.targetConfig.fetch(targetConfigPda);
  //   } catch (error) {
  //     console.error("Target config not found:", error);
  //     throw error;
  //   }

  //   // 1. Get the user's meme token account (user_meme)
  //   const userMemeTokenAccount = await getOrCreateAssociatedTokenAccount(
  //     connection,
  //     payer,
  //     memeMint,
  //     payer.publicKey
  //   );

  //   // 2. Get the user's quote token account (user_quote)
  //   const userQuoteTokenAccount = await getOrCreateAssociatedTokenAccount(
  //     connection,
  //     payer,
  //     NATIVE_MINT,
  //     payer.publicKey
  //   );

  //   // Amount to Swap
  //   const userMemeBalance = await getAccount(
  //     connection,
  //     userMemeTokenAccount.address
  //   );
  //   const coinInAmount = new BN(userMemeBalance.amount.toString());

  //   let coinXMinValue = new BN(0);

  //   const swapTx = await program.methods
  //     .swapX(coinInAmount, coinXMinValue)
  //     .accounts({
  //       pool: poolPda,
  //       quoteVault: quoteVault.address,
  //       memeVault: memeVault.address,
  //       userMeme: userMemeTokenAccount.address,
  //       userSol: userQuoteTokenAccount.address,
  //     })
  //     .rpc();

  //   console.log("Swap transaction hash:", swapTx);

  //   // ===== POST-SWAP VERIFICATION =====
  //   console.log("\n🔍 Starting post-swap verification...");

  //   // Get user WSOL balance before swap for comparison
  //   const userWsolBalanceBefore = await getAccount(
  //     connection,
  //     userQuoteTokenAccount.address
  //   );

  //   // Get updated user token balances after swap
  //   const updatedUserWsolBalance = await getAccount(
  //     connection,
  //     userQuoteTokenAccount.address
  //   );
  //   const updatedUserMemeBalance = await getAccount(
  //     connection,
  //     userMemeTokenAccount.address
  //   );

  //   console.log(
  //     "User WSOL before swap:",
  //     userWsolBalanceBefore.amount.toString()
  //   );
  //   console.log(
  //     "User WSOL after swap:",
  //     updatedUserWsolBalance.amount.toString()
  //   );
  //   console.log("User MEME before swap:", userMemeBalance.amount.toString());
  //   console.log(
  //     "User MEME after swap:",
  //     updatedUserMemeBalance.amount.toString()
  //   );

  //   // Note: These balances might be the same if the swap transaction failed
  //   // Let's check if the swap actually succeeded by looking at the transaction
  //   console.log(
  //     "Meme tokens swapped:",
  //     (userMemeBalance.amount - updatedUserMemeBalance.amount).toString()
  //   );
  //   console.log(
  //     "WSOL received:",
  //     (updatedUserWsolBalance.amount - userWsolBalanceBefore.amount).toString()
  //   );
  // });

  it("Should Raydium Migrate", async () => {
    const sender = user;
    const payer = (sender as any).payer;
    const connection = provider.connection;

    // Step 2: Derive target config PDA (should already exist from previous test)
    const [targetConfigPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("config"), // TargetConfig::CONFIG_PREFIX
        NATIVE_MINT.toBuffer(), // token_mint (quote)
        memeMint.toBuffer(), // pair_token_mint (meme)
      ],
      program.programId
    );
    console.log("Target config PDA in Migration:", targetConfigPda.toBase58());

    // Step 3: Derive pool PDA (should already exist from previous test)
    const [poolPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("bound_pool"), // BoundPool prefix
        memeMint.toBuffer(), // meme mint
        NATIVE_MINT.toBuffer(), // quote mint (WSOL)
      ],
      program.programId
    );
    console.log("Pool PDA in Migration:", poolPda.toBase58());
    // Step 4: Derive pool signer PDA
    const [poolSigner] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("signer"), // Pool signer prefix
        poolPda.toBuffer(),
      ],
      program.programId
    );
    console.log("Pool signer:", poolSigner.toBase58());
    // Step 5: Get existing quote vault (WSOL vault owned by pool signer)
    const quoteVault = await getAssociatedTokenAddress(
      NATIVE_MINT,
      poolSigner,
      true
    );
    console.log("Quote vault in Migration:", quoteVault.toBase58());
    // Step 6: Get existing meme vault (meme token vault owned by pool signer)
    const memeVault = await getAssociatedTokenAddress(
      memeMint,
      poolSigner,
      true // allowOwnerOffCurve for PDA
    );
    console.log("meme vault in Migration:", memeVault.toBase58());
    try {
      const accountInfo = await connection.getAccountInfo(memeVault);
      console.log("Account Found with info:", accountInfo);
    } catch (error) {
      console.log("Account not found");
    }

    console.log("Test1");
    // Step 7: Verify target config exists
    await program.account.targetConfig.fetch(targetConfigPda);

    console.log("Test2");
    // 1. Get the user's meme token account (user_meme)
    const userMemeTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      memeMint,
      payer.publicKey
    );
    console.log("Test2.1");
    // 2. Get the user's quote token account (user_quote)
    const userQuoteTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      NATIVE_MINT,
      payer.publicKey
    );

    console.log("Test3");
    const userSolTokenAccount = await wrapSol(connection, payer, 4);
    console.log("Token account wrapped sol: ", userSolTokenAccount);
    // Amount to Swap - Make sure to trigger migration by reaching threshold
    let coinInAmount = new BN(3 * LAMPORTS_PER_SOL);
    let coinXMinValue = new BN(0);
    console.log("Test4");
    await program.methods
      .swapY(coinInAmount, coinXMinValue)
      .accounts({
        pool: poolPda,
        quoteVault: quoteVault,
        memeVault: memeVault,
        userMeme: userMemeTokenAccount.address,
        userSol: userQuoteTokenAccount.address,
      })
      .rpc();

    // Check if the bonding curve is locked
    const poolAccount = await program.account.boundPool.fetch(poolPda);
    assert(poolAccount.locked, "Pool should be locked");

    // console.log("Setting up Raydium migrate test...");

    // === RAYDIUM CPI SETUP ===
    console.log(" Raydium Test1");
    // Raydium CPMM Program ID
    // CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
    const cpSwapProgram = new PublicKey(
      "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"
    );
    console.log(" Raydium Test2");
    // AMM Config (use Raydium's standard config)
    // AMM Config for 2%
    const ammConfig = new PublicKey(
      "D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2"
    );
    // Derive Raydium Authority PDA
    const [raydiumAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("amm_authority")],
      cpSwapProgram
    );
    // Derive Raydium Pool State PDA
    const [raydiumPoolState] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("pool"),
        ammConfig.toBuffer(),
        memeMint.toBuffer(), // token_0 (smaller key)
        NATIVE_MINT.toBuffer(), // token_1 (larger key)
      ],
      cpSwapProgram
    );
    // Derive Raydium LP Mint PDA
    const [raydiumLpMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_lp_mint"), raydiumPoolState.toBuffer()],
      cpSwapProgram
    );
    // Derive Raydium Token Vaults
    const [token0Vault] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("pool_vault"),
        raydiumPoolState.toBuffer(),
        memeMint.toBuffer(),
      ],
      cpSwapProgram
    );

    const [token1Vault] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("pool_vault"),
        raydiumPoolState.toBuffer(),
        NATIVE_MINT.toBuffer(),
      ],
      cpSwapProgram
    );

    // Derive Observation State PDA
    const [observationState] = PublicKey.findProgramAddressSync(
      [Buffer.from("observation"), raydiumPoolState.toBuffer()],
      cpSwapProgram
    );

    // Creator LP Token Account (ATA) - derive address only, Raydium will create it
    const [creatorLpToken] = PublicKey.findProgramAddressSync(
      [
        payer.publicKey.toBuffer(),
        TOKEN_PROGRAM_ID.toBuffer(),
        raydiumLpMint.toBuffer(),
      ],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    console.log(" Raydium Test9");
    // Create Pool Fee Account - this needs to be an initialized token account
    const createPoolFeeReceiver = new PublicKey(
      "DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8"
    );

    const createPoolFee = new PublicKey(
      "DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8"
    );

    try {
      console.log("Start");
      const migrateTx = await program.methods
        .migrateToRaydium()
        .accounts({
          memeMint: memeMint,
          quoteMint: NATIVE_MINT,
          memeVault: memeVault,
          quoteVault: quoteVault,
          ammConfig: ammConfig,
          creatorMemeAccount: userMemeTokenAccount.address,
          creatorQuoteAccount: userQuoteTokenAccount.address,
          creatorLpToken: creatorLpToken,
        })
        .accountsPartial({
          createPoolFee: createPoolFee,
        })
        .rpc();

      console.log("✅ Migration successful! Transaction hash:", migrateTx);

      // Verify migration
      const updatedPool = await program.account.boundPool.fetch(poolPda);
      console.log("Pool migration status:", updatedPool.poolMigration);
      console.log(
        "Migration pool key:",
        updatedPool.migrationPoolKey?.toBase58()
      );
    } catch (error) {
      console.error("❌ Migration failed:", error);
      console.log("Error details:", error.logs || error.message);
      throw error;
    }
  });
});
