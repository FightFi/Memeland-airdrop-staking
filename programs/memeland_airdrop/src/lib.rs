use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("AovZsuC2giiHcTZ7Rn2dz1rd89qB8pPkw1TBZRceQbqq");

// ── Constants ──────────────────────────────────────────────────────────────────

pub const TOTAL_DAYS: u64 = 20;
pub const CLAIM_WINDOW_DAYS: u64 = 35;
pub const SECONDS_PER_DAY: u64 = 86400;

/// Airdrop pool: 67_000_000 tokens × 10^9 (9 decimals)
pub const AIRDROP_POOL: u64 = 67_000_000_000_000_000;

/// Staking rewards pool: 133_000_000 tokens × 10^9
pub const STAKING_POOL: u64 = 133_000_000_000_000_000;

/// TODO: Replace with actual admin pubkey before deployment
pub const INIT_AUTHORITY: Pubkey = pubkey!("CpPPfLTUzytRXBrUUjb84EkYtA84CsoeVefhaJ2cyPg3");

// ── Seeds ──────────────────────────────────────────────────────────────────────

/// PDA seed constants for consistent usage across the program
pub mod seeds {
    pub const POOL_STATE: &[u8] = b"pool_state";
    pub const POOL_TOKEN: &[u8] = b"pool_token";
    pub const USER_STAKE: &[u8] = b"user_stake";
    pub const CLAIMED: &[u8] = b"claimed";
}

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
        let clock = Clock::get()?;
        require!(
            start_time > clock.unix_timestamp,
            ErrorCode::StartTimeInPast
        );

        let pool = &mut ctx.accounts.pool_state;
        pool.admin = ctx.accounts.admin.key();
        pool.token_mint = ctx.accounts.token_mint.key();
        pool.pool_token_account = ctx.accounts.pool_token_account.key();
        pool.merkle_root = merkle_root;
        pool.start_time = start_time;
        pool.total_staked = AIRDROP_POOL;
        pool.total_airdrop_claimed = 0;
        pool.snapshot_count = 0;
        pool.terminated = 0;
        pool.paused = 0;
        pool.bump = ctx.bumps.pool_state;
        pool.pool_token_bump = ctx.bumps.pool_token_account;

        // Validate that the supplied daily rewards sum to exactly STAKING_POOL
        // AND ensure ascending order
        let mut sum: u64 = daily_rewards[0];
        pool.daily_rewards[0] = daily_rewards[0];
        for d in 1..20usize {
            require!(
                daily_rewards[d] >= daily_rewards[d - 1],
                ErrorCode::InvalidDailyRewardsOrder
            );

            sum = sum.checked_add(daily_rewards[d]).unwrap();
            pool.daily_rewards[d] = daily_rewards[d];
        }
        require!(sum == STAKING_POOL, ErrorCode::InvalidDailyRewards);

        emit!(PoolInitialized {
            admin: pool.admin,
            token_mint: pool.token_mint,
            start_time: pool.start_time,
        });

        msg!(
            "Pool initialized. Start: {}, merkle root set, {} daily rewards validated",
            pool.start_time,
            TOTAL_DAYS
        );
        Ok(())
    }

    /// Claim airdrop via merkle proof. Tokens are sent directly to user wallet.
    /// Creates a permanent ClaimMarker (prevents re-claims) and a UserStake for reward tracking (closed on unstake).
    pub fn claim_airdrop(
        ctx: Context<ClaimAirdrop>,
        amount: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        let pool_state_key = ctx.accounts.pool_state.key();
        let pool = &mut ctx.accounts.pool_state;
        let clock = Clock::get()?;

        require!(pool.paused == 0, ErrorCode::PoolPaused);
        require!(pool.terminated == 0, ErrorCode::PoolTerminated);
        require!(
            clock.unix_timestamp > pool.start_time,
            ErrorCode::PoolNotStartedYet
        );

        // Determine which day the user is claiming on
        let current_day = get_current_day(pool.start_time, clock.unix_timestamp);

        // Block claims after the claim window ends (day 35+)
        require!(current_day < CLAIM_WINDOW_DAYS, ErrorCode::StakingPeriodEnded);

        // Verify merkle proof
        let user_bytes = ctx.accounts.user.key().to_bytes();
        let amount_bytes = amount.to_le_bytes();
        let leaf = keccak::hashv(&[user_bytes.as_ref(), amount_bytes.as_ref()]);
        require!(
            verify_merkle_proof(&proof, &pool.merkle_root, &leaf.0),
            ErrorCode::InvalidMerkleProof
        );

        // Initialize claim marker (prevents re-claiming after unstake)
        let claim_marker = &mut ctx.accounts.claim_marker;
        claim_marker.bump = ctx.bumps.claim_marker;

        // Initialize user stake
        let user_stake = &mut ctx.accounts.user_stake;
        user_stake.owner = ctx.accounts.user.key();
        user_stake.staked_amount = amount;
        user_stake.bump = ctx.bumps.user_stake;

        pool.total_airdrop_claimed = pool.total_airdrop_claimed.checked_add(amount).unwrap();
        pool.active_stakers = pool.active_stakers.checked_add(1).unwrap();

        require!(
            pool.total_airdrop_claimed <= AIRDROP_POOL,
            ErrorCode::AirdropPoolExhausted
        );

        // Send airdrop tokens to user via pool PDA signer
        transfer_from_pool_pda(
            &ctx.accounts.token_program,
            &ctx.accounts.pool_token_account,
            &ctx.accounts.user_token_account,
            &pool_state_key,
            pool.pool_token_bump,
            amount,
        )?;

        emit!(AirdropClaimed {
            user: user_stake.owner,
            amount,
            claim_day: current_day,
        });

        msg!(
            "Airdrop claimed and staked: {} tokens for {}, claim_day={}",
            amount,
            user_stake.owner,
            current_day
        );
        Ok(())
    }

    /// Anyone can call snapshot once daily (any time during the day).
    /// Records total_staked for the current day.
    /// Claims/unstakes are blocked until the previous day's snapshot is taken.
    pub fn snapshot(ctx: Context<Snapshot>) -> Result<()> {
        let pool = &mut ctx.accounts.pool_state;
        let clock = Clock::get()?;

        require!(pool.paused == 0, ErrorCode::PoolPaused);
        require!(pool.terminated == 0, ErrorCode::PoolTerminated);

        // Must be at least day 1 (snapshot records the previous day's state)
        let raw_day = get_current_day(pool.start_time, clock.unix_timestamp);
        require!(raw_day >= 1, ErrorCode::InvalidDay);

        // Cap to TOTAL_DAYS for array indexing (days 0..19)
        let snapshot_day = raw_day.min(TOTAL_DAYS);

        let last = pool.snapshot_count as usize;

        let mut wrote = false;

        // fill ONLY missing days
        for d in last..(snapshot_day as usize) {
            if pool.daily_snapshots[d] == 0 {
                pool.daily_snapshots[d] = pool.total_staked;
                wrote = true;
            }
        }

        // snapshot_count tracks the highest day snapshotted (upper bound for reward loop)
        pool.snapshot_count = snapshot_day as u8;

        if wrote {
            emit!(SnapshotTaken {
                day: snapshot_day,
                total_staked: pool.total_staked,
            });
            msg!(
                "Snapshot {} recorded: total_staked = {}",
                snapshot_day,
                pool.total_staked
            );
        } else {
            msg!("No snapshots needed for today.");
        }

        Ok(())
    }

    /// Unstake: permanent exit. Sends all accumulated rewards.
    /// After claim window (day 35+), users can still unstake but receive 0 rewards.
    /// Closes the UserStake account and returns rent to user.
    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        let pool_state_key = ctx.accounts.pool_state.key();
        let pool = &mut ctx.accounts.pool_state;
        let user_stake = &ctx.accounts.user_stake;
        let clock = Clock::get()?;

        require!(user_stake.staked_amount > 0, ErrorCode::NothingStaked);

        let expired = clock.unix_timestamp >= claim_window_end(pool.start_time);

        let rewards = if expired {
            // After claim window: user can still close their stake, but gets 0 rewards
            0
        } else {
            // Cap to TOTAL_DAYS for snapshot comparison and reward calculation
            let current_day = get_current_day(pool.start_time, clock.unix_timestamp)
                .min(TOTAL_DAYS);
            // Block unstaking if previous day's snapshot hasn't been taken yet
            require!(
                pool.snapshot_count >= current_day as u8,
                ErrorCode::SnapshotRequiredFirst
            );
            calculate_user_rewards(
                user_stake.staked_amount,
                current_day,
                &pool.daily_rewards,
                &pool.daily_snapshots,
            )
        };

        // Transfer tokens via PDA signer (skip if 0 rewards)
        if rewards > 0 {
            transfer_from_pool_pda(
                &ctx.accounts.token_program,
                &ctx.accounts.pool_token_account,
                &ctx.accounts.user_token_account,
                &pool_state_key,
                pool.pool_token_bump,
                rewards,
            )?;
        }

        // Update pool state (UserStake account is closed by Anchor's close constraint)
        pool.total_staked = pool
            .total_staked
            .checked_sub(user_stake.staked_amount)
            .unwrap();
        pool.active_stakers = pool.active_stakers.checked_sub(1).unwrap();
        pool.total_unstaked = pool.total_unstaked.checked_add(1).unwrap();

        emit!(Unstaked {
            user: user_stake.owner,
            rewards,
        });

        msg!(
            "Unstaked: {} rewards sent to {}. UserStake account closed.",
            rewards,
            user_stake.owner
        );
        Ok(())
    }

    /// View function: calculate potential rewards for a user on a given day.
    /// For past days with snapshots, uses actual values.
    /// For future days, uses the last snapshot's total_staked.
    /// Note: After unstake, UserStake is closed so this instruction will fail (account not found).
    pub fn calculate_rewards(ctx: Context<CalculateRewards>, day: u64) -> Result<()> {
        let pool = &ctx.accounts.pool_state;
        let user_stake = &ctx.accounts.user_stake;

        require!(day < TOTAL_DAYS, ErrorCode::InvalidDay);

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

        let daily = pool.daily_rewards[day_idx] as u128;
        let reward = (user_stake.staked_amount as u128)
            .checked_mul(daily)
            .unwrap()
            .checked_div(snapshot_total as u128)
            .unwrap_or(0) as u64;

        msg!("Day {} reward: {}", day, reward);
        Ok(())
    }

    /// After claim window (day 35+), admin recovers all remaining tokens and terminates pool.
    /// Sets terminated = 1 (blocks future claims/snapshots) and drains entire balance.
    /// Since stakes are virtual (airdrop tokens were sent directly to users on claim),
    /// total_staked represents no real token obligation — the entire balance can be drained.
    /// Can be called again if tokens are sent to the pool after first recovery.
    pub fn recover_expired_rewards(ctx: Context<RecoverExpiredRewards>) -> Result<()> {
        let pool_state_key = ctx.accounts.pool_state.key();
        let pool = &mut ctx.accounts.pool_state;
        let clock = Clock::get()?;

        require!(
            clock.unix_timestamp >= claim_window_end(pool.start_time),
            ErrorCode::ClaimWindowStillOpen
        );

        pool.terminated = 1;

        // Drain entire balance — total_staked is virtual (no real tokens owed)
        let pool_balance = ctx.accounts.pool_token_account.amount;
        require!(pool_balance > 0, ErrorCode::NothingToRecover);

        transfer_from_pool_pda(
            &ctx.accounts.token_program,
            &ctx.accounts.pool_token_account,
            &ctx.accounts.admin_token_account,
            &pool_state_key,
            pool.pool_token_bump,
            pool_balance,
        )?;

        emit!(TokensRecovered { amount: pool_balance });

        msg!("Pool terminated. {} tokens recovered.", pool_balance);
        Ok(())
    }

    /// Emergency pause - blocks claims and snapshots.
    /// Users can still unstake to protect their funds.
    pub fn pause_pool(ctx: Context<PausePool>) -> Result<()> {
        let pool = &mut ctx.accounts.pool_state;

        require!(pool.paused == 0, ErrorCode::AlreadyPaused);
        require!(pool.terminated == 0, ErrorCode::PoolTerminated);

        pool.paused = 1;

        emit!(PoolPausedEvent {
            admin: ctx.accounts.admin.key(),
        });

        msg!("Pool paused by admin: {}", ctx.accounts.admin.key());
        Ok(())
    }

    /// Unpause pool - resumes normal operations.
    pub fn unpause_pool(ctx: Context<PausePool>) -> Result<()> {
        let pool = &mut ctx.accounts.pool_state;

        require!(pool.paused == 1, ErrorCode::PoolNotPaused);
        require!(pool.terminated == 0, ErrorCode::PoolTerminated);

        pool.paused = 0;

        emit!(PoolUnpausedEvent {
            admin: ctx.accounts.admin.key(),
        });

        msg!("Pool unpaused by admin: {}", ctx.accounts.admin.key());
        Ok(())
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/// Shared helper to transfer tokens from the pool's PDA-owned token account.
fn transfer_from_pool_pda<'info>(
    token_program: &Program<'info, Token>,
    pool_token_account: &Account<'info, TokenAccount>,
    destination_token_account: &Account<'info, TokenAccount>,
    pool_state_key: &Pubkey,
    pool_token_bump: u8,
    amount: u64,
) -> Result<()> {
    let seeds = &[
        seeds::POOL_TOKEN,
        pool_state_key.as_ref(),
        &[pool_token_bump],
    ];
    let signer_seeds = &[&seeds[..]];

    let transfer_ctx = CpiContext::new_with_signer(
        token_program.to_account_info(),
        Transfer {
            from: pool_token_account.to_account_info(),
            to: destination_token_account.to_account_info(),
            authority: pool_token_account.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, amount)
}

/// Returns the unix timestamp when the claim window ends (day 35).
pub fn claim_window_end(start_time: i64) -> i64 {
    start_time + (CLAIM_WINDOW_DAYS as i64 * SECONDS_PER_DAY as i64)
}

/// Returns the actual elapsed day since pool start (uncapped).
/// Day 0 = first 86400s, Day 1 = next 86400s, etc.
/// Call sites must cap to TOTAL_DAYS explicitly where needed for array indexing.
pub fn get_current_day(start_time: i64, now: i64) -> u64 {
    if now <= start_time {
        return 0;
    }
    ((now - start_time) as u64) / SECONDS_PER_DAY
}

/// Calculate total accumulated rewards for a user across all snapshotted days.
fn calculate_user_rewards(
    staked_amount: u64,
    current_day: u64,
    daily_rewards: &[u64; 32],
    daily_snapshots: &[u64; 32],
) -> u64 {
    let mut total_rewards: u128 = 0;

    for d in 0..(current_day as usize) {
        let snapshot_total = daily_snapshots[d] as u128;

        let user_share = (staked_amount as u128)
            .checked_mul(daily_rewards[d] as u128)
            .unwrap()
            .checked_div(snapshot_total)
            .unwrap_or(0);

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
    #[account(
        mut,
        constraint = admin.key() == INIT_AUTHORITY @ ErrorCode::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + PoolState::INIT_SPACE,
        seeds = [seeds::POOL_STATE, token_mint.key().as_ref()],
        bump,
    )]
    pub pool_state: Account<'info, PoolState>,

    /// The token mint for this staking pool
    pub token_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        seeds = [seeds::POOL_TOKEN, pool_state.key().as_ref()],
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
    pub pool_state: Account<'info, PoolState>,

    /// Permanent marker that prevents re-claiming (tiny, ~0.001 SOL)
    /// This account exists forever to prevent claim-unstake-reclaim attacks
    #[account(
        init,
        payer = user,
        space = 8 + ClaimMarker::INIT_SPACE,
        seeds = [seeds::CLAIMED, pool_state.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub claim_marker: Account<'info, ClaimMarker>,

    /// Stake data, closed on unstake (user recovers rent)
    #[account(
        init,
        payer = user,
        space = 8 + UserStake::INIT_SPACE,
        seeds = [seeds::USER_STAKE, pool_state.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub user_stake: Account<'info, UserStake>,

    /// Pool's token account - must match the one stored in pool_state
    #[account(
        mut,
        constraint = pool_token_account.key() == pool_state.pool_token_account @ ErrorCode::InvalidPoolTokenAccount,
    )]
    pub pool_token_account: Account<'info, TokenAccount>,

    /// User's token account to receive airdropped (and staked) tokens
    #[account(
        mut,
        token::mint = pool_state.token_mint,
        token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Snapshot<'info> {
    pub signer: Signer<'info>,

    #[account(mut)]
    pub pool_state: Account<'info, PoolState>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub pool_state: Account<'info, PoolState>,

    /// User's stake account - will be closed and rent returned
    #[account(
        mut,
        seeds = [seeds::USER_STAKE, pool_state.key().as_ref(), user.key().as_ref()],
        bump = user_stake.bump,
        constraint = user_stake.owner == user.key() @ ErrorCode::InvalidStakeOwner,
        close = user,
    )]
    pub user_stake: Account<'info, UserStake>,

    /// Pool's token account - must match the one stored in pool_state
    #[account(
        mut,
        constraint = pool_token_account.key() == pool_state.pool_token_account @ ErrorCode::InvalidPoolTokenAccount,
    )]
    pub pool_token_account: Account<'info, TokenAccount>,

    /// User's token account to receive staking rewards
    #[account(
        mut,
        token::mint = pool_state.token_mint,
        token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CalculateRewards<'info> {
    pub pool_state: Account<'info, PoolState>,

    /// User's stake account - read-only for reward calculation
    #[account(
        seeds = [seeds::USER_STAKE, pool_state.key().as_ref(), user_stake.owner.as_ref()],
        bump = user_stake.bump,
    )]
    pub user_stake: Account<'info, UserStake>,
}

