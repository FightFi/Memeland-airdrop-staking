use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("4y6rh1SKMAGvunes2gHCeJkEkmPVDLhWYxNg8Zpd7RqH");

// ── Constants ──────────────────────────────────────────────────────────────────

pub const TOTAL_DAYS: u64 = 20;
pub const SECONDS_PER_DAY: u64 = 86400;
pub const EXIT_WINDOW_DAYS: u64 = 15;

/// Airdrop pool: 50_000_000 tokens × 10^9 (9 decimals)
pub const AIRDROP_POOL: u64 = 50_000_000_000_000_000;

/// Staking rewards pool: 100_000_000 tokens × 10^9
pub const STAKING_POOL: u64 = 100_000_000_000_000_000;

// PoolState size for zero_copy:
// 32 + 32 + 32 + 32 + 8 + 8 + 8 + 1 + 1 + 1 + 1 + 4 + (32*8) + (32*8) = 672
pub const POOL_STATE_SIZE: usize = 672;

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
        pool.paused = 0;
        pool.bump = ctx.bumps.pool_state;
        pool.pool_token_bump = ctx.bumps.pool_token_account;

        // Validate that the supplied daily rewards sum to exactly STAKING_POOL
        let mut sum: u64 = 0;
        for d in 0..20usize {
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

    /// Claim airdrop via merkle proof. Tokens are auto-staked.
    /// Creates a permanent ClaimMarker (prevents re-claims) and a UserStake (closed on unstake).
    pub fn claim_airdrop(
        ctx: Context<ClaimAirdrop>,
        amount: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool_state.load_mut()?;
        let clock = Clock::get()?;

        require!(pool.paused == 0, ErrorCode::PoolPaused);
        require!(pool.terminated == 0, ErrorCode::PoolTerminated);
        require!(
            !program_expired(pool.start_time, clock.unix_timestamp),
            ErrorCode::ProgramExpired
        );
       require!(clock.unix_timestamp > pool.start_time, ErrorCode::PoolNotStartedYet);
       
        // Determine which day the user is claiming on
        let current_day = get_current_day(pool.start_time, clock.unix_timestamp);

        // Block claims if previous day's snapshot hasn't been taken yet
        // On day N (N >= 1), require snapshot for this day 
        if current_day >= 1 {
            require!(
                pool.snapshot_count >= current_day as u8,
                ErrorCode::SnapshotRequiredFirst
            );
        }

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
        user_stake.claim_day = current_day;
        user_stake.bump = ctx.bumps.user_stake;

        pool.total_staked = pool.total_staked.checked_add(amount).unwrap();
        pool.total_airdrop_claimed = pool.total_airdrop_claimed.checked_add(amount).unwrap();

        require!(
            pool.total_airdrop_claimed <= AIRDROP_POOL,
            ErrorCode::AirdropPoolExhausted
        );

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
        let pool = &mut ctx.accounts.pool_state.load_mut()?;
        let clock = Clock::get()?;

        require!(pool.paused == 0, ErrorCode::PoolPaused);
        require!(pool.terminated == 0, ErrorCode::PoolTerminated);

        // Check we are on a valid day (1-20)
        let current_day = get_current_day(pool.start_time, clock.unix_timestamp);
        require!(
            current_day >= 1 && current_day <= TOTAL_DAYS,
            ErrorCode::InvalidDay
        );

        let last = pool.snapshot_count as usize;

        let mut wrote = false;

        // fill ONLY missing days
        for d in last..(current_day as usize) {
            if pool.daily_snapshots[d] == 0 {
                pool.daily_snapshots[d] = pool.total_staked;
                wrote = true;
            }
        }

        // snapshot_count tracks the highest day snapshotted (upper bound for reward loop)
        pool.snapshot_count = current_day as u8;

        if wrote {  
            emit!(SnapshotTaken {
                    day: current_day,
                    total_staked: pool.total_staked,
                }); 
            msg!(
                "Snapshot {} recorded: total_staked = {}",
                current_day,
                pool.total_staked
            );
        } else {
            msg!("No snapshots needed for today.");
        }
        Ok(())
    }

    /// Unstake: permanent exit. Sends principal + all accumulated rewards.
    /// Blocked if previous day's snapshot hasn't been taken yet.
    /// Closes the UserStake account and returns rent to user.
    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        let pool = &mut ctx.accounts.pool_state.load_mut()?;
        let user_stake = &ctx.accounts.user_stake;
        let clock = Clock::get()?;

        require!(user_stake.staked_amount > 0, ErrorCode::NothingStaked);

        // Block unstaking if previous day's snapshot hasn't been taken yet
        let current_day = get_current_day(pool.start_time, clock.unix_timestamp);
        if current_day >= 1 {
            require!(
                pool.snapshot_count >= current_day as u8,
                ErrorCode::SnapshotRequiredFirst
            );
        }

        let expired = program_expired(pool.start_time, clock.unix_timestamp);

        let rewards = if expired {
            0
        } else {
            calculate_user_rewards(
                    user_stake.staked_amount,
                    user_stake.claim_day,
                    pool.snapshot_count,
                    &pool.daily_rewards,
                    &pool.daily_snapshots,
            );
        };

        let total_payout = user_stake
            .staked_amount
            .checked_add(rewards)
            .unwrap();

        // Transfer tokens via PDA signer
        let pool_state_key = ctx.accounts.pool_state.key();
        let seeds = &[
            seeds::POOL_TOKEN,
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

        emit!(Unstaked {
            user: user_stake.owner,
            principal: user_stake.staked_amount,
            rewards,
        });

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

        require!(
            pool.snapshot_count as u64 >= TOTAL_DAYS,
            ErrorCode::SnapshotsNotCompleted
        );
    
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
                seeds::POOL_TOKEN,
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

        emit!(PoolTerminated {
            drained_amount: drainable,
        });

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

    /// After exit window, admin can recover unclaimed rewards (not user principal).
    /// User principal remains protected - users can still unstake after this.
    pub fn recover_expired_tokens(ctx: Context<RecoverExpiredTokens>) -> Result<()> {
        let pool = &mut ctx.accounts.pool_state.load_mut()?;
        let clock = Clock::get()?;

        require!(
            program_expired(pool.start_time, clock.unix_timestamp),
            ErrorCode::ExitWindowNotFinished
        );

        // Only recover tokens beyond what users have staked (protect principal)
        let pool_balance = ctx.accounts.pool_token_account.amount;
        let amount = pool_balance.saturating_sub(pool.total_staked);
        require!(amount > 0, ErrorCode::NothingToRecover);

        let pool_state_key = ctx.accounts.pool_state.key();
        let seeds = &[
            seeds::POOL_TOKEN,
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

        token::transfer(transfer_ctx, amount)?;

        emit!(TokensRecovered { amount });

        msg!("Recovered expired tokens: {}", amount);

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
            seeds::POOL_TOKEN,
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

        emit!(PoolClosed {
            lamports_returned: pool_lamports,
        });

        msg!(
            "Pool closed. Rent returned to admin: {} lamports from pool_state + token account rent.",
            pool_lamports
        );
        Ok(())
    }

    /// Emergency pause - blocks claims and snapshots.
    /// Users can still unstake to protect their funds.
    pub fn pause_pool(ctx: Context<PausePool>) -> Result<()> {
        let pool = &mut ctx.accounts.pool_state.load_mut()?;

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
        let pool = &mut ctx.accounts.pool_state.load_mut()?;

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

    let start = claim_day as usize;

    for d in start..(snapshot_count as usize) {
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

/// Calculate the deadline for exiting the program.
pub fn exit_deadline(start_time: i64) -> i64 {
    start_time +
    ((TOTAL_DAYS + EXIT_WINDOW_DAYS) as i64 * SECONDS_PER_DAY as i64)
}

/// Check if the program has expired.
pub fn program_expired(start_time: i64, now: i64) -> bool {
    now > exit_deadline(start_time)
}


// ── Accounts ───────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        constraint = upgrade_authority.key()
            == ctx.program_upgrade_authority().unwrap()
    )]
    pub upgrade_authority: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + POOL_STATE_SIZE,
        seeds = [seeds::POOL_STATE, token_mint.key().as_ref()],
        bump,
    )]
    pub pool_state: AccountLoader<'info, PoolState>,

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
    pub pool_state: AccountLoader<'info, PoolState>,

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

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Snapshot<'info> {
    pub signer: Signer<'info>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

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
        constraint = pool_token_account.key() == pool_state.load()?.pool_token_account @ ErrorCode::InvalidPoolTokenAccount,
    )]
    pub pool_token_account: Account<'info, TokenAccount>,

    /// User's token account to receive principal + rewards
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
    /// Must be the pool admin to terminate
    #[account(
        constraint = admin.key() == pool_state.load()?.admin @ ErrorCode::UnauthorizedAdmin,
    )]
    pub admin: Signer<'info>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    /// Pool's token account - must match the one stored in pool_state
    #[account(
        mut,
        constraint = pool_token_account.key() == pool_state.load()?.pool_token_account @ ErrorCode::InvalidPoolTokenAccount,
    )]
    pub pool_token_account: Account<'info, TokenAccount>,

    /// Admin's token account to receive drained tokens
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

    /// User's stake account - read-only for reward calculation
    #[account(
        seeds = [seeds::USER_STAKE, pool_state.key().as_ref(), user_stake.owner.as_ref()],
        bump = user_stake.bump,
    )]
    pub user_stake: Account<'info, UserStake>,
}

