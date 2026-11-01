"""Run a real Claude Code session against ONLY the demo Aggregate MCP server and save timeline.json for render.py.

Usage: AGFN_DEMO_KEY=agfn_live_... python record.py https://<staging>/mcp "How much cash do we have?"
Runs in an empty folder with --strict-mcp-config (no user-level MCP servers, so never the real workspace),
--setting-sources project (nothing to load there) and --no-session-persistence. The key is passed through the
environment into a temporary MCP config that is deleted afterwards.
"""
import json, os, subprocess, sys, tempfile, time

url, prompt = sys.argv[1], sys.argv[2]
key = os.environ['AGFN_DEMO_KEY']
work = tempfile.mkdtemp(prefix='agfn-gif-')
cfg = os.path.join(work, 'mcp.json')
with open(cfg, 'w') as f:
    json.dump({'mcpServers': {'aggregate': {'type': 'http', 'url': url,
                                            'headers': {'Authorization': f'Bearer {key}'}}}}, f)
os.chmod(cfg, 0o600)
cmd = ['claude', '-p', prompt,
       '--strict-mcp-config', '--mcp-config', cfg,
       '--setting-sources', 'project', '--no-session-persistence',
       '--allowedTools', 'mcp__aggregate',
       '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
       '--append-system-prompt',
       'Answer in at most 5 short lines of plain text: no markdown tables, no headings, no bold.']
t0 = time.time()
events, raw = [], []
try:
    p = subprocess.Popen(cmd, cwd=work, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    for line in p.stdout:
        t = round(time.time() - t0, 3)
        raw.append(line)
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get('type') == 'stream_event':
            e = ev.get('event', {})
            if e.get('type') == 'content_block_delta' and e.get('delta', {}).get('type') == 'text_delta':
                events.append({'t': t, 'kind': 'text', 'text': e['delta']['text']})
        elif ev.get('type') == 'assistant':
            for b in ev['message'].get('content', []):
                if b.get('type') == 'tool_use':
                    name = b['name']
                    if not name.startswith('mcp__aggregate__'): continue  # Claude Code's own housekeeping (e.g. ToolSearch)
                    name = name.replace('mcp__aggregate__', '')
                    events.append({'t': t, 'kind': 'tool', 'text': f'aggregate - {name} (MCP)'})
        elif ev.get('type') == 'user':
            for b in ev['message'].get('content', []):
                if b.get('type') == 'tool_result':
                    c = b.get('content')
                    text = c if isinstance(c, str) else ' '.join(x.get('text', '') for x in (c or []) if isinstance(x, dict))
                    events.append({'t': t, 'kind': 'result', 'text': ' '.join(text.split())[:180]})
    p.wait()
    err = p.stderr.read()
finally:
    os.remove(cfg)
json.dump({'prompt': prompt, 'events': events}, open('timeline.json', 'w'), indent=1)
open('raw.jsonl', 'w').writelines(raw)
print('exit', p.returncode, 'events', len(events), 'seconds', round(time.time() - t0, 1))
if err.strip():
    print('stderr:', err[-600:])