#[derive(Accounts)]
pub struct RecoverExpiredRewards<'info> {
    /// Must be the pool admin to recover tokens
    #[account(
        constraint = admin.key() == pool_state.admin @ ErrorCode::UnauthorizedAdmin,
    )]
    pub admin: Signer<'info>,

    #[account(mut)]
    pub pool_state: Account<'info, PoolState>,

    /// Pool's token account - must match the one stored in pool_state
    #[account(
        mut,
        constraint = pool_token_account.key() == pool_state.pool_token_account @ ErrorCode::InvalidPoolTokenAccount,
    )]
    pub pool_token_account: Account<'info, TokenAccount>,

    /// Admin's token account to receive recovered tokens
    #[account(
        mut,
        token::mint = pool_state.token_mint,
        token::authority = admin,
    )]
    pub admin_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct PausePool<'info> {
    /// Must be the pool admin to pause/unpause
    #[account(
        constraint = admin.key() == pool_state.admin @ ErrorCode::UnauthorizedAdmin,
    )]
    pub admin: Signer<'info>,

    #[account(mut)]
    pub pool_state: Account<'info, PoolState>,
}

// ── State ──────────────────────────────────────────────────────────────────────

/// Pool state for the staking program.
#[account]
#[derive(InitSpace)]
pub struct PoolState {
    pub admin: Pubkey,              // 32
    pub token_mint: Pubkey,         // 32
    pub pool_token_account: Pubkey, // 32
    pub merkle_root: [u8; 32],      // 32
    pub start_time: i64,            // 8
    pub total_staked: u64,          // 8
    pub total_airdrop_claimed: u64, // 8
    pub snapshot_count: u8,         // 1
    pub terminated: u8,             // 1
    pub bump: u8,                   // 1
    pub pool_token_bump: u8,        // 1
    pub paused: u8,                 // 1  (0 = active, 1 = paused)
    pub active_stakers: u32,        // 4
    pub total_unstaked: u32,        // 4
    pub daily_rewards: [u64; 32],   // 256 (only 0..20 used)
    pub daily_snapshots: [u64; 32], // 256 (only 0..20 used)
}

