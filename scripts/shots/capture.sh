#!/usr/bin/env bash
# scripts/shots/capture.sh — render plain-text program output as a PNG screenshot.
#
# Usage: scripts/shots/capture.sh <output.png> <log.txt>
#
# (The log is passed as a file rather than piped on stdin, because the Python
# heredoc below needs stdin for its source text.)
#
# The program output being captured is never fabricated or replayed: capture.sh
# is only a typesetting step over a log file produced by a real command run.
# The screenshots it produces are committed to docs/screenshots/ and embedded
# in the README.
#
# Requires Python 3 with Pillow (pip install pillow). The font is the monospace
# variant of DejaVu Sans, which ships with Pillow and with most Linux images;
# any installed monospace TTF works.

set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 <output.png> <log.txt>" >&2
  exit 2
fi

OUT=$1
LOG=$2
mkdir -p "$(dirname "$OUT")"

python3 - "$OUT" "$LOG" <<'PY'
import glob
import os
import sys

from PIL import Image, ImageDraw, ImageFont

out, log_path = sys.argv[1], sys.argv[2]
with open(log_path, encoding="utf-8") as fh:
    text = fh.read().replace("\t", "    ")
lines = text.rstrip("\n").split("\n")

# ── font ──────────────────────────────────────────────────────────────────────
CANDIDATES = (
    glob.glob(os.path.expanduser(
        "~/.local/lib/python*/site-packages/PIL/fonts/DejaVuSansMono-Bold.ttf"))
    + glob.glob("/usr/share/fonts/**/DejaVuSansMono-Bold.ttf", recursive=True)
    + glob.glob("/usr/share/fonts/**/DejaVuSansMono.ttf", recursive=True)
    + glob.glob("/usr/share/fonts/**/*.ttf", recursive=True)
    + glob.glob(os.path.expanduser(
        "~/.local/lib/python*/site-packages/PIL/fonts/DejaVuSans.ttf"))
)
font_path = next((p for p in CANDIDATES if os.path.exists(p)), None)
font = ImageFont.truetype(font_path, 15) if font_path else ImageFont.load_default()

def width(sample: str) -> int:
    bbox = font.getbbox(sample)
    return bbox[2] - bbox[0]

# Per-character advance of the monospace face; add a safety margin of one char.
CHAR_W = width("mmmmmmmmmm") // 10 + 1
LINE_H = font.getbbox("Ag")[3] + 8
PADDING = 28
GUTTER = 56  # room for the terminal-window decoration

cols = max((len(l) for l in lines), default=0)
rows = len(lines)

W = PADDING * 2 + GUTTER + max(1, cols) * CHAR_W
H = PADDING * 2 + 12 + rows * LINE_H

# ── palette (one-dark terminal colours) ───────────────────────────────────────
BG = (30, 32, 38)
TITLE_BG = (21, 23, 27)
FG = (172, 180, 190)
TITLE_FG = (140, 148, 158)
DOT_RED = (224, 108, 117)
DOT_YELLOW = (229, 192, 123)
DOT_GREEN = (152, 195, 121)
ACCENT = (97, 175, 239)      # the npm command banner
OK_GREEN = (152, 195, 121)   # ✓ / ✅ lines
ACCENT2 = (198, 120, 221)    # '>' prompt markers

img = Image.new("RGB", (W, H), BG)
draw = ImageDraw.Draw(img)

# terminal window chrome
draw.rounded_rectangle((0, 0, W, 12 + 36), radius=10, fill=TITLE_BG)
draw.rectangle((0, 36, W, 12 + 36), fill=TITLE_BG)
draw.rounded_rectangle((0, 0, W, H), radius=10, outline=(50, 54, 62), width=2)
for i, colour in enumerate((DOT_RED, DOT_YELLOW, DOT_GREEN)):
    cy = 24
    cx = 24 + i * 22
    draw.ellipse((cx - 7, cy - 7, cx + 7, cy + 7), fill=colour)

def is_ok(line: str) -> bool:
    s = line.lstrip()
    return s.startswith(("✓", "✅", "✔"))

def colour_for(line: str) -> tuple:
    s = line.strip()
    if is_ok(line):
        return OK_GREEN
    if s.startswith(">") or s.startswith("npm run") or s.startswith("compact "):
        return ACCENT
    return FG

x0 = PADDING
y = 12 + 36 + 14
for line in lines:
    line = line.rstrip()
    draw.text((x0, y), line, font=font, fill=colour_for(line))
    y += LINE_H

img.save(out, "PNG")
print(f"wrote {out} ({W}x{H}, {rows} lines, font={os.path.basename(font_path) if font_path else 'default'})")
PY
