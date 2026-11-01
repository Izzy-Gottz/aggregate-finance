"""Product Hunt gallery: 6 slides at 1270x760 (rendered at 2x, downscaled). Synthetic data only.
Usage: python3 build.py [hero.json]  (hero.json: {"q": question, "tools": [..], "answer": [lines]} from a real run)."""
import json, os, subprocess, sys
from PIL import Image

D = os.path.dirname(os.path.abspath(__file__))
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
MARK = '<svg viewBox="0 0 100 100" fill="none" stroke="#C8B38A" stroke-width="3" stroke-linejoin="round"><path d="M50 12V88M50 12 33 88M50 12 67 88M50 12 16 88M50 12 84 88"/></svg>'

CSS = """
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,300;1,400&family=Inter:wght@400;500&family=JetBrains+Mono:wght@400&display=swap');
*{box-sizing:border-box;margin:0}
html,body{width:1270px;height:760px;background:#0F0E0D;color:#E9E2D4;overflow:hidden}
body{font-family:Inter,system-ui,sans-serif;position:relative}
.brand{position:absolute;left:56px;top:44px;display:flex;align-items:center;gap:12px;color:#8A847A;font-size:12px;letter-spacing:.24em;text-transform:uppercase}
.brand svg{width:22px;height:22px}
.foot{position:absolute;left:56px;bottom:36px;color:#5E5952;font-size:13px;letter-spacing:.04em}
h1{font-family:'Cormorant Garamond',serif;font-weight:300;font-size:58px;line-height:1.05;letter-spacing:-.005em}
h1 i{color:#C8B38A;font-style:italic}
.sub{color:#8A847A;font-size:18px;line-height:1.5;margin-top:16px;max-width:520px}
.left{position:absolute;left:56px;top:120px;width:470px}
.right{position:absolute;right:56px;top:84px;width:640px}
.panel{background:#171513;border:1px solid #2A2724;border-radius:14px}
.mono{font-family:'JetBrains Mono',ui-monospace,monospace}
"""

def page(body):
    return f"<!doctype html><html><head><meta charset=utf-8><style>{CSS}</style></head><body>" \
           f"<div class=brand>{MARK}Aggregate</div>{body}</body></html>"

def hero(h):
    tools = ''.join(f'<div class="mono" style="color:#C8B38A;font-size:15px;margin:4px 0">● aggregate · {t}</div>' for t in h['tools'])
    ans = ''.join(f'<p style="margin:0 0 12px">{l}</p>' for l in h['answer'])
    return page(f"""
<div class=left><h1>Ask your AI about <i>your finances.</i></h1>
<p class=sub>Claude, ChatGPT or Cursor read one ledger of every account you have, reconciled to the cent.</p></div>
<div class="right panel" style="top:110px;padding:30px 34px;min-height:520px">
 <div style="display:flex;justify-content:flex-end;margin-bottom:22px"><div style="background:#2A2724;border-radius:16px;padding:12px 18px;font-size:18px">{h['q']}</div></div>
 {tools}
 <div style="font-size:17px;line-height:1.55;color:#E9E2D4;margin-top:18px">{ans}</div>
</div>
<div class=foot>{h.get('foot','A real run on the demo workspace: made-up companies, synthetic data.')}</div>""")

def sources():
    return page("""
<div style="position:absolute;left:56px;top:118px;width:1160px"><h1>Every source. <i>One ledger.</i></h1>
<p class=sub style="max-width:900px">Banks, cards, payment apps, accounting, invoices, payroll and your cap table, kept in one double-entry ledger your AI can read through one link.</p></div>
<img src="how-it-works-ink.png" style="position:absolute;left:105px;top:290px;width:1060px">""")

def transfer():
    row = lambda a, b, c, col='#E9E2D4': f'<div style="display:flex;justify-content:space-between;padding:14px 0;border-bottom:1px solid #2A2724;font-size:17px"><span>{a}</span><span style="color:#8A847A">{b}</span><span class=mono style="color:{col}">{c}</span></div>'
    return page(f"""
<div class=left><h1>Counted <i>once.</i></h1>
<p class=sub>A Stripe payout and the bank deposit it becomes are one event, not two. Aggregate matches them, so your AI never sees revenue twice.</p></div>
<div class="right" style="top:120px">
 <div style="color:#8A847A;font-size:13px;letter-spacing:.18em;text-transform:uppercase;margin-bottom:10px">Added up naively</div>
 <div class="panel" style="padding:6px 26px 14px">
  {row('Stripe payout', 'Stripe', '+$12,480.00')}
  {row('Deposit STRIPE TRANSFER', 'Chase', '+$12,480.00')}
  <div style="display:flex;justify-content:space-between;padding:16px 0 4px;font-size:18px"><span>Money in</span><span class=mono style="color:#D9776B">$24,960.00 ✕</span></div>
 </div>
 <div style="color:#8A847A;font-size:13px;letter-spacing:.18em;text-transform:uppercase;margin:30px 0 10px">In Aggregate</div>
 <div class="panel" style="padding:6px 26px 14px;border-color:#5C5240">
  {row('Payout → deposit, matched', 'Stripe → Chase', 'transfer', '#C8B38A')}
  <div style="display:flex;justify-content:space-between;padding:16px 0 4px;font-size:18px"><span>Money in</span><span class=mono style="color:#C8B38A">$12,480.00 ✓</span></div>
 </div>
</div>
<div class=foot>Example amounts.</div>""")

