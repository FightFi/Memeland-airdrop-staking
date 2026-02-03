use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("Abp5pKfeUysdsxZULSDSRxkG2v66gLPn6c1Yu1Zuk9jT");

// ── Constants ──────────────────────────────────────────────────────────────────

pub const TOTAL_DAYS: u64 = 20;
pub const SECONDS_PER_DAY: u64 = 86400;

/// Airdrop pool: 50_000_000 tokens × 10^9 (9 decimals)
pub const AIRDROP_POOL: u64 = 50_000_000_000_000_000;

/// Staking rewards pool: 100_000_000 tokens × 10^9
pub const STAKING_POOL: u64 = 100_000_000_000_000_000;

/// Snapshot window: 5 minutes starting at noon UTC
pub const SNAPSHOT_START: i64 = 12 * 60 * 60; // 12:00 PM UTC (noon) = 43200 seconds
pub const SNAPSHOT_WINDOW_SECS: i64 = 5 * 60; // 5 minutes


// PoolState size for zero_copy:
// 32 + 32 + 32 + 32 + 8 + 8 + 8 + 1 + 1 + 1 + 1 + 4 + (32*8) + (32*8) = 672
pub const POOL_STATE_SIZE: usize = 672;

// ── Program ────────────────────────────────────────────────────────────────────

#[program]
pub mod memeland_airdrop {
    use super::*;

    /// Initialize pool with merkle root and pre-computed daily rewards.
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        start_time: i64,
        merkle_root: [u8; 32],
        daily_rewards: [u64; 20],
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool_state.load_init()?;
        pool.admin = ctx.accounts.admin.key();
        pool.token_mint = ctx.accounts.token_mint.key();
        pool.pool_token_account = ctx.accounts.pool_token_account.key();
        pool.merkle_root = merkle_root;
        pool.start_time = start_time;
        pool.total_staked = 0;
        pool.total_airdrop_claimed = 0;
        pool.snapshot_count = 0;
        pool.terminated = 0;
        pool.bump = ctx.bumps.pool_state;
        pool.pool_token_bump = ctx.bumps.pool_token_account;

        // Validate that the supplied daily rewards sum to exactly STAKING_POOL
        let mut sum: u64 = 0;
        for d in 0..20usize {
            sum = sum.checked_add(daily_rewards[d]).unwrap();
            pool.daily_rewards[d] = daily_rewards[d];
        }
        require!(sum == STAKING_POOL, ErrorCode::InvalidDailyRewards);