#[derive(Accounts)]
pub struct ClosePool<'info> {
    /// Must be the pool admin to close
    #[account(
        mut,
        constraint = admin.key() == pool_state.load()?.admin @ ErrorCode::UnauthorizedAdmin,
    )]
    pub admin: Signer<'info>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    /// Pool's token account - must match and have zero balance to close
    #[account(
        mut,
        constraint = pool_token_account.key() == pool_state.load()?.pool_token_account @ ErrorCode::InvalidPoolTokenAccount,
    )]
    pub pool_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RecoverExpiredTokens<'info> {
    /// Must be the pool admin to recover tokens
    #[account(
        constraint = admin.key() == pool_state.load()?.admin @ ErrorCode::UnauthorizedAdmin,
    )]
    pub admin: Signer<'info>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    /// Pool's token account - must match the one stored in pool_state
    #[account(
        mut,
        constraint = pool_token_account.key() == pool_state.load()?.pool_token_account @ ErrorCode::InvalidPoolTokenAccount,
    )]
    pub pool_token_account: Account<'info, TokenAccount>,

    /// Admin's token account to receive recovered tokens
    #[account(
        mut,
        token::mint = pool_state.load()?.token_mint,
        token::authority = admin,
    )]
    pub admin_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct PausePool<'info> {
    /// Must be the pool admin to pause/unpause
    #[account(
        constraint = admin.key() == pool_state.load()?.admin @ ErrorCode::UnauthorizedAdmin,
    )]
    pub admin: Signer<'info>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,
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
    pub paused: u8,                       // 1  (0 = active, 1 = paused)
    pub _padding: [u8; 3],                // 3  (align to 8 bytes)
    pub daily_rewards: [u64; 32],         // 256 (only 0..20 used)
    pub daily_snapshots: [u64; 32],       // 256 (only 0..20 used)
}                                         // Total: 672

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
    pub principal: u64,
    pub rewards: u64,
}

