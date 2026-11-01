"""Render a recorded Claude Code session (timeline.json) into a terminal-style GIF.

timeline.json: {"prompt": str, "events": [{"t": seconds, "kind": "tool", "text": str}
                                          | {"t": seconds, "kind": "result", "text": str}
                                          | {"t": seconds, "kind": "text", "text": str}]}
Text events carry the answer as it arrived; everything shown is verbatim from the recording.
Long waits are shortened (MAX_WAIT) so the clip stays near 10 seconds; nothing is reordered.
"""
import json, sys, textwrap
from PIL import Image, ImageDraw, ImageFont

W, H = 1600, 680
PAD = 56
BG, PANEL, INK, MUTED, GOLD, DIM = (13, 17, 23), (22, 27, 34), (230, 226, 216), (139, 133, 123), (200, 179, 138), (90, 96, 104)
FONT = ImageFont.truetype('/System/Library/Fonts/SFNSMono.ttf', 26)
FONT_B = ImageFont.truetype('/System/Library/Fonts/SFNSMono.ttf', 26)
LINE = 40
COLS = 92
FPS = 12
MAX_WAIT = 1.0

def wrap(s, indent=''):
    out = []
    for para in s.split('\n'):
        if not para.strip():
            out.append('')
            continue
        out += textwrap.wrap(para, COLS - len(indent), subsequent_indent='', replace_whitespace=False) or ['']
    return out

def frame(lines, cursor=False):
    im = Image.new('RGB', (W, H), PANEL)
    d = ImageDraw.Draw(im)
    for i, c in enumerate([(237, 106, 94), (245, 191, 79), (98, 197, 84)]):
        d.ellipse([36 + i * 30, 34, 52 + i * 30, 50], fill=c)
    d.text((W // 2, 42), 'claude', font=FONT, fill=MUTED, anchor='mm')
    y = 92
    visible = lines[-((H - 150) // LINE):]
    for color, text in visible:
        d.text((PAD, y), text, font=FONT, fill=color)
        y += LINE
    if cursor:
        d.rectangle([PAD, y + 6, PAD + 14, y + 32], fill=MUTED)
    return im

def build(tl):
    frames, durs = [], []
    def push(lines, secs, cursor=False):
        frames.append(frame(lines, cursor)); durs.append(int(secs * 1000))
    lines = []
    prompt = tl['prompt']
    # typing the question
    for i in range(1, len(prompt) + 1, 2):
        push(lines + [(INK, '> ' + prompt[:i])], 0.05)
    lines.append((INK, '> ' + prompt))
    lines.append((INK, ''))
    push(lines, 0.6, cursor=True)
    last_t = tl['events'][0]['t'] if tl['events'] else 0
    answer = ''
    answer_start = None
    for ev in tl['events']:
        wait = min(MAX_WAIT, max(0.0, ev['t'] - last_t))
        last_t = ev['t']
        if ev['kind'] == 'tool':
            if wait: push(lines, wait, cursor=True)
            lines.append((GOLD, '● ' + ev['text']))
            push(lines, 0.5)
        elif ev['kind'] == 'result':
            if wait: push(lines, wait)
            r = ev['text']
            lines.append((DIM, '  └  ' + (r[:COLS - 8] + '…' if len(r) > COLS - 7 else r)))
            lines.append((INK, ''))
            push(lines, 0.5)
        elif ev['kind'] == 'text':
            if answer_start is None:
                answer_start = len(lines)
            answer += ev['text']
            body = wrap(answer)
            shown = [(INK, ('● ' if i == 0 else '  ') + l) for i, l in enumerate(body)]
            lines = lines[:answer_start] + shown
            push(lines, max(0.06, min(wait, 0.25)))
    push(lines, 3.0)
    return frames, durs

if __name__ == '__main__':
    tl = json.load(open(sys.argv[1]))
    frames, durs = build(tl)
    small = [f.resize((W // 2 * 2 // 2 * 1, H // 2 * 2 // 2 * 1)) if False else f for f in frames]
    ref = small[-1].quantize(colors=48, method=Image.Quantize.MEDIANCUT)
    pal = [f.quantize(palette=ref, dither=Image.Dither.NONE) for f in small]
    pal[0].save(sys.argv[2], save_all=True, append_images=pal[1:], duration=durs, loop=0, optimize=True, disposal=1)
    print(len(frames), 'frames', round(sum(durs) / 1000, 1), 's')