        msg!(
            "Pool initialized. Start: {}, merkle root set, {} daily rewards validated",
            pool.start_time,
            TOTAL_DAYS
        );
        Ok(())
    }

    /// Claim airdrop via merkle proof. Tokens are auto-staked.
    /// Creates a permanent ClaimMarker (prevents re-claims) and a UserStake (closed on unstake).
    pub fn claim_airdrop(
        ctx: Context<ClaimAirdrop>,
        amount: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool_state.load_mut()?;
        let clock = Clock::get()?;

        require!(pool.terminated == 0, ErrorCode::PoolTerminated);

        // Block claims during snapshot window to prevent total_staked manipulation
        let seconds_into_day = clock.unix_timestamp.rem_euclid(SECONDS_PER_DAY as i64);
        require!(
            seconds_into_day < SNAPSHOT_START ||
            seconds_into_day >= SNAPSHOT_START + SNAPSHOT_WINDOW_SECS,
            ErrorCode::ClaimBlockedDuringSnapshot
        );

        // Verify merkle proof
        let leaf = keccak::hashv(&[
            &ctx.accounts.user.key().to_bytes(),
            &amount.to_le_bytes(),
        ]);
        require!(
            verify_merkle_proof(&proof, &pool.merkle_root, &leaf.0),
            ErrorCode::InvalidMerkleProof
        );

        // Determine which day the user is claiming on
        let claim_day = get_current_day(pool.start_time, clock.unix_timestamp);

        // Initialize claim marker (prevents re-claiming after unstake)
        let claim_marker = &mut ctx.accounts.claim_marker;
        claim_marker.bump = ctx.bumps.claim_marker;

        // Initialize user stake
        let user_stake = &mut ctx.accounts.user_stake;
        user_stake.owner = ctx.accounts.user.key();
        user_stake.staked_amount = amount;
        user_stake.claim_day = claim_day;
        user_stake.bump = ctx.bumps.user_stake;

        pool.total_staked = pool.total_staked.checked_add(amount).unwrap();
        pool.total_airdrop_claimed = pool.total_airdrop_claimed.checked_add(amount).unwrap();

        require!(
            pool.total_airdrop_claimed <= AIRDROP_POOL,
            ErrorCode::AirdropPoolExhausted
        );

        msg!(
            "Airdrop claimed and staked: {} tokens for {}, claim_day={}",
            amount,
            user_stake.owner,
            claim_day
        );
        Ok(())
    }

    /// Admin calls snapshot once daily between 12:00-12:05 AM UTC.
    /// Records total_staked for the current day.
    pub fn snapshot(ctx: Context<Snapshot>) -> Result<()> {
        let pool = &mut ctx.accounts.pool_state.load_mut()?;
        let clock = Clock::get()?;

        require!(pool.terminated == 0, ErrorCode::PoolTerminated);

        // Check we haven't exceeded TOTAL_DAYS
        let current_day = get_current_day(pool.start_time, clock.unix_timestamp);
        require!(
            (pool.snapshot_count as u64) < TOTAL_DAYS,
            ErrorCode::AllSnapshotsTaken
        );

        // Ensure snapshot is for the next expected day
        require!(
            current_day > pool.snapshot_count as u64,
            ErrorCode::SnapshotTooEarly
        );

        // Verify we are within the window
        let seconds_into_day = clock.unix_timestamp.rem_euclid(SECONDS_PER_DAY as i64);
        require!(
            seconds_into_day < SNAPSHOT_START ||
            seconds_into_day >= SNAPSHOT_START + SNAPSHOT_WINDOW_SECS,
            ErrorCode::ClaimBlockedDuringSnapshot
        );

        // Record snapshot
        let snap_idx = pool.snapshot_count as usize;
        pool.daily_snapshots[snap_idx] = pool.total_staked;
        pool.snapshot_count += 1;

        msg!(
            "Snapshot {} recorded: total_staked = {}",
            snap_idx,
            pool.total_staked
        );
        Ok(())
    }

    /// Unstake: permanent exit. Sends principal + all accumulated rewards.
    /// Cannot be called during snapshot window (12:00-12:05 AM UTC).
    /// Closes the UserStake account and returns rent to user.
    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        let pool = &mut ctx.accounts.pool_state.load_mut()?;
        let user_stake = &ctx.accounts.user_stake;
        let clock = Clock::get()?;

        require!(user_stake.staked_amount > 0, ErrorCode::NothingStaked);

        // Block unstaking during snapshot window
        let seconds_into_day = clock.unix_timestamp.rem_euclid(SECONDS_PER_DAY as i64);
        require!(
            seconds_into_day < SNAPSHOT_START ||
            seconds_into_day >= SNAPSHOT_START + SNAPSHOT_WINDOW_SECS,
            ErrorCode::ClaimBlockedDuringSnapshot
        );

        // Calculate accumulated rewards
        let rewards = calculate_user_rewards(
            user_stake.staked_amount,
            user_stake.claim_day,
            pool.snapshot_count,
            &pool.daily_rewards,
            &pool.daily_snapshots,
        );

        let total_payout = user_stake
            .staked_amount
            .checked_add(rewards)
            .unwrap();

        // Transfer tokens via PDA signer
        let pool_state_key = ctx.accounts.pool_state.key();
        let seeds = &[
            b"pool_token",
            pool_state_key.as_ref(),
            &[pool.pool_token_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.pool_token_account.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.pool_token_account.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, total_payout)?;

        // Update pool state (UserStake account is closed by Anchor's close constraint)
        pool.total_staked = pool.total_staked.checked_sub(user_stake.staked_amount).unwrap();

        msg!(
            "Unstaked: {} principal + {} rewards = {} total sent to {}. UserStake account closed.",
            total_payout - rewards,
            rewards,
            total_payout,
            user_stake.owner
        );
        Ok(())
    }

    /// Admin terminates pool. Caps rewards, returns surplus to admin.
    pub fn terminate_pool(ctx: Context<TerminatePool>) -> Result<()> {
        let pool = &mut ctx.accounts.pool_state.load_mut()?;

        require!(pool.terminated == 0, ErrorCode::AlreadyTerminated);
        pool.terminated = 1;

        // Calculate safe drain amount
        // Reserve: total_staked (principal) + max possible remaining rewards
        let pool_balance = ctx.accounts.pool_token_account.amount;
        let max_remaining_rewards = STAKING_POOL; // Conservative: reserve full staking pool
        let reserved = (pool.total_staked).saturating_add(max_remaining_rewards);
        let drainable = pool_balance.saturating_sub(reserved);

        if drainable > 0 {
            let pool_state_key = ctx.accounts.pool_state.key();
            let seeds = &[
                b"pool_token",
                pool_state_key.as_ref(),
                &[pool.pool_token_bump],
            ];
            let signer_seeds = &[&seeds[..]];

            let transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_token_account.to_account_info(),
                    to: ctx.accounts.admin_token_account.to_account_info(),
                    authority: ctx.accounts.pool_token_account.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(transfer_ctx, drainable)?;
        }

        msg!("Pool terminated. {} tokens returned to admin.", drainable);
        Ok(())
    }

    /// View function: calculate potential rewards for a user on a given day.
    /// For past days with snapshots, uses actual values.
    /// For future days, uses the last snapshot's total_staked.
    /// Note: After unstake, UserStake is closed so this instruction will fail (account not found).
    pub fn calculate_rewards(ctx: Context<CalculateRewards>, day: u64) -> Result<()> {
        let pool = &ctx.accounts.pool_state.load()?;
        let user_stake = &ctx.accounts.user_stake;

        require!(day < TOTAL_DAYS, ErrorCode::InvalidDay);

        if day < user_stake.claim_day {
            msg!("Day {} reward: 0 (before claim)", day);
            return Ok(());
        }

        let day_idx = day as usize;

        // Determine snapshot value to use
        let snapshot_total = if (day as u8) < pool.snapshot_count {
            // Actual snapshot exists
            pool.daily_snapshots[day_idx]
        } else if pool.snapshot_count > 0 {
            // Future day: use last snapshot
            pool.daily_snapshots[(pool.snapshot_count - 1) as usize]
        } else {
            // No snapshots yet: use current total_staked
            pool.total_staked
        };

        let reward = if snapshot_total > 0 {
            let daily = pool.daily_rewards[day_idx] as u128;
            let user_share = (user_stake.staked_amount as u128)
                .checked_mul(daily)
                .unwrap()
                / (snapshot_total as u128);
            user_share as u64
        } else {
            0
        };

        msg!("Day {} reward: {}", day, reward);
        Ok(())
    }

    /// Close pool state and token accounts, return rent to admin.
    /// Only allowed after pool is terminated AND all users have unstaked.
    pub fn close_pool(ctx: Context<ClosePool>) -> Result<()> {
        let pool = ctx.accounts.pool_state.load()?;

        require!(pool.terminated == 1, ErrorCode::PoolNotTerminated);
        require!(pool.total_staked == 0, ErrorCode::PoolNotEmpty);

        let pool_token_bump = pool.pool_token_bump;
        drop(pool); // Release borrow before closing

        // Close the pool token account (SPL close_account CPI)
        let pool_state_key = ctx.accounts.pool_state.key();
        let seeds = &[
            b"pool_token",
            pool_state_key.as_ref(),
            &[pool_token_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let close_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.pool_token_account.to_account_info(),
                destination: ctx.accounts.admin.to_account_info(),
                authority: ctx.accounts.pool_token_account.to_account_info(),
            },
            signer_seeds,
        );
        token::close_account(close_ctx)?;

        // Close pool_state (zero_copy account - manual lamport transfer)
        let pool_state_info = ctx.accounts.pool_state.to_account_info();
        let admin_info = ctx.accounts.admin.to_account_info();

        let pool_lamports = pool_state_info.lamports();
        **pool_state_info.try_borrow_mut_lamports()? = 0;
        **admin_info.try_borrow_mut_lamports()? = admin_info
            .lamports()
            .checked_add(pool_lamports)
            .unwrap();

        msg!(
            "Pool closed. Rent returned to admin: {} lamports from pool_state + token account rent.",
            pool_lamports
        );
        Ok(())
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

pub fn get_current_day(start_time: i64, now: i64) -> u64 {
    if now <= start_time {
        return 0;
    }
    let elapsed = (now - start_time) as u64;
    let day = elapsed / SECONDS_PER_DAY;
    if day >= TOTAL_DAYS {
        TOTAL_DAYS
    } else {
        day
    }
}

/// Calculate total accumulated rewards for a user across all snapshotted days.
fn calculate_user_rewards(
    staked_amount: u64,
    claim_day: u64,
    snapshot_count: u8,
    daily_rewards: &[u64; 32],
    daily_snapshots: &[u64; 32],
) -> u64 {
    let mut total_rewards: u128 = 0;

    for d in 0..(snapshot_count as usize) {
        // Skip days before the user claimed
        if (d as u64) < claim_day {
            continue;
        }

        let snapshot_total = daily_snapshots[d];
        if snapshot_total == 0 {
            continue;
        }

        let daily = daily_rewards[d] as u128;
        let user_share = (staked_amount as u128)
            .checked_mul(daily)
            .unwrap()
            / snapshot_total as u128;

        total_rewards = total_rewards.checked_add(user_share).unwrap();
    }

    total_rewards as u64
}

/// Verify a Merkle proof against a root.
fn verify_merkle_proof(proof: &[[u8; 32]], root: &[u8; 32], leaf: &[u8; 32]) -> bool {
    let mut computed_hash = *leaf;
    for node in proof.iter() {
        if computed_hash <= *node {
            computed_hash = keccak::hashv(&[&computed_hash, node]).0;
        } else {
            computed_hash = keccak::hashv(&[node, &computed_hash]).0;
        }
    }
    computed_hash == *root
}

// ── Accounts ───────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + POOL_STATE_SIZE,
        seeds = [b"pool_state", token_mint.key().as_ref()],
        bump,
    )]
    pub pool_state: AccountLoader<'info, PoolState>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        seeds = [b"pool_token", pool_state.key().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = pool_token_account,
    )]
    pub pool_token_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ClaimAirdrop<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    /// Permanent marker that prevents re-claiming (tiny, ~0.001 SOL)
    #[account(
        init,
        payer = user,
        space = 8 + ClaimMarker::INIT_SPACE,
        seeds = [b"claimed", pool_state.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub claim_marker: Account<'info, ClaimMarker>,

    /// Stake data, closed on unstake (user recovers rent)
    #[account(
        init,
        payer = user,
        space = 8 + UserStake::INIT_SPACE,
        seeds = [b"user_stake", pool_state.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub user_stake: Account<'info, UserStake>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Snapshot<'info> {
    #[account(
        constraint = admin.key() == pool_state.load()?.admin @ ErrorCode::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    #[account(
        mut,
        seeds = [b"user_stake", pool_state.key().as_ref(), user.key().as_ref()],
        bump = user_stake.bump,
        constraint = user_stake.owner == user.key() @ ErrorCode::Unauthorized,
        close = user,  // Return rent to user
    )]
    pub user_stake: Account<'info, UserStake>,

    #[account(
        mut,
        constraint = pool_token_account.key() == pool_state.load()?.pool_token_account @ ErrorCode::Unauthorized,
    )]
    pub pool_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = pool_state.load()?.token_mint,
        token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct TerminatePool<'info> {
    #[account(
        constraint = admin.key() == pool_state.load()?.admin @ ErrorCode::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    #[account(
        mut,
        constraint = pool_token_account.key() == pool_state.load()?.pool_token_account @ ErrorCode::Unauthorized,
    )]
    pub pool_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = pool_state.load()?.token_mint,
        token::authority = admin,
    )]
    pub admin_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CalculateRewards<'info> {
    pub pool_state: AccountLoader<'info, PoolState>,

    #[account(
        seeds = [b"user_stake", pool_state.key().as_ref(), user_stake.owner.as_ref()],
        bump = user_stake.bump,
    )]
    pub user_stake: Account<'info, UserStake>,
}