/// Permanent marker that prevents re-claiming after unstake.
/// Tiny account (~0.001 SOL rent) that stays forever.
#[account]
#[derive(InitSpace)]
pub struct ClaimMarker {
    pub bump: u8, // 1
}

/// User stake data. Created on claim, closed on unstake (rent returned).
#[account]
#[derive(InitSpace)]
pub struct UserStake {
    pub owner: Pubkey,      // 32
    pub staked_amount: u64, // 8
    pub bump: u8,           // 1
}

// ── Events ──────────────────────────────────────────────────────────────────────

#[event]
pub struct PoolInitialized {
    pub admin: Pubkey,
    pub token_mint: Pubkey,
    pub start_time: i64,
}

#[event]
pub struct AirdropClaimed {
    pub user: Pubkey,
    pub amount: u64,
    pub claim_day: u64,
}

#[event]
pub struct SnapshotTaken {
    pub day: u64,
    pub total_staked: u64,
}

#[event]
pub struct Unstaked {
    pub user: Pubkey,
    pub rewards: u64,
}

#[event]
pub struct TokensRecovered {
    pub amount: u64,
}

#[event]
pub struct PoolPausedEvent {
    pub admin: Pubkey,
}

#[event]
pub struct PoolUnpausedEvent {
    pub admin: Pubkey,
}

