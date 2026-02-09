import math
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import os

POOL = 133_333_333
DAYS = 20

def compute_curve(k):
    weights = [math.exp(k * d) for d in range(DAYS)]
    total = sum(weights)
    return [POOL * w / total for w in weights]

f1 = compute_curve(0.05)
f2 = compute_curve(0.10)
f3 = compute_curve(0.15)

days = list(range(1, DAYS + 1))

fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(16, 7))
fig.patch.set_facecolor('#0d1117')

# --- Chart 1: Daily rewards ---
for ax in [ax1, ax2]:
    ax.set_facecolor('#161b22')
    ax.tick_params(colors='#c9d1d9')
    ax.xaxis.label.set_color('#c9d1d9')
    ax.yaxis.label.set_color('#c9d1d9')
    ax.title.set_color('#f0f6fc')
    for spine in ax.spines.values():
        spine.set_color('#30363d')
    ax.grid(True, alpha=0.15, color='#484f58')

ax1.plot(days, [v / 1e6 for v in f1], 'o-', color='#58a6ff', linewidth=2.5, markersize=5, label='F1 Moderate (K=0.05)')
ax1.plot(days, [v / 1e6 for v in f2], 's-', color='#f0883e', linewidth=2.5, markersize=5, label='F2 Aggressive (K=0.10)')
ax1.plot(days, [v / 1e6 for v in f3], 'D-', color='#f85149', linewidth=2.5, markersize=5, label='F3 Ultra-Aggressive (K=0.15)')

ax1.set_xlabel('Day', fontsize=12)
ax1.set_ylabel('Daily Reward (M tokens)', fontsize=12)
ax1.set_title('Daily Reward per Formula', fontsize=14, fontweight='bold')
ax1.legend(facecolor='#21262d', edgecolor='#30363d', labelcolor='#c9d1d9', fontsize=10)
ax1.set_xticks(days)
ax1.yaxis.set_major_formatter(mticker.FormatStrFormatter('%.1f'))

# Annotate day 1 and day 20 values
for curve, color, offset in [(f1, '#58a6ff', (8, 12)), (f2, '#f0883e', (8, 12)), (f3, '#f85149', (8, -18))]:
    ax1.annotate(f'{curve[0]/1e6:.1f}M', xy=(1, curve[0]/1e6), fontsize=8, color=color,
                 textcoords='offset points', xytext=(-30, offset[0]), fontweight='bold')
    ax1.annotate(f'{curve[-1]/1e6:.1f}M', xy=(20, curve[-1]/1e6), fontsize=8, color=color,
                 textcoords='offset points', xytext=(5, offset[1]), fontweight='bold')

# --- Chart 2: Cumulative % ---
def cumulative_pct(curve):
    total = sum(curve)
    acc = 0
    result = []
    for v in curve:
        acc += v
        result.append(acc / total * 100)
    return result

c1 = cumulative_pct(f1)
c2 = cumulative_pct(f2)
c3 = cumulative_pct(f3)

ax2.plot(days, c1, 'o-', color='#58a6ff', linewidth=2.5, markersize=5, label='F1 Moderate (K=0.05)')
ax2.plot(days, c2, 's-', color='#f0883e', linewidth=2.5, markersize=5, label='F2 Aggressive (K=0.10)')
ax2.plot(days, c3, 'D-', color='#f85149', linewidth=2.5, markersize=5, label='F3 Ultra-Aggressive (K=0.15)')

ax2.axhline(y=50, color='#484f58', linestyle='--', linewidth=1, alpha=0.7)
ax2.text(1.5, 52, '50%', color='#484f58', fontsize=9)

ax2.set_xlabel('Day', fontsize=12)
ax2.set_ylabel('Cumulative Rewards (%)', fontsize=12)
ax2.set_title('Cumulative: % of pool earned if you exit on day X', fontsize=14, fontweight='bold')
ax2.legend(facecolor='#21262d', edgecolor='#30363d', labelcolor='#c9d1d9', fontsize=10)
ax2.set_xticks(days)
ax2.set_ylim(0, 105)

# Annotate day 10 values
for pct_list, color, yoff in [(c1, '#58a6ff', 5), (c2, '#f0883e', -3), (c3, '#f85149', -12)]:
    val = pct_list[9]
    ax2.annotate(f'{val:.1f}%', xy=(10, val), fontsize=9, color=color,
                 textcoords='offset points', xytext=(8, yoff), fontweight='bold')

# Fill the "lost rewards" area for F3
ax2.fill_between(days, c3, 100, alpha=0.07, color='#f85149')
ax2.text(7, 75, 'Rewards lost\nif you exit\nbefore day 20', color='#f85149', fontsize=9,
         alpha=0.6, ha='center', style='italic')

fig.suptitle('Memeland Staking — Reward Curve Comparison\nPool: 200M (133.33M rewards)',
             fontsize=16, fontweight='bold', color='#f0f6fc', y=1.02)

plt.tight_layout()

out_path = os.path.join(os.path.dirname(__file__), 'reward-curves-comparison.png')
fig.savefig(out_path, dpi=180, bbox_inches='tight', facecolor=fig.get_facecolor())
print(f'Chart saved to: {out_path}')