#[derive(Accounts)]
pub struct ClosePool<'info> {
    #[account(
        mut,
        constraint = admin.key() == pool_state.load()?.admin @ ErrorCode::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    #[account(
        mut,
        constraint = pool_token_account.key() == pool_state.load()?.pool_token_account @ ErrorCode::Unauthorized,
    )]
    pub pool_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// ── State ──────────────────────────────────────────────────────────────────────

/// Pool state using zero_copy to avoid stack overflow.
#[account(zero_copy(unsafe))]
#[repr(C)]
pub struct PoolState {
    pub admin: Pubkey,                    // 32
    pub token_mint: Pubkey,               // 32
    pub pool_token_account: Pubkey,       // 32
    pub merkle_root: [u8; 32],            // 32
    pub start_time: i64,                  // 8
    pub total_staked: u64,                // 8
    pub total_airdrop_claimed: u64,       // 8
    pub snapshot_count: u8,               // 1
    pub terminated: u8,                   // 1
    pub bump: u8,                         // 1
    pub pool_token_bump: u8,              // 1
    pub _padding: [u8; 4],               // 4  (align to 8 bytes)
    pub daily_rewards: [u64; 32],         // 256 (only 0..20 used)
    pub daily_snapshots: [u64; 32],       // 256 (only 0..20 used)
}                                         // Total: 688

