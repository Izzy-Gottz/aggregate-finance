# README demo GIF

`.github/assets/demo.gif` is a real Claude Code session answering one question through Aggregate's MCP server, on a
demo account with made-up companies. To make a new one:

```sh
python3 -m venv /tmp/gifenv && /tmp/gifenv/bin/pip install pillow
export AGFN_DEMO_KEY=agfn_live_…   # a read-only key on a demo account; never a real workspace
/tmp/gifenv/bin/python record.py https://staging.aggregate.finance/mcp "How much cash do we have?"
/tmp/gifenv/bin/python render.py timeline.json demo.gif
```

`record.py` runs Claude Code in an empty folder with only that one MCP server (`--strict-mcp-config`), so it can't
reach any other workspace. `render.py` replays the recorded tool call and answer word for word; long waits are
shortened so the clip stays near 10 seconds. Check every frame for real names or figures before committing.