def audiences():
    card = lambda t, d: f'<div class=panel style="padding:30px 30px 34px"><div style="font-family:\'Cormorant Garamond\',serif;font-size:34px;font-weight:400;margin-bottom:12px">{t}</div><div style="color:#A39C90;font-size:17px;line-height:1.5">{d}</div></div>'
    return page(f"""
<div style="position:absolute;left:56px;top:110px"><h1>Built for <i>everyone with money in more than one place.</i></h1></div>
<div style="position:absolute;left:56px;right:56px;top:250px;display:grid;grid-template-columns:1fr 1fr;gap:20px">
 {card('Founders', 'Several companies side by side, and what each one owes you.')}
 {card('Businesses', 'Banks, cards, payments, invoices, bills and payroll in one ledger.')}
 {card('Investors', 'Your holdings, and the stakes you hold in companies.')}
 {card('Individuals', 'Just your own accounts, cards and cash, in a private space.')}
</div>""").replace('top:110px"><h1>', 'top:110px;width:1100px"><h1 style="font-size:52px">')

def setup():
    step = lambda n, t, d: f'<div class=panel style="padding:28px 30px;min-height:300px"><div class=mono style="color:#C8B38A;font-size:15px;margin-bottom:18px">{n}</div><div style="font-family:\'Cormorant Garamond\',serif;font-size:32px;margin-bottom:14px">{t}</div><div style="color:#A39C90;font-size:16px;line-height:1.55">{d}</div></div>'
    return page(f"""
<div style="position:absolute;left:56px;top:118px"><h1>Set up in <i>two minutes.</i></h1></div>
<div style="position:absolute;left:56px;right:56px;top:290px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px">
 {step('01', 'Sign up', 'Hosted at app.aggregate.finance, free during early access. Or self-host it with Docker.')}
 {step('02', 'Connect accounts', 'Banks, cards, payment apps, accounting and payroll. Aggregate only reads from them.')}
 {step('03', 'Add it to your AI', 'Paste one link into Claude, ChatGPT or Cursor:<div class=mono style="color:#E9E2D4;font-size:14px;margin-top:12px;background:#0F0E0D;border:1px solid #2A2724;border-radius:8px;padding:10px 12px">app.aggregate.finance/mcp</div>')}
</div>
<div class=foot>Then choose exactly what that AI can see, in one plain sentence.</div>""")

def trust():
    item = lambda t, d: f'<div style="padding:15px 0;border-bottom:1px solid #2A2724"><div style="font-size:18px;margin-bottom:4px">{t}</div><div style="color:#8A847A;font-size:15px;line-height:1.45">{d}</div></div>'
    return page(f"""
<div class=left style="width:430px"><h1>It can read your bank. <i>It can’t move a dollar.</i></h1></div>
<div class="right" style="top:96px;width:660px">
 {item('Never moves money', 'No payments, no bills paid, no invoices or emails sent.')}
 {item('It only reads', 'Aggregate only calls read endpoints. Bank logins go through Plaid and are never seen by Aggregate.')}
 {item('Each AI gets its own permission', 'Which companies, which data, read or add, and when it expires. Checked on every call.')}
 {item('Everything is logged', 'Every question and every record an AI adds. Undo for 30 days, pause or revoke in one click.')}
 {item('Open source, self-hostable', 'AGPL-3.0. The hosted version runs the same code.')}
</div>""")

def render(name, html):
    p = os.path.join(D, name + '.html'); open(p, 'w').write(html)
    big = os.path.join(D, name + '@2x.png')
    subprocess.run([CHROME, '--headless=new', '--hide-scrollbars', f'--user-data-dir={D}/chrome',
                    '--force-device-scale-factor=2', '--window-size=1270,760', '--virtual-time-budget=6000',
                    f'--screenshot={big}', 'file://' + p], capture_output=True, timeout=120)
    Image.open(big).convert('RGB').resize((1270, 760), Image.LANCZOS).save(os.path.join(D, name + '.png'), optimize=True)
    print('rendered', name)

if __name__ == '__main__':
    h = json.load(open(sys.argv[1])) if len(sys.argv) > 1 else {
        'q': "What's our runway?", 'tools': ['get_overview', 'get_metric'],
        'answer': ['[PLACEHOLDER: replaced by a real run on the public demo]'], 'foot': 'DRAFT: placeholder answer'}
    for name, html in [('1-hero', hero(h)), ('2-sources', sources()), ('3-counted-once', transfer()),
                       ('4-who', audiences()), ('5-setup', setup()), ('6-trust', trust())]:
        render(name, html)
