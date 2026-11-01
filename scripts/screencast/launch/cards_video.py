"""Silent 1920x1080 clip of published share cards (the real /a/<id>/card.png images, untouched, scaled).
Usage: python3 cards_video.py out.mp4 "Title" "kicker" card1.png "caption 1" [card2.png "caption 2" ...]"""
import sys, cv2, numpy as np
from PIL import Image, ImageDraw
import os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render_video import W, H, FPS, INK, MUTED, DIM, f, SF, card, mark, GOLD
out, title, kicker, rest = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
pairs = list(zip(rest[0::2], rest[1::2]))
def shot(path, cap):
    im = Image.new('RGB', (W, H), INK); d = ImageDraw.Draw(im)
    mark(d, 92, 70, 40, GOLD, 2); d.text((124, 70), 'AGGREGATE', font=f(SF, 20), fill=MUTED, anchor='lm')
    c = Image.open(path).convert('RGB'); k = min(1440 / c.width, 820 / c.height)
    c = c.resize((int(c.width * k), int(c.height * k)), Image.LANCZOS)
    im.paste(c, ((W - c.width) // 2, 150 + (820 - c.height) // 2))
    d.text((W // 2, 1020), cap, font=f(SF, 30), fill=MUTED, anchor='mm')
    d.text((W // 2, 108), 'Made-up company · synthetic data', font=f(SF, 22), fill=DIM, anchor='mm')
    return im
frames = []
def hold(im, s): frames.extend([np.array(im)[:, :, ::-1]] * int(s * FPS))
def fade(a, b, s=0.5):
    A, B = np.array(a).astype(np.float32), np.array(b).astype(np.float32)
    n = int(s * FPS)
    for i in range(n): frames.append((A + (B - A) * (i + 1) / n).astype(np.uint8)[:, :, ::-1])
seq = [card([title], kicker)] + [shot(p, c) for p, c in pairs] + [card(['Ask your AI about', 'your finances.'], 'aggregate.finance  ·  open source  ·  it can never move money')]
holds = [3.0] + [5.5] * len(pairs) + [3.5]
for i, im in enumerate(seq):
    if i: fade(seq[i - 1], im)
    hold(im, holds[i])
w = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*'avc1'), FPS, (W, H))
for fr in frames: w.write(fr)
w.release(); print(out, round(len(frames) / FPS, 1), 's')
