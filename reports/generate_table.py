import math
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors
import numpy as np
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

# --- Build figure ---
fig, ax = plt.subplots(figsize=(14, 12))
fig.patch.set_facecolor('#0d1117')
ax.set_facecolor('#0d1117')
ax.axis('off')

# Column config
cols = ['Day', 'F1 Moderate\n(K=0.05)', 'F2 Aggressive\n(K=0.10)', 'F3 Ultra-Aggressive\n(K=0.15)']
n_rows = DAYS
n_cols = len(cols)

# Layout
x_starts = [0.02, 0.14, 0.40, 0.66]
x_ends   = [0.14, 0.40, 0.66, 0.98]
row_h = 0.038
header_y = 0.95
top_y = header_y - row_h - 0.01

# Color maps for each formula column (blue, orange, red)
palettes = [
    None,  # Day column — no gradient
    ('#0d2137', '#1a4b7a'),  # F1 blue
    ('#2d1a06', '#7a4a0e'),  # F2 orange
    ('#2d0a09', '#7a1512'),  # F3 red
]
text_colors = ['#c9d1d9', '#58a6ff', '#f0883e', '#f85149']

# Normalise values for bar widths (per column, 0-1)
all_vals = [f1, f2, f3]
col_maxes = [max(v) for v in all_vals]

# --- Draw header ---
for c in range(n_cols):
    cx = (x_starts[c] + x_ends[c]) / 2
    fig.text(cx, header_y, cols[c], fontsize=11, fontweight='bold',
             color='#f0f6fc', ha='center', va='center',
             fontfamily='monospace')

# Header underline
line_y = header_y - row_h * 0.6
from matplotlib.patches import FancyBboxPatch
fig.patches.append(plt.Rectangle((0.02, line_y), 0.96, 0.002,
                                  transform=fig.transFigure, facecolor='#30363d',
                                  edgecolor='none', zorder=5))

# --- Draw rows ---
for r in range(n_rows):
    y = top_y - r * row_h
    day = r + 1
    vals = [f1[r], f2[r], f3[r]]

    # Alternating row background
    if r % 2 == 0:
        fig.patches.append(plt.Rectangle((0.02, y - row_h * 0.45), 0.96, row_h,
                                          transform=fig.transFigure,
                                          facecolor='#161b22', edgecolor='none', zorder=0))

    # Day number
    cx = (x_starts[0] + x_ends[0]) / 2
    fig.text(cx, y, str(day), fontsize=11, color='#8b949e',
             ha='center', va='center', fontfamily='monospace', fontweight='bold')

    # Value cells with inline bar
    for c_idx in range(3):
        col = c_idx + 1
        val = vals[c_idx]
        frac = val / col_maxes[c_idx]

        # Background bar
        bar_x = x_starts[col] + 0.005
        bar_max_w = (x_ends[col] - x_starts[col]) - 0.01
        bar_w = bar_max_w * frac
        bar_color = palettes[col][1]

        fig.patches.append(plt.Rectangle(
            (bar_x, y - row_h * 0.38), bar_w, row_h * 0.76,
            transform=fig.transFigure, facecolor=bar_color,
            edgecolor='none', alpha=0.5, zorder=1
        ))

        # Text value
        formatted = f'{val:,.0f}'
        tx = x_starts[col] + 0.015
        fig.text(tx, y, formatted, fontsize=10.5, color=text_colors[col],
                 ha='left', va='center', fontfamily='monospace', fontweight='bold',
                 zorder=10)

        # Percentage of pool
        pct = val / POOL * 100
        px = x_ends[col] - 0.015
        fig.text(px, y, f'{pct:.1f}%', fontsize=9, color=text_colors[col],
                 ha='right', va='center', fontfamily='monospace', alpha=0.5,
                 zorder=10)

# --- Phase separators ---
for phase_end in [5, 10, 15]:
    sep_y = top_y - phase_end * row_h + row_h * 0.5
    fig.patches.append(plt.Rectangle((0.02, sep_y), 0.96, 0.001,
                                      transform=fig.transFigure,
                                      facecolor='#484f58', edgecolor='none', zorder=5))

# Phase labels
phase_labels = [
    (2.5, 'Days 1-5'),
    (7.5, 'Days 6-10'),
    (12.5, 'Days 11-15'),
    (17.5, 'Days 16-20'),
]
for row_mid, label in phase_labels:
    ly = top_y - row_mid * row_h
    fig.text(0.005, ly, label, fontsize=7, color='#484f58', rotation=90,
             ha='center', va='center', fontfamily='monospace', fontstyle='italic')

# --- Title ---
fig.text(0.50, 0.995, 'Daily Reward Comparison — Memeland Staking',
         fontsize=16, fontweight='bold', color='#f0f6fc', ha='center', va='top',
         fontfamily='monospace')
fig.text(0.50, 0.975, 'Pool: 200M total  |  133.33M rewards  |  20-day staking period',
         fontsize=10, color='#8b949e', ha='center', va='top', fontfamily='monospace')

# --- Summary footer ---
footer_y = top_y - DAYS * row_h - 0.02
fig.patches.append(plt.Rectangle((0.02, footer_y - 0.035), 0.96, 0.001,
                                  transform=fig.transFigure,
                                  facecolor='#30363d', edgecolor='none', zorder=5))

summaries = [
    ('Total', f'{sum(f1):,.0f}', f'{sum(f2):,.0f}', f'{sum(f3):,.0f}'),
    ('D20/D1 Ratio', f'{f1[-1]/f1[0]:.2f}x', f'{f2[-1]/f2[0]:.2f}x', f'{f3[-1]/f3[0]:.2f}x'),
    ('Last 5 days %',
     f'{sum(f1[15:])/sum(f1)*100:.1f}%',
     f'{sum(f2[15:])/sum(f2)*100:.1f}%',
     f'{sum(f3[15:])/sum(f3)*100:.1f}%'),
]

for s_idx, (lbl, v1, v2, v3) in enumerate(summaries):
    sy = footer_y - 0.015 - s_idx * row_h
    cx = (x_starts[0] + x_ends[0]) / 2
    fig.text(cx, sy, lbl, fontsize=9, color='#8b949e', ha='center', va='center',
             fontfamily='monospace', fontstyle='italic')
    for c_idx, val_str in enumerate([v1, v2, v3]):
        col = c_idx + 1
        tx = (x_starts[col] + x_ends[col]) / 2
        fig.text(tx, sy, val_str, fontsize=10.5, color=text_colors[col],
                 ha='center', va='center', fontfamily='monospace', fontweight='bold')

out_path = os.path.join(os.path.dirname(__file__), 'reward-daily-table.png')
fig.savefig(out_path, dpi=180, bbox_inches='tight', facecolor=fig.get_facecolor(),
            pad_inches=0.3)
print(f'Table saved to: {out_path}')