/// Permanent marker that prevents re-claiming after unstake.
/// Tiny account (~0.001 SOL rent) that stays forever.
#[account]
#[derive(InitSpace)]
pub struct ClaimMarker {
    pub bump: u8,  // 1
}

/// User stake data. Created on claim, closed on unstake (rent returned).
#[account]
#[derive(InitSpace)]
pub struct UserStake {
    pub owner: Pubkey,       // 32
    pub staked_amount: u64,  // 8
    pub claim_day: u64,      // 8
    pub bump: u8,            // 1
}

// ── Errors ─────────────────────────────────────────────────────────────────────

#[error_code]
pub enum ErrorCode {
    #[msg("Program has ended")]
    ProgramEnded,
    #[msg("Airdrop pool exhausted")]
    AirdropPoolExhausted,
    #[msg("Nothing staked")]
    NothingStaked,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid merkle proof")]
    InvalidMerkleProof,
    #[msg("Pool has been terminated")]
    PoolTerminated,
    #[msg("Pool is already terminated")]
    AlreadyTerminated,
    #[msg("All 20 snapshots have been taken")]
    AllSnapshotsTaken,
    #[msg("Snapshot too early - day not yet elapsed")]
    SnapshotTooEarly,
    #[msg("Outside snapshot window (12:00-12:05 AM UTC)")]
    OutsideSnapshotWindow,
    #[msg("Unstaking blocked during snapshot window (12:00-12:05 AM UTC)")]
    UnstakeBlockedDuringSnapshot,
    #[msg("Invalid day")]
    InvalidDay,
    #[msg("Claims blocked during snapshot window (12:00-12:05 AM UTC)")]
    ClaimBlockedDuringSnapshot,
    #[msg("Daily rewards must sum to exactly STAKING_POOL")]
    InvalidDailyRewards,
    #[msg("Pool must be terminated before closing")]
    PoolNotTerminated,
    #[msg("Pool still has staked funds - all users must unstake first")]
    PoolNotEmpty,
}
