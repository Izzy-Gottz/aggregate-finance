"""Render a recorded Claude run (record.py's timeline.json) into a silent 1920x1080 H.264 clip for X/LinkedIn.
Everything shown is verbatim from the recording: the question, the Aggregate tool calls, and the answer as it streamed.
Waits are shortened; nothing is reordered or edited. Synthetic demo data only.
Usage: python3 render_video.py timeline.json out.mp4 "Kicker caption" ["footnote"]"""
import json, sys, textwrap
import cv2, numpy as np
from PIL import Image, ImageDraw, ImageFont

W, H, FPS = 1920, 1080, 30
INK, CREAM, MUTED, DIM, GOLD, PANEL, RULE, BUBBLE = (15, 14, 13), (233, 226, 212), (138, 132, 122), (94, 89, 82), (200, 179, 138), (23, 21, 19), (42, 39, 36), (42, 39, 36)
SF = '/System/Library/Fonts/SFNS.ttf'
NY = '/System/Library/Fonts/NewYork.ttf'
MONO = '/System/Library/Fonts/SFNSMono.ttf'
f = lambda p, s: ImageFont.truetype(p, s)
F_Q, F_ANS, F_TOOL, F_RES, F_CAP, F_TITLE, F_SMALL = f(SF, 34), f(SF, 31), f(MONO, 25), f(MONO, 21), f(SF, 26), f(NY, 76), f(SF, 28)
PX0, PX1, PY0, PY1 = 200, 1720, 140, 990   # chat panel
PAD = 52

def mark(d, cx, cy, s, col=GOLD, w=3):
    top = (cx, cy - s * .38)
    for x in (-.34, -.17, 0, .17, .34):
        d.line([top, (cx + x * s, cy + s * .38)], fill=col, width=w)

def wrap(d, text, font, width):
    out = []
    for para in text.split('\n'):
        words, cur = para.split(' '), ''
        for w in words:
            t = (cur + ' ' + w).strip()
            if d.textlength(t, font=font) <= width: cur = t
            else: out.append(cur); cur = w
        out.append(cur)
    return out

