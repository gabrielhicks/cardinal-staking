use crate::errors::ErrorCode;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

#[derive(Accounts)]
pub struct ResetStakeEntryBumpCtx<'info> {
    stake_entry: Box<Account<'info, StakeEntry>>,
    #[account(mut)]
    stake_pool: Box<Account<'info, StakePool>>,
    /// CHECK: This is not dangerous because we don't read or write from this account
    user: UncheckedAccount<'info>,

    original_mint: Box<Account<'info, Mint>>,
}

pub fn handler(ctx: Context<ResetStakeEntryBumpCtx>) -> Result<()> {
    let (pubkey, bump) = Pubkey::find_program_address(
        &[
            STAKE_ENTRY_PREFIX.as_bytes(),
            ctx.accounts.stake_pool.key().as_ref(),
            ctx.accounts.original_mint.key().as_ref(),
            get_stake_seed(ctx.accounts.original_mint.supply, ctx.accounts.user.key()).as_ref(),
        ],
        ctx.program_id,
    );
    ctx.accounts.stake_entry.bump = bump;
    if pubkey != ctx.accounts.stake_entry.key() {
        return Err(error!(ErrorCode::InvalidStakeEntry));
    }

    Ok(())
}