// ── Errors ─────────────────────────────────────────────────────────────────────

#[error_code]
pub enum ErrorCode {
    // ── Pool Errors ────────────────────────────────────────────────────────────
    #[msg("Start time is in the past - cannot initialize pool")]
    StartTimeInPast,
    #[msg("Airdrop pool exhausted - no more tokens available for claims")]
    AirdropPoolExhausted,
    #[msg("Pool has been terminated - no new claims allowed")]
    PoolTerminated,
    #[msg("Daily rewards must sum to exactly STAKING_POOL (133M tokens)")]
    InvalidDailyRewards,
    #[msg("Daily rewards must be in ascending order")]
    InvalidDailyRewardsOrder,
    #[msg("Pool is paused - operations temporarily disabled")]
    PoolPaused,
    #[msg("Pool is not paused - cannot unpause")]
    PoolNotPaused,
    #[msg("Pool is already paused")]
    AlreadyPaused,
    // ── Stake Errors ───────────────────────────────────────────────────────────
    #[msg("Nothing staked - user has no active stake")]
    NothingStaked,
    #[msg("User does not own this stake account")]
    InvalidStakeOwner,

    // ── Authorization Errors ───────────────────────────────────────────────────
    #[msg("Unauthorized - caller is not the pool admin")]
    UnauthorizedAdmin,
    #[msg("Unauthorized - generic access denied")]
    Unauthorized,

    // ── Merkle Proof Errors ────────────────────────────────────────────────────
    #[msg("Invalid merkle proof - verification failed")]
    InvalidMerkleProof,

    // ── Snapshot Errors ────────────────────────────────────────────────────────
    #[msg("Invalid day for this operation")]
    InvalidDay,
    #[msg("Previous day's snapshot must be taken before claims/unstakes")]
    SnapshotRequiredFirst,

    // ── Token Account Errors ───────────────────────────────────────────────────
    #[msg("Invalid pool token account - does not match pool state")]
    InvalidPoolTokenAccount,

    // ── Recovery Errors ────────────────────────────────────────────────────────
    #[msg("No tokens to recover - pool balance equals staked amount")]
    NothingToRecover,
    #[msg("Pool not started yet - must wait until start time")]
    PoolNotStartedYet,
    #[msg("Staking period has ended - claims are no longer accepted")]
    StakingPeriodEnded,
    #[msg("Claim window still open - cannot terminate until day 35")]
    ClaimWindowStillOpen,
}