#[event]
pub struct PoolTerminated {
    pub drained_amount: u64,
}

#[event]
pub struct TokensRecovered {
    pub amount: u64,
}

#[event]
pub struct PoolClosed {
    pub lamports_returned: u64,
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
    #[msg("Pool is already terminated - cannot terminate twice")]
    AlreadyTerminated,
    #[msg("Pool must be terminated before closing")]
    PoolNotTerminated,
    #[msg("Pool still has staked funds - all users must unstake first")]
    PoolNotEmpty,
    #[msg("Daily rewards must sum to exactly STAKING_POOL (100M tokens)")]
    InvalidDailyRewards,
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
    #[msg("Invalid day - must be between 1 and 20")]
    InvalidDay,
    #[msg("Snapshot too early - day has not yet elapsed")]
    SnapshotTooEarly,
    #[msg("Previous day's snapshot must be taken before claims/unstakes")]
    SnapshotRequiredFirst,
    #[msg("Snapshot already exists for this day - cannot overwrite")]
    SnapshotAlreadyExists,
    #[msg("Snapshots not completed - must take all 20 snapshots")]
    SnapshotsNotCompleted,

    // ── Token Account Errors ───────────────────────────────────────────────────
    #[msg("Invalid pool token account - does not match pool state")]
    InvalidPoolTokenAccount,
    #[msg("Invalid user token account - mint does not match pool")]
    InvalidUserTokenMint,
    #[msg("Invalid admin token account - mint does not match pool")]
    InvalidAdminTokenMint,

    // ── Recovery Errors ────────────────────────────────────────────────────────
    #[msg("Exit window not finished - must wait until day 35")]
    ExitWindowNotFinished,
    #[msg("No tokens to recover - pool balance equals staked amount")]
    NothingToRecover,
    #[msg("Pool not started yet - must wait until start time")]
    PoolNotStartedYet,
}