def base(caption=None, foot=None):
    im = Image.new('RGB', (W, H), INK); d = ImageDraw.Draw(im)
    mark(d, 92, 70, 40, GOLD, 2)
    d.text((124, 70), 'AGGREGATE', font=f(SF, 20), fill=MUTED, anchor='lm')
    if caption: d.text((W // 2, 92), caption, font=F_CAP, fill=MUTED, anchor='mm')
    if foot: d.text((W // 2, 1030), foot, font=f(SF, 22), fill=DIM, anchor='mm')
    d.rounded_rectangle([PX0, PY0, PX1, PY1], 22, fill=PANEL, outline=RULE, width=2)
    return im, d

def chat(state, caption, foot):
    im, d = base(caption, foot)
    y = PY0 + PAD
    q = state['q']
    if q:
        tw = min(d.textlength(q, font=F_Q), PX1 - PX0 - 2 * PAD - 60)
        lines = wrap(d, q, F_Q, tw + 2)
        bh = 48 * len(lines) + 30
        d.rounded_rectangle([PX1 - PAD - tw - 52, y, PX1 - PAD, y + bh], 26, fill=BUBBLE)
        for i, l in enumerate(lines): d.text((PX1 - PAD - tw - 26, y + 15 + i * 48), l, font=F_Q, fill=CREAM)
        y += bh + 36
    rows = []
    for kind, text in state['steps']:
        if kind == 'tool': rows.append((F_TOOL, GOLD, '●  aggregate · ' + text, 40))
        else: rows.append((F_RES, DIM, '   └ ' + (text[:96] + '…' if len(text) > 97 else text), 40))
    for font, col, t, lh in rows:
        d.text((PX0 + PAD, y), t, font=font, fill=col); y += lh
    if rows: y += 22
    if state['answer']:
        fa, lh = state.get('font', (F_ANS, 46))
        for para in state['answer'].split('\n'):
            for l in wrap(d, para, fa, PX1 - PX0 - 2 * PAD):
                if y + lh > PY1 - 20: break
                d.text((PX0 + PAD, y), l, font=fa, fill=CREAM); y += lh
            y += lh // 3
    return im

def card(lines, sub=None):
    im = Image.new('RGB', (W, H), INK); d = ImageDraw.Draw(im)
    mark(d, W // 2, 330, 150, GOLD, 4)
    for i, l in enumerate(lines): d.text((W // 2, 540 + i * 92), l, font=F_TITLE, fill=CREAM, anchor='mm')
    if sub: d.text((W // 2, 560 + len(lines) * 92), sub, font=F_SMALL, fill=MUTED, anchor='mm')
    return im

def build(tl, kicker, foot):
    frames = []
    def hold(im, secs): frames.extend([np.array(im)[:, :, ::-1]] * max(1, int(secs * FPS)))
    hold(card([tl.get('title', tl['prompt'])], kicker), 3.0)
    st = {'q': '', 'steps': [], 'answer': ''}
    cap = 'A real Claude run through Aggregate · made-up companies'
    hold(chat(st, cap, foot), 0.6)
    q = tl['prompt']
    for i in range(1, len(q) + 1, 2):
        st['q'] = q[:i]; hold(chat(st, cap, foot), 1 / FPS * 2)
    st['q'] = q; hold(chat(st, cap, foot), 1.0)
    cap2 = 'Aggregate answers from one ledger, reconciled to the cent'
    ntools = sum(1 for e in tl['events'] if e['kind'] == 'tool')
    for ev in tl['events']:
        if ev['kind'] == 'tool':
            name = ev['text'].replace('aggregate - ', '').replace(' (MCP)', '')
            tools = [s for s in st['steps'] if s[0] == 'tool']
            if tools and tools[-1][1].split(' ×')[0] == name and st['steps'][-1][0] == 'tool':
                n = int(tools[-1][1].split(' ×')[1]) + 1 if ' ×' in tools[-1][1] else 2
                st['steps'][-1] = ('tool', f'{name} ×{n}')
            else:
                st['steps'].append(('tool', name))
            hold(chat(st, cap2, foot), 0.9)
        elif ev['kind'] == 'result' and st['steps'] and ev['text'] and ntools <= 3:
            st['steps'].append(('result', ev['text'])); hold(chat(st, cap2, foot), 0.9)
    text = ''.join(e['text'] for e in tl['events'] if e['kind'] == 'text').strip()
    # largest answer font that fits the whole final answer under the tool lines
    probe = ImageDraw.Draw(Image.new('RGB', (10, 10)))
    used = PY0 + PAD + 120 + 40 * len(st['steps']) + 22
    for size in (38, 36, 34, 32, 30, 28, 26):
        fa, lh = f(SF, size), int(size * 1.42)
        n = sum(len(wrap(probe, p, fa, PX1 - PX0 - 2 * PAD)) for p in text.split('\n'))
        if used + n * lh + (text.count('\n') + 1) * (lh // 3) <= PY1 - 20: break
    st['font'] = (fa, lh)
    step = 6
    for i in range(step, len(text) + step, step):
        st['answer'] = text[:i]; hold(chat(st, None, foot), 1 / FPS * 2)
    hold(chat(st, None, foot), max(6.0, len(text) / 60))
    hold(card(['Ask your AI about', 'your finances.'], 'aggregate.finance  ·  open source  ·  it can never move money'), 3.5)
    return frames

if __name__ == '__main__':
    tl = json.load(open(sys.argv[1]))
    kicker = sys.argv[3] if len(sys.argv) > 3 else ''
    foot = sys.argv[4] if len(sys.argv) > 4 else None
    frames = build(tl, kicker, foot)
    w = cv2.VideoWriter(sys.argv[2], cv2.VideoWriter_fourcc(*'avc1'), FPS, (W, H))
    for fr in frames: w.write(fr)
    w.release()
    print(sys.argv[2], round(len(frames) / FPS, 1), 's')
