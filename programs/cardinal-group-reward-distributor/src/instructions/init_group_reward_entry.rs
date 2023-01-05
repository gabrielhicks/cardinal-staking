use {
    crate::{errors::ErrorCode, state::*},
    anchor_lang::prelude::*,
    cardinal_reward_distributor::state::RewardEntry,
    cardinal_stake_pool::state::{GroupStakeEntry, StakeEntry},
    core::hash::Hash,
    mpl_token_metadata::{state::Metadata, utils::assert_derivation},
    std::collections::HashSet,
};

#[derive(Accounts)]
pub struct InitGroupRewardEntryCtx<'info> {
    #[account(
        init,
        payer = authority,
        space = GROUP_REWARD_ENTRY_SIZE,
        seeds = [GROUP_REWARD_ENTRY_SEED.as_bytes(), group_reward_distributor.key().as_ref(), group_entry.key().as_ref()],
        bump,
    )]
    group_reward_entry: Box<Account<'info, GroupRewardEntry>>,

    #[account(mut, has_one = authority, has_one = group_reward_distributor)]
    group_reward_counter: Box<Account<'info, GroupRewardCounter>>,

    #[account(mut, has_one = authority)]
    group_entry: Box<Account<'info, GroupStakeEntry>>,

    #[account(mut)]
    group_reward_distributor: Box<Account<'info, GroupRewardDistributor>>,

    #[account(mut)]
    authority: Signer<'info>,

    system_program: Program<'info, System>,
}

pub fn handler<'key, 'accounts, 'remaining, 'info>(ctx: Context<'key, 'accounts, 'remaining, 'info, InitGroupRewardEntryCtx>) -> Result<()> {
    let group_reward_counter = &mut ctx.accounts.group_reward_counter;
    let group_reward_distributor = &mut ctx.accounts.group_reward_distributor;
    let group_reward_entry = &mut ctx.accounts.group_reward_entry;
    let group_entry = &mut ctx.accounts.group_entry;

    let group_size = group_entry.stake_entries.len();

    if group_reward_distributor.min_group_size.is_some() && (group_size as u8) < group_reward_distributor.min_group_size.unwrap() {
        return Err(error!(ErrorCode::InvalidGroupSize));
    }

    if group_entry.group_stake_seconds < group_reward_distributor.min_stake_seconds {
        return Err(error!(ErrorCode::InvalidGroupSeconds));
    }

    if group_entry.group_cooldown_seconds < group_reward_distributor.min_cooldown_seconds {
        return Err(error!(ErrorCode::InvalidGroupSeconds));
    }

    let mut metadata_names = Vec::new();
    let mut metadata_symbols = Vec::new();
    let mut stake_pools = Vec::new();
    let mut total_multipliers = 0_u64;

    let remaining_accounts = &mut ctx.remaining_accounts.iter();
    for i in 0..group_size {
        let stake_entry = next_account_info(remaining_accounts)?;
        if stake_entry.data_is_empty() || group_entry.stake_entries[i] != stake_entry.key() {
            return Err(error!(ErrorCode::InvalidStakeEntry));
        }

        let stake_entry_id = stake_entry.key();

        let stake_entry_data = stake_entry.try_borrow_mut_data().expect("Failed to borrow data");
        let stake_entry = StakeEntry::deserialize(&mut stake_entry_data[8..].as_ref())?;
        if !group_reward_distributor.authorized_pools.contains(&stake_entry.pool) {
            return Err(error!(ErrorCode::InvalidPool));
        }

        let original_mint = next_account_info(remaining_accounts)?;
        if original_mint.data_is_empty() || original_mint.key() != stake_entry.original_mint.key() {
            return Err(error!(ErrorCode::InvalidOriginalMint));
        }

        let original_mint_metadata = next_account_info(remaining_accounts)?;
        if original_mint_metadata.data_is_empty() {
            return Err(error!(ErrorCode::InvalidMintMetadata));
        }

        assert_derivation(
            &mpl_token_metadata::id(),
            &original_mint_metadata.to_account_info(),
            &[mpl_token_metadata::state::PREFIX.as_bytes(), mpl_token_metadata::id().as_ref(), original_mint.key().as_ref()],
        )?;

        if original_mint_metadata.owner.key() != mpl_token_metadata::id() {
            return Err(error!(ErrorCode::InvalidMintMetadataOwner));
        }

        let original_mint_metadata_data = original_mint_metadata.try_borrow_mut_data().expect("Failed to borrow data");
        let original_mint_metadata = Metadata::deserialize(&mut original_mint_metadata_data.as_ref()).expect("Failed to deserialize metadata");
        if original_mint_metadata.mint != original_mint.key() {
            return Err(error!(ErrorCode::InvalidMintMetadata));
        }

        let reward_entry = next_account_info(remaining_accounts)?;
        if reward_entry.data_is_empty() {
            return Err(error!(ErrorCode::InvalidRewardEntry));
        }
        let reward_entry_data = reward_entry.try_borrow_mut_data().expect("Failed to borrow data");
        let reward_entry = RewardEntry::deserialize(&mut reward_entry_data[8..].as_ref())?;
        if stake_entry_id != reward_entry.stake_entry {
            return Err(error!(ErrorCode::InvalidRewardEntry));
        }

        metadata_names.push(original_mint_metadata.data.name);
        metadata_symbols.push(original_mint_metadata.data.symbol);
        stake_pools.push(stake_entry.pool);
        total_multipliers = total_multipliers.checked_add(reward_entry.multiplier).expect("Add error");
    }

    match group_reward_distributor.metadata_kind {
        k if k == GroupRewardDistributorMetadataKind::UniqueNames => {
            if !has_unique_elements(metadata_names) {
                return Err(error!(ErrorCode::InvalidStakeEntry));
            }
        }
        k if k == GroupRewardDistributorMetadataKind::UniqueSymbols => {
            if !has_unique_elements(metadata_symbols) {
                return Err(error!(ErrorCode::InvalidStakeEntry));
            }
        }
        _ => {}
    }

    match group_reward_distributor.pool_kind {
        k if k == GroupRewardDistributorPoolKind::AllFromSinglePool => {
            if !is_all_same(stake_pools) {
                return Err(error!(ErrorCode::InvalidStakeEntry));
            }
        }
        k if k == GroupRewardDistributorPoolKind::EachFromSeparatePool => {
            if !has_unique_elements(stake_pools) {
                return Err(error!(ErrorCode::InvalidStakeEntry));
            }
        }
        _ => {}
    }

    group_reward_entry.bump = *ctx.bumps.get("group_reward_entry").unwrap();
    group_reward_entry.group_reward_distributor = group_reward_distributor.key();
    group_reward_entry.group_entry = group_entry.key();
    group_reward_entry.reward_seconds_received = 0;
    group_reward_entry.multiplier = total_multipliers / group_size as u64;
    group_reward_counter.count += 1;

    Ok(())
}

fn has_unique_elements<T>(iter: T) -> bool
where
    T: IntoIterator,
    T::Item: Eq + Hash,
{
    let mut uniq = HashSet::new();
    iter.into_iter().all(move |x| uniq.insert(x))
}

fn is_all_same<T>(iter: T) -> bool
where
    T: IntoIterator,
    T::Item: Eq + Hash,
{
    let mut arr = iter.into_iter();
    let first = arr.next();

    arr.all(|x| Some(x) == first)
}
