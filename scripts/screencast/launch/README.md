# Launch videos and Product Hunt gallery

Synthetic demo data only. Never point these at a real workspace.

**Videos** (silent, 1920×1080 H.264, 30–60 s). Each one replays a real Claude Code run: the question, Aggregate's tool
calls and the answer exactly as they streamed. Waits are shortened; nothing is reordered or edited.

```sh
# 1. Record a run with a read-only key on the demo workspace (recorder: scripts/screencast/readme-gif/record.py)
AGFN_DEMO_KEY=agfn_live_… python3 -I ../readme-gif/record.py https://<demo>/mcp "What's our runway?"
# 2. Optional: add a title card line to timeline.json ("title": "Runway, with two new hires")
# 3. Render
python3 render_video.py timeline.json runway.mp4 "One question to Claude" "Made-up companies · synthetic data"
```

Needs Python with Pillow and OpenCV (`opencv-python`; its FFmpeg build writes H.264 as `avc1`).

**Gallery** (6 slides, 1270×760). `python3 gallery.py [hero.json]` writes HTML and PNGs next to the script (copy it to
a scratch folder first, with `how-it-works-ink.png` beside it). `hero.json` is `{"q", "tools", "answer", "foot"}`
taken from a real run's timeline.json. Needs Google Chrome for headless rendering.

Drafts live in `docs/launch/assets/ph/`; the plan and status of each video are in `docs/launch/videos.md`.
