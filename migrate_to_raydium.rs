use crate::consts::*;
use crate::err::AmmError;
use crate::models::bound::BoundPool;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use raydium_cpmm_cpi::{
    cpi,
    program::RaydiumCpmm,
    states::{AmmConfig, OBSERVATION_SEED, POOL_LP_MINT_SEED, POOL_SEED, POOL_VAULT_SEED},
};

#[derive(Accounts)]
pub struct MigrateToRaydium<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    /// Raydium CPMM program (must be declared early to be referenced in other constraints)
    pub cp_swap_program: Program<'info, RaydiumCpmm>,

    #[account(
        mut,
        seeds = [
            BoundPool::POOL_PREFIX,
            meme_mint.key().as_ref(),
            quote_mint.key().as_ref()
        ],
        bump,
        constraint = pool.locked @ AmmError::PoolIsLocked,
    )]
    pub pool: Account<'info, BoundPool>,

    /// Meme token mint (must be smaller key than quote_mint for CPMM)
    #[account(mut,
        constraint = meme_mint.key() == pool.meme_reserve.mint @ AmmError::InvalidAccountInput,
    )]
    pub meme_mint: Account<'info, Mint>,

    /// Quote token mint (WSOL - must be larger key than meme_mint)

    #[account(mut)]
    pub quote_mint: Account<'info, Mint>,

    /// Pool's meme token vault
    #[account(
        mut,
        constraint = meme_vault.key() == pool.meme_reserve.vault @ AmmError::InvalidAccountInput,
    )]
    pub meme_vault: Account<'info, TokenAccount>,

    /// Pool's quote token vault
    #[account(mut)]
    pub quote_vault: Account<'info, TokenAccount>,

    /// CHECK: pool_signer PDA - seeds are verified by constraint
    #[account(seeds = [BoundPool::SIGNER_PDA_PREFIX, pool.key().as_ref()], bump)]
    pub pool_signer: AccountInfo<'info>,

    // === RAYDIUM CPMM ACCOUNTS ===
    /// Raydium AMM config account
    pub amm_config: Box<Account<'info, AmmConfig>>,

    /// CHECK: Raydium pool vault and lp mint authority, seeds are verified by Raydium program
    #[account(
        seeds = [
            raydium_cpmm_cpi::AUTH_SEED.as_bytes(),
        ],
        seeds::program = cp_swap_program.key(),
        bump,
    )]
    pub raydium_authority: UncheckedAccount<'info>,

    /// CHECK: Raydium pool state account to be created, seeds are verified by Raydium program
    #[account(
        mut,
        seeds = [
            POOL_SEED.as_bytes(),
            amm_config.key().as_ref(),
            meme_mint.key().as_ref(),  // token_0 (smaller key)
            quote_mint.key().as_ref(), // token_1 (larger key)
        ],
        seeds::program = cp_swap_program.key(),
        bump,
    )]
    pub raydium_pool_state: UncheckedAccount<'info>,

    /// CHECK: Raydium LP mint account to be created, seeds are verified by Raydium program
    #[account(
        mut,
        seeds = [
            POOL_LP_MINT_SEED.as_bytes(),
            raydium_pool_state.key().as_ref(),
        ],
        seeds::program = cp_swap_program.key(),
        bump,
    )]
    pub raydium_lp_mint: UncheckedAccount<'info>,

    /// Creator's meme token account (for initial liquidity)
    #[account(
        mut,
        token::mint = meme_mint,
        token::authority = signer,
    )]
    pub creator_meme_account: Account<'info, TokenAccount>,

    /// Creator's quote token account (for initial liquidity)
    #[account(
        mut,
        token::mint = quote_mint,
        token::authority = signer,
    )]
    pub creator_quote_account: Account<'info, TokenAccount>,

    /// CHECK: Creator's LP token account to receive LP tokens, will be created by Raydium
    #[account(mut)]
    pub creator_lp_token: UncheckedAccount<'info>,

    /// CHECK: Raydium token_0 vault to be created, seeds are verified by Raydium program
    #[account(
        mut,
        seeds = [
            POOL_VAULT_SEED.as_bytes(),
            raydium_pool_state.key().as_ref(),
            meme_mint.key().as_ref()
        ],
        seeds::program = cp_swap_program.key(),
        bump,
    )]
    pub token_0_vault: UncheckedAccount<'info>,

    /// CHECK: Raydium token_1 vault to be created, seeds are verified by Raydium program
    #[account(
        mut,
        seeds = [
            POOL_VAULT_SEED.as_bytes(),
            raydium_pool_state.key().as_ref(),
            quote_mint.key().as_ref()
        ],
        seeds::program = cp_swap_program.key(),
        bump,
    )]
    pub token_1_vault: UncheckedAccount<'info>,

    /// Pool creation fee account
    #[account(
        mut,
        address = raydium_cpmm_cpi::create_pool_fee_reveiver::id(),
    )]
    pub create_pool_fee: Account<'info, TokenAccount>,

    /// CHECK: Oracle observation account to be created, seeds are verified by Raydium program
    #[account(
        mut,
        seeds = [
            OBSERVATION_SEED.as_bytes(),
            raydium_pool_state.key().as_ref(),
        ],
        seeds::program = cp_swap_program.key(),
        bump,
    )]
    pub observation_state: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handle(ctx: Context<MigrateToRaydium>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;

    // 3. Calculate liquidity amounts for Raydium pool
    let (meme_amount, quote_amount) = calculate_migration_amounts(pool)?;

    // 4. Prepare authority seeds for token transfers
    let pool_key = pool.key();
    let auth_seeds = &[
        BoundPool::SIGNER_PDA_PREFIX,
        pool_key.as_ref(),
        &[ctx.bumps.pool_signer],
    ];
    let signer_seeds = &[&auth_seeds[..]];

    // 5. Transfer tokens from bonding curve to creator accounts
    // Transfer meme tokens
    let transfer_meme_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.meme_vault.to_account_info(),
            to: ctx.accounts.creator_meme_account.to_account_info(),
            authority: ctx.accounts.pool_signer.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_meme_ctx, meme_amount)?;

    // Transfer quote tokens
    let transfer_quote_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.quote_vault.to_account_info(),
            to: ctx.accounts.creator_quote_account.to_account_info(),
            authority: ctx.accounts.pool_signer.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_quote_ctx, quote_amount)?;

    // 6. Calculate open time (can trade immediately)
    let clock = Clock::get()?;
    let open_time = clock.unix_timestamp as u64;

    // 7. Initialize Raydium CPMM pool via CPI
    let cpi_accounts = cpi::accounts::Initialize {
        creator: ctx.accounts.signer.to_account_info(),
        amm_config: ctx.accounts.amm_config.to_account_info(),
        authority: ctx.accounts.raydium_authority.to_account_info(),
        pool_state: ctx.accounts.raydium_pool_state.to_account_info(),
        token_0_mint: ctx.accounts.meme_mint.to_account_info(), // smaller key
        token_1_mint: ctx.accounts.quote_mint.to_account_info(), // larger key
        lp_mint: ctx.accounts.raydium_lp_mint.to_account_info(),
        creator_token_0: ctx.accounts.creator_meme_account.to_account_info(),
        creator_token_1: ctx.accounts.creator_quote_account.to_account_info(),
        creator_lp_token: ctx.accounts.creator_lp_token.to_account_info(),
        token_0_vault: ctx.accounts.token_0_vault.to_account_info(),
        token_1_vault: ctx.accounts.token_1_vault.to_account_info(),
        create_pool_fee: ctx.accounts.create_pool_fee.to_account_info(),
        observation_state: ctx.accounts.observation_state.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        token_0_program: ctx.accounts.token_program.to_account_info(),
        token_1_program: ctx.accounts.token_program.to_account_info(),
        associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
        rent: ctx.accounts.rent.to_account_info(),
    };

    let cpi_context = CpiContext::new(ctx.accounts.cp_swap_program.to_account_info(), cpi_accounts);

    // Call Raydium's initialize function
    cpi::initialize(cpi_context, meme_amount, quote_amount, open_time)?;

    // 8. Update pool state
    pool.meme_reserve.tokens = ctx.accounts.meme_vault.amount - meme_amount;
    pool.quote_reserve.tokens = ctx.accounts.quote_vault.amount - quote_amount;
    pool.pool_migration = true;
    pool.migration_pool_key = ctx.accounts.raydium_pool_state.key();

    Ok(())
}

fn calculate_migration_amounts(pool: &BoundPool) -> Result<(u64, u64)> {
    // Use most of the remaining liquidity for the Raydium pool
    // Reserve 5% for potential continued bonding curve trading
    let meme_amount = pool.meme_reserve.tokens;
    let quote_amount = pool.quote_reserve.tokens;

    Ok((meme_amount, quote_amount))
}
