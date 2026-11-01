import os, sys
ROOT = sys.argv[1]
LANGROW = '<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português (Brasil)</a> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a></p>'

T = '''<p align="center">
  <a href="https://aggregate.finance">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
      <img alt="Aggregate" src=".github/assets/logo-light.svg" width="380">
    </picture>
  </a>
</p>

<h3 align="center">{headline}</h3>

<p align="center">
  {sub1}<br>
  {sub2}<br>
  {sub3}
</p>

<p align="center">
  <a href="https://aggregate.finance"><b>{nav_site}</b></a> ·
  <a href="#get-started"><b>{nav_start}</b></a> ·
  <a href="#run-it-yourself"><b>{nav_self}</b></a> ·
  <a href="#safety"><b>{nav_safety}</b></a> ·
  <a href="docs/connect-your-ai.md"><b>{nav_docs}</b></a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-C8B38A?style=flat-square&labelColor=0F0E0D"></a>
  <a href="#get-started"><img alt="MCP: remote and local" src="https://img.shields.io/badge/MCP-remote%20%2B%20local-C8B38A?style=flat-square&labelColor=0F0E0D"></a>
  <a href="#run-it-yourself"><img alt="Self-host with Docker" src="https://img.shields.io/badge/self--host-Docker-C8B38A?style=flat-square&labelColor=0F0E0D"></a>
</p>

LANGROW

> [!NOTE]
> {lag}

<p align="center">
  <img alt="{gif_alt}" src=".github/assets/demo.gif" width="860">
</p>

<table>
<tr><td><b>{faq1q}</b></td><td>{faq1a}</td></tr>
<tr><td><b>{faq2q}</b></td><td>{faq2a}</td></tr>
<tr><td><b>{faq3q}</b></td><td>{faq3a}</td></tr>
<tr><td><b>{faq4q}</b></td><td>{faq4a}</td></tr>
</table>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/how-it-works-dark.png">
    <img alt="{diagram_alt}" src=".github/assets/how-it-works-light.png" width="860">
  </picture>
</p>

## {h_who}

|  |  |
|---|---|
| **{founders}** | {founders_d} |
| **{business}** | {business_d} |
| **{investors}** | {investors_d} |
| **{individuals}** | {individuals_d} |

## {h_ask}

{ask_intro}

> *{q1}*
>
> *{q2}*
>
> *{q3}*
>
> *{q4}*
>
> *{q5}*
>
> *{q6}*

{ask_outro}

<a id="get-started"></a>
## {h_start}

|  | **{hosted}** | **{selfhost}** |
|---|---|---|
| **{r_where}** | app.aggregate.finance | {r_where_s} |
| **{r_conn}** | {r_conn_h} | {r_conn_s} |
| **{r_backup}** | {r_backup_h} | {r_backup_s} |
| **{r_cost}** | {r_cost_h} | {r_cost_s} |
| **{r_start}** | [{signup}](https://app.aggregate.finance){r_start_h} | [{nav_self}](#run-it-yourself) |

## {h_connect}

| AI | {how} |
|---|---|
| **Claude Code** | `claude mcp add --transport http agfn https://app.aggregate.finance/mcp` |
| **Cursor, VS Code, Windsurf, Claude Code** | `npx aggregate-finance setup` ({setup_note}) |
| **Claude** | {claude_how} |
| **ChatGPT** | {chatgpt_how} |

{link_intro}

```
https://app.aggregate.finance/mcp
```

{connect_outro}

## {h_connects}

|  |  |
|---|---|
| **{c_banks}** | {c_banks_d} |
| **{c_pay}** | Stripe, Square, Shopify, Paddle, App Store, Google Play · PayPal, Lemon Squeezy, Polar ({selfonly}) |
| **{c_acct}** | QuickBooks, Xero |
| **{c_payroll}** | {c_payroll_d} |
| **{c_cap}** | {c_cap_d} |
| **{c_else}** | {c_else_d} |
| **{c_soon}** | {c_soon_d} |

{connects_outro}

> [!NOTE]
> {early}

<a id="safety"></a>
## {h_safety}

- **{s1}** {s1d}
- **{s2}** {s2d}
- **{s3}** {s3d}
- **{s4}** {s4d}
- **{s5}** {s5d}
- **{s6}** {s6d}

<a id="run-it-yourself"></a>
## {h_run}

{run_intro}

```sh
git clone https://github.com/Izzy-Gottz/aggregate-finance && cd aggregate-finance
(umask 077; printf 'AUTH_SECRET=%s\\nAGFN_MASTER_KEY=%s\\n' "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" > .env)
docker compose up -d         # http://localhost:8787
```

**{run_warn}** {run_warn_d} {run_guide} [{selfhosting}](docs/self-hosting.md).

{full_list}

## {h_license}

{license}
'''

L = {}
L['zh-CN'] = dict(
 early='Aggregate 还处于早期阶段。在托管版上，Plaid、Stripe 登录和 Shopify 应用正在等待各服务商审批；在此之前，银行可通过 SimpleFIN Bridge 或对账单连接，Shopify 可使用你自己应用的密钥。其他连接器按各服务商的文档开发，正在用真实账户验证。欢迎提交问题和修复。',
 headline='问问你的 AI，你的财务状况如何。',
 sub1='一个带 MCP 服务器的开源复式记账账本。', sub2='所有账户、公司和持仓，汇成一个链接，交给 Claude、ChatGPT 或你自己的智能体。', sub3='精确对账到每一分钱，而且你的 AI 永远无法动用资金。',
 nav_site='官网', nav_start='开始使用', nav_self='自行部署', nav_safety='安全', nav_docs='文档',
 lag='本译文可能落后于英文版 README，请以英文版为准。',
 gif_alt='在 Claude Code 中提问“我们有多少现金？”，它调用 Aggregate 的 get_overview 工具，给出每家公司的现金和总额。',
 faq1q='Aggregate 能看到我的银行密码吗？', faq1a='不能。你通过 Plaid 登录银行，其他应用则在各自的页面登录。Aggregate 拿到的令牌用存放在数据库之外的密钥加密，并且只用于读取。',
 faq2q='我的数据会被用来训练 AI 模型吗？', faq2a='不会。Aggregate 从不用你的数据训练模型，也不允许任何人这样做。你的 AI 读取的内容，适用你所用 AI 服务商自己的政策。',
 faq3q='它能动用资金吗？', faq3a='永远不能。没有任何工具或连接可以付款、转账、支付账单或发送任何东西。', faq4q='现金、烧钱率和资金跑道是怎么算的？', faq4a='每次都用同一种算法。每个数字由 Aggregate 按一条写明的<a href="docs/guides/definitions.md">定义</a>（英文）计算，而不是由你的 AI 计算；算不出时会说“未知”，不会去猜。',
 diagram_alt='银行、支付应用、会计、发票、薪资、股权结构表和收据都汇入 Aggregate，再通过一个链接提供给 Claude、ChatGPT、Cursor 和你自己的智能体。',
 h_who='适合谁', founders='创始人', founders_d='多家公司并排查看，以及每家公司欠你多少', business='企业', business_d='银行、信用卡、收款、发票、账单和薪资，都在一个账本里', investors='投资人', investors_d='你的持仓，以及你在各公司持有的股份', individuals='个人', individuals_d='只有你自己的账户、信用卡和现金，放在私人空间里',
 h_ask='你可以问什么', ask_intro='连接好之后，直接问：',
 q1='“我们所有公司加起来有多少现金，还能撑几个月？”', q2='“哪些发票逾期了，谁欠我们最多？”', q3='“我的投资表现怎么样？”', q4='“我的个人账户里现在有多少钱？”', q5='“我替 Harbor Coffee 用现金付了承包商 500 美元，记一笔。”', q6='“每家公司个人欠我多少？”',
 ask_outro='更多示例见[提示词食谱](docs/recipes.md)（英文）。思考交给你的 AI，Aggregate 负责底层数字准确：每笔付款只算一次，余额与银行核对，每条记录都能追溯到来源。',
 h_start='开始使用', selfonly='自行部署时可用', hosted='托管版（约 2 分钟）', selfhost='自行部署（约 10 分钟）',
 r_where='运行在哪里', r_where_s='你自己的电脑或服务器，用 Docker 或 Node', r_conn='连接', r_conn_h='为你配置好', r_conn_s='使用你自己的服务商密钥，或上传对账单', r_backup='备份和更新', r_backup_h='为你完成', r_backup_s='你自己负责', r_cost='费用', r_cost_h='早期体验期间免费', r_cost_s='免费（AGPL-3.0）', r_start='开始', signup='注册', r_start_h='，然后按下方步骤连接你的 AI',
 h_connect='连接你的 AI', how='方法', setup_note='先显示会改动什么；加上 `--yes` 才会写入', claude_how='设置 → 连接器 → **添加自定义连接器** → 粘贴下面的链接', chatgpt_how='把它添加为连接器，并粘贴下面的链接',
 link_intro='或者把这个链接复制到任何支持 MCP 的 AI 中：', connect_outro='登录后，用一句通俗的话精确选择这个 AI 能看到什么。如果是自己部署的服务器，请改用 `https://<你的服务器>/mcp`。',
 h_connects='能连接什么', c_banks='银行和信用卡', c_banks_d='通过 Plaid 或 SimpleFIN Bridge 连接任何银行或信用卡，另可直连 Mercury、Brex、Ramp 和 Wise', c_pay='收款', c_acct='会计', c_payroll='薪资', c_payroll_d='Finch、Deel，以及从银行数据中识别出的 Gusto 类薪资', c_cap='股权结构表', c_cap_d='内置，支持从 Carta 和 Pulley 导入，以及 Open Cap Table Format', c_else='其他一切', c_else_d='对账单（CSV、OFX、QFX、QBO）、收据的 PDF 和照片、通过邮件发来的账单，或者直接告诉你的 AI', c_soon='即将推出', c_soon_d='BILL、Rippling 和 Justworks：已开发完成，正在用真实账户测试',
 connects_outro='Aggregate 只会从你的服务商读取数据，没有任何办法转移资金。你拥有的每家公司并排存在，另外还有一个私人的**个人**空间。',
 h_safety='安全', s1='你的 AI 永远无法动用资金。', s1d='不付款，不支付账单，不发送发票或邮件。永远不会。', s2='每个 AI 都有自己的权限，', s2d='写成一句你能读懂的话：哪些公司、哪些数据、只读还是可读可添加、何时过期。每次请求都会检查。', s3='一切都有记录，都能撤销。', s3d='AI 的每个问题和添加的每条记录都会标明来源。30 天内可撤销，也可以开启审核，让 AI 的改动等你确认。一键暂停或撤销任何 AI。', s4='你的密钥始终加密。', s4d='服务商令牌用存放在数据库之外的密钥加密（支持 KMS 和 1Password）。银行登录经由 Plaid，Aggregate 永远看不到。', s5='为防范提示注入而设计。', s5d='来自文档和备注的文本被视为不可信内容，每次改动都会运行一套注入攻击的红队测试。', s6='通行密钥（Passkey）', s6d='（或邮件发送的验证码）在连接账户或给 AI 更多权限之前需要再次验证。',
 h_run='自行部署', run_intro='全部开源，包括托管版的每一项功能。自行部署需要 Node 22.18+ 或 Docker。',
 run_warn='把 `.env` 复制到这台机器之外的安全位置。', run_warn_d='其中的 `AGFN_MASTER_KEY` 用来加密你存储的银行令牌和备份；没有它，两者都无法读取。', run_guide='完整指南：', selfhosting='自行部署（英文）',
 full_list='全部 40 个工具和更多细节见[英文版 README](README.md)。',
 h_license='许可证', license='[AGPL-3.0-only](LICENSE)。可以免费使用、修改和自行部署。如果你把修改后的版本作为服务提供给他人，需要以同一许可证公开你的修改。',
)
L['ja'] = dict(
 early='Aggregate はまだ初期段階です。ホスト版では、Plaid、Stripe のサインイン、Shopify アプリが各プロバイダーの承認待ちです。それまでは、銀行は SimpleFIN Bridge か明細で、Shopify はご自身のアプリのキーでつなげます。その他のコネクタは各プロバイダーのドキュメントに沿って作られ、実際のアカウントで検証中です。Issue や修正を歓迎します。',
 headline='あなたの AI に、お金のことを聞こう。',
 sub1='MCP サーバーを備えた、オープンソースの複式簿記台帳。', sub2='すべての口座・会社・保有資産を、Claude、ChatGPT、または自作エージェント向けの 1 本のリンクに。', sub3='1 セント単位まで照合済み。そして AI がお金を動かすことは決してありません。',
 nav_site='ウェブサイト', nav_start='はじめる', nav_self='セルフホスト', nav_safety='安全性', nav_docs='ドキュメント',
 lag='この翻訳は英語版 README より古い場合があります。正確な内容は英語版をご覧ください。',
 gif_alt='Claude Code に「現金はいくらある？」と聞くと、Aggregate の get_overview ツールを呼び出し、会社ごとの現金と合計を答えます。',
 faq1q='Aggregate は銀行のパスワードを見ますか？', faq1a='いいえ。銀行へのログインは Plaid で、各アプリへのログインはそれぞれのページで行います。Aggregate が受け取るトークンはデータベースの外に置いた鍵で暗号化され、読み取りにしか使われません。',
 faq2q='データが AI モデルの学習に使われますか？', faq2a='いいえ。Aggregate はあなたのデータをモデルの学習に使わず、他者にも使わせません。AI が読んだ内容には、お使いの AI 提供元のポリシーが適用されます。',
 faq3q='お金を動かせますか？', faq3a='決してできません。支払い、送金、請求書の支払い、何かの送信ができるツールや接続は存在しません。', faq4q='現金、バーン、ランウェイはどう計算しますか？', faq4a='毎回同じ方法です。各数値は AI ではなく Aggregate が、書き出された<a href="docs/guides/definitions.md">定義</a>（英語）どおりに計算し、わからないときは推測せず「不明」と答えます。',
 diagram_alt='銀行、決済アプリ、会計、請求書、給与、資本政策表、領収書がすべて Aggregate に集まり、1 本のリンクで Claude、ChatGPT、Cursor、自作エージェントに提供されます。',
 h_who='こんな方に', founders='創業者', founders_d='複数の会社を並べて、それぞれがあなたにいくら借りているかも', business='事業者', business_d='銀行、カード、決済、請求書、支払い、給与を 1 つの台帳に', investors='投資家', investors_d='保有資産と、各社に持っている持分', individuals='個人', individuals_d='自分の口座、カード、現金だけを、プライベートなスペースに',
 h_ask='聞けること', ask_intro='つないだら、あとは聞くだけ：',
 q1='「全社合わせて現金はいくら？ あと何か月もつ？」', q2='「期限切れの請求書はどれ？ 一番多く未払いなのは誰？」', q3='「投資の調子はどう？」', q4='「個人口座に今いくらある？」', q5='「Harbor Coffee の件で業者に現金 500 ドルを払った。記録して。」', q6='「各社は個人的に私にいくら借りている？」',
 ask_outro='ほかの例は[プロンプトレシピ](docs/recipes.md)（英語）へ。考えるのは AI、Aggregate はその下の数字を正しく保ちます。支払いは 1 回だけ数え、残高は銀行と照合し、すべての記録は出どころまでたどれます。',
 h_start='はじめる', selfonly='セルフホストのみ', hosted='ホスト版（約 2 分）', selfhost='セルフホスト（約 10 分）',
 r_where='動く場所', r_where_s='自分のマシンやサーバー（Docker または Node）', r_conn='接続', r_conn_h='設定済み', r_conn_s='自分のプロバイダーキーを使うか、明細をアップロード', r_backup='バックアップと更新', r_backup_h='おまかせ', r_backup_s='ご自身で', r_cost='費用', r_cost_h='アーリーアクセス期間中は無料', r_cost_s='無料（AGPL-3.0）', r_start='開始', signup='登録', r_start_h='して、下の手順で AI をつなぐ',
 h_connect='AI をつなぐ', how='方法', setup_note='変更内容を表示するだけ。書き込むには `--yes` を追加', claude_how='設定 → コネクタ → **カスタムコネクタを追加** → 下のリンクを貼り付け', chatgpt_how='コネクタとして追加し、下のリンクを貼り付け',
 link_intro='または、MCP に対応した AI にこのリンクをコピー：', connect_outro='サインインしたら、その AI に見せる範囲を 1 文で正確に選びます。自分のサーバーなら `https://<あなたのサーバー>/mcp` を使ってください。',
 h_connects='つなげるもの', c_banks='銀行とカード', c_banks_d='Plaid または SimpleFIN Bridge 経由であらゆる銀行・カード、さらに Mercury、Brex、Ramp、Wise と直接', c_pay='決済', c_acct='会計', c_payroll='給与', c_payroll_d='Finch、Deel、そして銀行データから見つかる Gusto 型の給与', c_cap='資本政策表', c_cap_d='内蔵。Carta や Pulley からの取り込みと Open Cap Table Format に対応', c_else='そのほか', c_else_d='明細（CSV、OFX、QFX、QBO）、領収書の PDF や写真、メールで届いた請求書、または AI に伝えるだけ', c_soon='近日対応', c_soon_d='BILL、Rippling、Justworks：開発済みで、実際のアカウントでテスト中',
 connects_outro='Aggregate は接続先からデータを読み取るだけで、お金を動かす手段は一切ありません。所有する会社が並んで管理され、さらにプライベートな**個人**スペースがあります。',
 h_safety='安全性', s1='AI がお金を動かすことは決してありません。', s1d='支払いも、請求書の支払いも、請求書やメールの送信もしません。決して。', s2='AI ごとに個別の権限。', s2d='読める 1 文で書かれます：どの会社、どの種類のデータ、読み取りのみか追加もできるか、いつ期限切れか。リクエストごとに毎回チェックします。', s3='すべて記録され、元に戻せます。', s3d='AI の質問と追加した記録はすべて、誰が追加したかとともに記録。30 日間は取り消せ、AI の変更をあなたの確認待ちにすることもできます。どの AI もワンクリックで一時停止・取り消し。', s4='秘密情報は暗号化。', s4d='プロバイダーのトークンは、データベースの外に置いた鍵で暗号化されます（KMS と 1Password に対応）。銀行ログインは Plaid を通り、Aggregate が見ることはありません。', s5='プロンプトインジェクション対策。', s5d='ドキュメントやメモのテキストは信頼できないものとして扱い、変更のたびにインジェクション攻撃のレッドチームテストを実行します。', s6='パスキー', s6d='（またはメールで届くコード）は、口座をつなぐときや AI の権限を広げるときに、再度必要です。',
 h_run='セルフホスト', run_intro='ホスト版のすべての機能を含め、すべてオープンソースです。セルフホストには Node 22.18 以上か Docker が必要です。',
 run_warn='`.env` はこのマシンの外の安全な場所にコピーしてください。', run_warn_d='その中の `AGFN_MASTER_KEY` が保存された銀行トークンとバックアップを暗号化します。なくすと、どちらも読めなくなります。', run_guide='詳しいガイド：', selfhosting='セルフホスト（英語）',
 full_list='40 個のツールすべてと詳細は[英語版 README](README.md) にあります。',
 h_license='ライセンス', license='[AGPL-3.0-only](LICENSE)。無料で使用、変更、セルフホストできます。変更したバージョンを他者向けのサービスとして運用する場合は、同じライセンスで変更を公開してください。',
)
L['ko'] = dict(
 early='Aggregate는 아직 초기 단계입니다. 호스팅 버전에서는 Plaid, Stripe 로그인, Shopify 앱이 각 제공자의 승인을 기다리고 있습니다. 그때까지 은행은 SimpleFIN Bridge나 거래 내역서로, Shopify는 내 앱의 키로 연결하세요. 다른 커넥터는 각 제공자의 문서에 맞춰 만들어 실제 계정으로 검증하고 있습니다. 이슈와 수정 제안을 환영합니다.',
 headline='AI에게 내 재무 상황을 물어보세요.',
 sub1='MCP 서버를 갖춘 오픈소스 복식부기 원장.', sub2='모든 계좌, 회사, 보유 자산을 Claude, ChatGPT 또는 직접 만든 에이전트를 위한 링크 하나로.', sub3='1센트 단위까지 대사하고, AI는 절대 돈을 옮길 수 없습니다.',
 nav_site='웹사이트', nav_start='시작하기', nav_self='셀프 호스팅', nav_safety='안전', nav_docs='문서',
 lag='이 번역은 영어 README보다 늦게 업데이트될 수 있습니다. 영어판이 기준입니다.',
 gif_alt='Claude Code에 “현금이 얼마나 있지?”라고 물으면 Aggregate의 get_overview 도구를 호출해 회사별 현금과 합계를 답합니다.',
 faq1q='Aggregate가 은행 비밀번호를 보나요?', faq1a='아니요. 은행 로그인은 Plaid에서, 각 앱 로그인은 그 앱의 페이지에서 합니다. Aggregate가 받는 토큰은 데이터베이스 밖에 보관된 키로 암호화되며, 읽기에만 사용됩니다.',
 faq2q='내 데이터로 AI 모델을 학습시키나요?', faq2a='아니요. Aggregate는 여러분의 데이터로 모델을 학습시키지 않으며 다른 누구에게도 허용하지 않습니다. AI가 읽는 내용에는 사용하는 AI 제공자의 정책이 적용됩니다.',
 faq3q='돈을 옮길 수 있나요?', faq3a='절대 안 됩니다. 결제, 이체, 청구서 납부, 무언가를 보내는 일을 할 수 있는 도구나 연결은 없습니다.', faq4q='현금, 번, 런웨이는 어떻게 계산하나요?', faq4a='항상 같은 방식입니다. 각 수치는 AI가 아니라 Aggregate가 문서로 정한 <a href="docs/guides/definitions.md">정의</a>(영어)대로 계산하며, 알 수 없을 때는 추측하지 않고 “알 수 없음”이라고 답합니다.',
 diagram_alt='은행, 결제 앱, 회계, 인보이스, 급여, 지분 구조표, 영수증이 모두 Aggregate로 모이고, 링크 하나로 Claude, ChatGPT, Cursor와 직접 만든 에이전트에 제공됩니다.',
 h_who='누구를 위한 것인가요', founders='창업자', founders_d='여러 회사를 나란히, 그리고 각 회사가 나에게 빚진 금액까지', business='사업체', business_d='은행, 카드, 결제, 인보이스, 청구서, 급여를 원장 하나에', investors='투자자', investors_d='보유 자산과 여러 회사에 가진 지분', individuals='개인', individuals_d='내 계좌, 카드, 현금만 비공개 공간에',
 h_ask='이런 걸 물어볼 수 있어요', ask_intro='연결한 뒤에는 그냥 물어보세요:',
 q1='“우리 회사들 전부 합쳐 현금이 얼마고, 몇 달 버틸 수 있어?”', q2='“연체된 인보이스는 뭐고, 누가 가장 많이 빚졌어?”', q3='“내 투자 성과는 어때?”', q4='“지금 내 개인 계좌에 얼마 있어?”', q5='“Harbor Coffee 일로 외주 업체에 현금 500달러를 줬어. 기록해 줘.”', q6='“각 회사가 나 개인에게 얼마를 빚지고 있어?”',
 ask_outro='더 많은 예시는 [프롬프트 레시피](docs/recipes.md)(영어)에 있습니다. 생각은 AI가 하고, Aggregate는 그 아래의 숫자가 정확하도록 합니다. 모든 결제는 한 번만 세고, 잔액은 은행과 대조하며, 모든 기록은 출처까지 추적할 수 있습니다.',
 h_start='시작하기', selfonly='셀프 호스팅 전용', hosted='호스팅(약 2분)', selfhost='셀프 호스팅(약 10분)',
 r_where='실행 위치', r_where_s='내 컴퓨터나 서버(Docker 또는 Node)', r_conn='연결', r_conn_h='설정해 드림', r_conn_s='내 제공자 키를 쓰거나 거래 내역서를 업로드', r_backup='백업과 업데이트', r_backup_h='대신 처리', r_backup_s='직접 관리', r_cost='비용', r_cost_h='얼리 액세스 기간 무료', r_cost_s='무료(AGPL-3.0)', r_start='시작', signup='가입', r_start_h='한 뒤 아래에서 AI 연결',
 h_connect='AI 연결하기', how='방법', setup_note='무엇이 바뀔지 먼저 보여 줍니다. 실제로 쓰려면 `--yes` 추가', claude_how='설정 → 커넥터 → **사용자 지정 커넥터 추가** → 아래 링크 붙여넣기', chatgpt_how='커넥터로 추가하고 아래 링크 붙여넣기',
 link_intro='또는 MCP를 지원하는 AI에 이 링크를 복사하세요:', connect_outro='로그인한 뒤, 그 AI가 볼 수 있는 범위를 쉬운 한 문장으로 정확히 고릅니다. 직접 운영하는 서버라면 `https://<내-서버>/mcp`를 쓰세요.',
 h_connects='연결할 수 있는 것', c_banks='은행과 카드', c_banks_d='Plaid 또는 SimpleFIN Bridge를 통해 모든 은행과 카드, 그리고 Mercury, Brex, Ramp, Wise는 직접 연결', c_pay='결제', c_acct='회계', c_payroll='급여', c_payroll_d='Finch, Deel, 그리고 은행 데이터에서 찾아낸 Gusto 방식의 급여', c_cap='지분 구조표', c_cap_d='기본 내장. Carta와 Pulley 가져오기, Open Cap Table Format 지원', c_else='그 밖의 모든 것', c_else_d='거래 내역서(CSV, OFX, QFX, QBO), 영수증 PDF와 사진, 이메일로 받은 청구서, 또는 AI에게 말하기만 하면 됨', c_soon='곧 지원', c_soon_d='BILL, Rippling, Justworks: 개발 완료, 실제 계정으로 테스트 중',
 connects_outro='Aggregate는 연결된 서비스에서 데이터를 읽기만 하며, 돈을 옮길 방법이 전혀 없습니다. 소유한 모든 회사가 나란히 있고, 비공개 **개인** 공간도 있습니다.',
 h_safety='안전', s1='AI는 절대 돈을 옮길 수 없습니다.', s1d='결제도, 청구서 납부도, 인보이스나 이메일 발송도 없습니다. 절대로.', s2='AI마다 각자의 권한.', s2d='읽을 수 있는 한 문장으로 적힙니다: 어떤 회사, 어떤 종류의 데이터, 읽기만 또는 읽기와 추가, 만료 시점. 요청할 때마다 매번 확인합니다.', s3='모든 것이 기록되고 되돌릴 수 있습니다.', s3d='AI가 한 모든 질문과 추가한 모든 기록에 누가 추가했는지 표시됩니다. 30일 동안 되돌릴 수 있고, AI의 변경이 내 확인을 기다리도록 검토를 켤 수도 있습니다. 어떤 AI든 클릭 한 번으로 일시 중지하거나 해지합니다.', s4='비밀 정보는 암호화된 채로.', s4d='제공자 토큰은 데이터베이스 밖에 보관된 키로 암호화됩니다(KMS와 1Password 지원). 은행 로그인은 Plaid를 거치며 Aggregate는 절대 보지 못합니다.', s5='프롬프트 인젝션에 대비한 설계.', s5d='문서와 메모의 텍스트는 신뢰할 수 없는 것으로 취급하며, 변경할 때마다 인젝션 공격 레드팀 테스트를 실행합니다.', s6='패스키', s6d='(또는 이메일로 받은 코드)는 계정을 연결하거나 AI에 더 많은 권한을 줄 때 다시 필요합니다.',
 h_run='직접 운영하기', run_intro='호스팅 버전의 모든 기능을 포함해 전부 오픈소스입니다. 셀프 호스팅에는 Node 22.18 이상 또는 Docker가 필요합니다.',
 run_warn='`.env`를 이 컴퓨터 밖 안전한 곳에 복사해 두세요.', run_warn_d='그 안의 `AGFN_MASTER_KEY`가 저장된 은행 토큰과 백업을 암호화합니다. 이 키가 없으면 둘 다 읽을 수 없습니다.', run_guide='전체 가이드:', selfhosting='셀프 호스팅(영어)',
 full_list='40개 도구 전체 목록과 자세한 내용은 [영어 README](README.md)에 있습니다.',
 h_license='라이선스', license='[AGPL-3.0-only](LICENSE). 무료로 사용하고, 수정하고, 직접 호스팅할 수 있습니다. 수정한 버전을 다른 사람에게 서비스로 제공한다면 같은 라이선스로 변경 사항을 공개해야 합니다.',
)
L['es'] = dict(
 early='Aggregate está en una fase temprana. En la versión alojada, Plaid, el inicio de sesión con Stripe y la app de Shopify esperan la aprobación de cada proveedor; mientras tanto, conecta los bancos con SimpleFIN Bridge o con extractos, y Shopify con las claves de tu propia app. Los demás conectores siguen la documentación de cada proveedor y se están verificando con cuentas reales. Issues y correcciones son muy bienvenidos.',
 headline='Pregúntale a tu IA por tus finanzas.',
 sub1='Un libro mayor de partida doble, de código abierto, con servidor MCP.', sub2='Cada cuenta, empresa e inversión, en un solo enlace para Claude, ChatGPT o tus propios agentes.', sub3='Conciliado al centavo, y tu IA nunca puede mover dinero.',
 nav_site='Sitio web', nav_start='Empezar', nav_self='Autoalojar', nav_safety='Seguridad', nav_docs='Documentación',
 lag='Esta traducción puede ir por detrás del README en inglés, que es la versión de referencia.',
 gif_alt='Claude Code, ante la pregunta “¿Cuánto efectivo tenemos?”, llama a la herramienta get_overview de Aggregate y responde con el efectivo de cada empresa y el total.',
 faq1q='¿Aggregate ve la contraseña de mi banco?', faq1a='No. Inicias sesión en tu banco a través de Plaid, y en cada app en su propia página. Aggregate recibe un token, cifrado con una clave guardada fuera de la base de datos, y solo lo usa para leer.',
 faq2q='¿Mis datos entrenan modelos de IA?', faq2a='No. Aggregate nunca usa tus datos para entrenar modelos ni deja que nadie lo haga. Lo que lee tu IA se rige por la política de tu proveedor de IA.',
 faq3q='¿Puede mover dinero?', faq3a='Nunca. No hay ninguna herramienta ni conexión que pueda pagar, transferir, pagar una factura o enviar nada.', faq4q='¿Cómo calcula el efectivo, el burn y el runway?', faq4a='Siempre igual. Cada cifra la calcula Aggregate, no tu IA, según una <a href="docs/guides/definitions.md">definición</a> escrita (en inglés), y dice “desconocido” en lugar de adivinar.',
 diagram_alt='Bancos, apps de pago, contabilidad, facturas, nómina, tabla de capitalización y recibos llegan a Aggregate, que los sirve a Claude, ChatGPT, Cursor y tus propios agentes con un solo enlace.',
 h_who='Para quién es', founders='Fundadores', founders_d='Varias empresas una al lado de otra, y lo que cada una te debe', business='Empresas', business_d='Bancos, tarjetas, cobros, facturas, pagos a proveedores y nómina en un solo libro', investors='Inversores', investors_d='Tus inversiones y tus participaciones en empresas', individuals='Particulares', individuals_d='Solo tus cuentas, tarjetas y efectivo, en un espacio privado',
 h_ask='Qué puedes preguntar', ask_intro='Una vez conectado, solo pregunta:',
 q1='“¿Cuánto efectivo tenemos entre todas nuestras empresas y cuántos meses de pista nos quedan?”', q2='“¿Qué facturas están vencidas y quién nos debe más?”', q3='“¿Cómo van mis inversiones?”', q4='“¿Cuánto hay ahora mismo en mis cuentas personales?”', q5='“Le pagué a un contratista 500 $ en efectivo para Harbor Coffee. Regístralo.”', q6='“¿Cuánto me debe personalmente cada empresa?”',
 ask_outro='Más ejemplos en las [recetas de prompts](docs/recipes.md) (en inglés). Tu IA piensa; Aggregate se asegura de que los números de debajo sean correctos: cada pago se cuenta una vez, los saldos se cotejan con tu banco y cada registro se puede rastrear hasta su origen.',
 h_start='Empezar', selfonly='solo autoalojado', hosted='Alojado (unos 2 minutos)', selfhost='Autoalojado (unos 10 minutos)',
 r_where='Dónde se ejecuta', r_where_s='Tu equipo o servidor, con Docker o Node', r_conn='Conexiones', r_conn_h='Configuradas por nosotros', r_conn_s='Usa tus propias claves de proveedor o sube extractos', r_backup='Copias de seguridad y actualizaciones', r_backup_h='Nos encargamos', r_backup_s='Tuyas', r_cost='Coste', r_cost_h='Gratis durante el acceso anticipado', r_cost_s='Gratis (AGPL-3.0)', r_start='Empieza', signup='Regístrate', r_start_h=' y conecta tu IA abajo',
 h_connect='Conecta tu IA', how='Cómo', setup_note='muestra qué cambiaría; añade `--yes` para escribirlo', claude_how='Ajustes → Conectores → **Añadir conector personalizado** → pega el enlace de abajo', chatgpt_how='Añádelo como conector y pega el enlace de abajo',
 link_intro='O copia el enlace en cualquier IA compatible con MCP:', connect_outro='Inicias sesión y eliges exactamente qué puede ver esa IA, en una frase sencilla. ¿Tienes tu propio servidor? Usa `https://<tu-servidor>/mcp`.',
 h_connects='Qué conecta', c_banks='Bancos y tarjetas', c_banks_d='Cualquier banco o tarjeta a través de Plaid o SimpleFIN Bridge, y además Mercury, Brex, Ramp y Wise directamente', c_pay='Cobros', c_acct='Contabilidad', c_payroll='Nómina', c_payroll_d='Finch, Deel y nóminas tipo Gusto detectadas en tus datos bancarios', c_cap='Tabla de capitalización', c_cap_d='Integrada, con importación desde Carta y Pulley y Open Cap Table Format', c_else='Todo lo demás', c_else_d='Extractos (CSV, OFX, QFX, QBO), PDF y fotos de recibos, facturas enviadas por correo, o simplemente díselo a tu IA', c_soon='Próximamente', c_soon_d='BILL, Rippling y Justworks: ya desarrollados y en pruebas con cuentas reales',
 connects_outro='Aggregate solo lee de tus proveedores y no tiene ninguna forma de mover dinero. Todas tus empresas conviven una al lado de otra, más un espacio **Personal** privado.',
 h_safety='Seguridad', s1='Tu IA nunca puede mover dinero.', s1d='Ni pagos, ni facturas pagadas, ni facturas o correos enviados. Nunca.', s2='Cada IA tiene su propio permiso,', s2d='escrito como una frase que puedes leer: qué empresas, qué tipos de datos, solo lectura o lectura y alta, y cuándo caduca. Se comprueba en cada solicitud.', s3='Todo queda registrado y se puede deshacer.', s3d='Cada pregunta de una IA y cada registro que añade, marcados con quién lo añadió. Deshacer durante 30 días, o activar la revisión para que los cambios de la IA esperen tu visto bueno. Pausa o revoca cualquier IA con un clic.', s4='Tus secretos siguen cifrados.', s4d='Los tokens de los proveedores se cifran con una clave guardada fuera de la base de datos (compatible con KMS y 1Password). El acceso al banco pasa por Plaid y Aggregate nunca lo ve.', s5='Pensado contra la inyección de prompts.', s5d='El texto de documentos y notas se trata como no confiable, y en cada cambio se ejecuta una batería de ataques de inyección (red team).', s6='Las passkeys', s6d='(o un código enviado por correo) se vuelven a pedir antes de conectar cuentas o dar más acceso a una IA.',
 h_run='Ejecútalo tú mismo', run_intro='Todo es código abierto, incluidas todas las funciones de la versión alojada. Para autoalojar necesitas Node 22.18+ o Docker.',
 run_warn='Copia `.env` a un lugar seguro, fuera de esta máquina.', run_warn_d='Su `AGFN_MASTER_KEY` cifra los tokens bancarios guardados y tus copias de seguridad; sin ella no se puede leer ninguno de los dos.', run_guide='Guía completa:', selfhosting='autoalojamiento (en inglés)',
 full_list='Las 40 herramientas y el resto de detalles están en el [README en inglés](README.md).',
 h_license='Licencia', license='[AGPL-3.0-only](LICENSE). Libre para usar, modificar y autoalojar. Si ofreces una versión modificada como servicio a otras personas, comparte tus cambios con la misma licencia.',
)
L['pt-BR'] = dict(
 early='O Aggregate está no começo. Na versão hospedada, o Plaid, o login com Stripe e o app da Shopify aguardam a aprovação de cada provedor; até lá, conecte bancos pelo SimpleFIN Bridge ou por extratos, e a Shopify com as chaves do seu próprio app. Os outros conectores seguem a documentação de cada provedor e estão sendo verificados com contas reais. Issues e correções são muito bem-vindos.',
 headline='Pergunte à sua IA sobre suas finanças.',
 sub1='Um livro-razão de partidas dobradas, open source, com servidor MCP.', sub2='Todas as contas, empresas e investimentos, em um único link para Claude, ChatGPT ou seus próprios agentes.', sub3='Conciliado até o centavo, e sua IA nunca pode movimentar dinheiro.',
 nav_site='Site', nav_start='Começar', nav_self='Hospedar você mesmo', nav_safety='Segurança', nav_docs='Documentação',
 lag='Esta tradução pode estar atrás do README em inglês, que é a versão oficial.',
 gif_alt='O Claude Code, ao ouvir “Quanto temos em caixa?”, chama a ferramenta get_overview do Aggregate e responde com o caixa de cada empresa e o total.',
 faq1q='O Aggregate vê a senha do meu banco?', faq1a='Não. Você entra no banco pelo Plaid, e em cada app pela página dele. O Aggregate recebe um token, criptografado com uma chave guardada fora do banco de dados, e só o usa para ler.',
 faq2q='Meus dados treinam modelos de IA?', faq2a='Não. O Aggregate nunca usa seus dados para treinar modelos e não deixa ninguém fazer isso. O que sua IA lê segue a política do seu provedor de IA.',
 faq3q='Ele pode movimentar dinheiro?', faq3a='Nunca. Não existe ferramenta nem conexão capaz de pagar, transferir, quitar uma conta ou enviar qualquer coisa.', faq4q='Como ele calcula caixa, burn e runway?', faq4a='Sempre do mesmo jeito. Cada número é calculado pelo Aggregate, não pela sua IA, a partir de uma <a href="docs/guides/definitions.md">definição</a> escrita (em inglês), e ele diz “desconhecido” em vez de chutar.',
 diagram_alt='Bancos, apps de pagamento, contabilidade, faturas, folha de pagamento, cap table e recibos chegam ao Aggregate, que os entrega ao Claude, ChatGPT, Cursor e seus próprios agentes por um único link.',
 h_who='Para quem é', founders='Fundadores', founders_d='Várias empresas lado a lado, e quanto cada uma deve a você', business='Empresas', business_d='Bancos, cartões, recebimentos, faturas, contas a pagar e folha em um só livro-razão', investors='Investidores', investors_d='Seus investimentos e as participações que você tem em empresas', individuals='Pessoas físicas', individuals_d='Só suas contas, cartões e dinheiro, em um espaço privado',
 h_ask='O que você pode perguntar', ask_intro='Depois de conectar, é só perguntar:',
 q1='“Quanto temos em caixa somando todas as empresas, e quantos meses de runway?”', q2='“Quais faturas estão vencidas, e quem nos deve mais?”', q3='“Como estão meus investimentos?”', q4='“Quanto tem nas minhas contas pessoais agora?”', q5='“Paguei US$ 500 em dinheiro a um prestador para a Harbor Coffee. Registre.”', q6='“Quanto cada empresa me deve pessoalmente?”',
 ask_outro='Mais exemplos nas [receitas de prompts](docs/recipes.md) (em inglês). Sua IA pensa; o Aggregate garante que os números por baixo estejam certos: cada pagamento contado uma vez, saldos conferidos com o banco e cada registro rastreável até a origem.',
 h_start='Começar', selfonly='só auto-hospedado', hosted='Hospedado (cerca de 2 minutos)', selfhost='Auto-hospedado (cerca de 10 minutos)',
 r_where='Onde roda', r_where_s='Sua máquina ou servidor, com Docker ou Node', r_conn='Conexões', r_conn_h='Configuradas para você', r_conn_s='Use suas próprias chaves de provedor ou envie extratos', r_backup='Backups e atualizações', r_backup_h='Feitos para você', r_backup_s='Por sua conta', r_cost='Custo', r_cost_h='Grátis durante o acesso antecipado', r_cost_s='Grátis (AGPL-3.0)', r_start='Comece', signup='Cadastre-se', r_start_h=' e conecte sua IA abaixo',
 h_connect='Conecte sua IA', how='Como', setup_note='mostra o que mudaria; adicione `--yes` para gravar', claude_how='Configurações → Conectores → **Adicionar conector personalizado** → cole o link abaixo', chatgpt_how='Adicione como conector e cole o link abaixo',
 link_intro='Ou copie o link em qualquer IA compatível com MCP:', connect_outro='Você entra e escolhe exatamente o que essa IA pode ver, em uma frase simples. Tem seu próprio servidor? Use `https://<seu-servidor>/mcp`.',
 h_connects='O que ele conecta', c_banks='Bancos e cartões', c_banks_d='Qualquer banco ou cartão pelo Plaid ou SimpleFIN Bridge, além de Mercury, Brex, Ramp e Wise diretamente', c_pay='Pagamentos', c_acct='Contabilidade', c_payroll='Folha de pagamento', c_payroll_d='Finch, Deel e folhas no estilo Gusto identificadas nos seus dados bancários', c_cap='Cap table', c_cap_d='Integrada, com importação do Carta e do Pulley e Open Cap Table Format', c_else='Todo o resto', c_else_d='Extratos (CSV, OFX, QFX, QBO), PDFs e fotos de recibos, contas enviadas por e-mail, ou é só contar para sua IA', c_soon='Em breve', c_soon_d='BILL, Rippling e Justworks: já desenvolvidos, em testes com contas reais',
 connects_outro='O Aggregate só lê dos seus provedores e não tem como movimentar dinheiro. Todas as suas empresas ficam lado a lado, mais um espaço **Pessoal** privado.',
 h_safety='Segurança', s1='Sua IA nunca pode movimentar dinheiro.', s1d='Nada de pagamentos, contas quitadas, faturas ou e-mails enviados. Nunca.', s2='Cada IA tem sua própria permissão,', s2d='escrita como uma frase que você consegue ler: quais empresas, quais tipos de dados, só leitura ou leitura e inclusão, e quando expira. Verificada em cada requisição.', s3='Tudo fica registrado e pode ser desfeito.', s3d='Cada pergunta de uma IA e cada registro que ela inclui, marcados com quem incluiu. Desfaça por 30 dias, ou ative a revisão para que as mudanças da IA esperem por você. Pause ou revogue qualquer IA com um clique.', s4='Seus segredos ficam criptografados.', s4d='Os tokens dos provedores são criptografados com uma chave guardada fora do banco de dados (com suporte a KMS e 1Password). O login do banco passa pelo Plaid e o Aggregate nunca o vê.', s5='Feito para resistir a prompt injection.', s5d='Texto de documentos e anotações é tratado como não confiável, e um conjunto de ataques de injeção (red team) roda a cada mudança.', s6='Passkeys', s6d='(ou um código enviado por e-mail) são pedidas de novo antes de conectar contas ou dar mais acesso a uma IA.',
 h_run='Rode você mesmo', run_intro='Tudo é open source, inclusive cada recurso da versão hospedada. Para auto-hospedar, você precisa de Node 22.18+ ou Docker.',
 run_warn='Copie o `.env` para um lugar seguro, fora desta máquina.', run_warn_d='O `AGFN_MASTER_KEY` dele criptografa seus tokens bancários guardados e seus backups; sem ele, nenhum dos dois pode ser lido.', run_guide='Guia completo:', selfhosting='auto-hospedagem (em inglês)',
 full_list='As 40 ferramentas e os demais detalhes estão no [README em inglês](README.md).',
 h_license='Licença', license='[AGPL-3.0-only](LICENSE). Livre para usar, modificar e auto-hospedar. Se você oferecer uma versão modificada como serviço para outras pessoas, compartilhe suas mudanças sob a mesma licença.',
)
L['de'] = dict(
 early='Aggregate ist noch früh dran. In der gehosteten Version warten Plaid, die Stripe-Anmeldung und die Shopify-App noch auf die Freigabe des jeweiligen Anbieters; bis dahin verbindest du Banken über SimpleFIN Bridge oder Kontoauszüge und Shopify mit den Schlüsseln deiner eigenen App. Die übrigen Connectoren folgen der Dokumentation des jeweiligen Anbieters und werden mit echten Konten geprüft. Issues und Fixes sind sehr willkommen.',
 headline='Frag deine KI nach deinen Finanzen.',
 sub1='Ein quelloffenes Hauptbuch mit doppelter Buchführung und MCP-Server.', sub2='Jedes Konto, jedes Unternehmen und jede Beteiligung, in einem Link für Claude, ChatGPT oder deine eigenen Agenten.', sub3='Auf den Cent abgestimmt, und deine KI kann niemals Geld bewegen.',
 nav_site='Website', nav_start='Loslegen', nav_self='Selbst hosten', nav_safety='Sicherheit', nav_docs='Doku',
 lag='Diese Übersetzung kann hinter der englischen README zurückliegen; maßgeblich ist die englische Fassung.',
 gif_alt='Claude Code, gefragt „Wie viel Geld haben wir?“, ruft das Aggregate-Tool get_overview auf und nennt den Kassenbestand jedes Unternehmens und die Summe.',
 faq1q='Sieht Aggregate mein Bankpasswort?', faq1a='Nein. Bei deiner Bank meldest du dich über Plaid an, bei jeder App auf ihrer eigenen Seite. Aggregate erhält ein Token, verschlüsselt mit einem Schlüssel außerhalb der Datenbank, und nutzt es nur zum Lesen.',
 faq2q='Werden mit meinen Daten KI-Modelle trainiert?', faq2a='Nein. Aggregate nutzt deine Daten nie zum Training und erlaubt es auch niemand anderem. Was deine KI liest, unterliegt der Richtlinie deines KI-Anbieters.',
 faq3q='Kann es Geld bewegen?', faq3a='Niemals. Es gibt kein Tool und keine Verbindung, die zahlen, überweisen, eine Rechnung begleichen oder etwas versenden kann.', faq4q='Wie berechnet es Cash, Burn und Runway?', faq4a='Immer gleich. Jede Zahl berechnet Aggregate, nicht deine KI, nach einer schriftlich festgelegten <a href="docs/guides/definitions.md">Definition</a> (auf Englisch), und sagt „unbekannt“, statt zu raten.',
 diagram_alt='Banken, Zahlungs-Apps, Buchhaltung, Rechnungen, Lohnabrechnung, Cap Table und Belege fließen in Aggregate, das sie über einen Link an Claude, ChatGPT, Cursor und deine eigenen Agenten liefert.',
 h_who='Für wen', founders='Gründer', founders_d='Mehrere Unternehmen nebeneinander, und was jedes dir schuldet', business='Unternehmen', business_d='Banken, Karten, Zahlungen, Ausgangs- und Eingangsrechnungen und Löhne in einem Hauptbuch', investors='Investoren', investors_d='Deine Anlagen und deine Beteiligungen an Unternehmen', individuals='Privatpersonen', individuals_d='Nur deine eigenen Konten, Karten und Bargeld, in einem privaten Bereich',
 h_ask='Was du fragen kannst', ask_intro='Sobald es verbunden ist, frag einfach:',
 q1='„Wie viel Geld haben wir über alle Unternehmen hinweg, und wie viele Monate Runway?“', q2='„Welche Rechnungen sind überfällig, und wer schuldet uns am meisten?“', q3='„Wie laufen meine Investments?“', q4='„Wie viel ist gerade auf meinen privaten Konten?“', q5='„Ich habe einem Auftragnehmer für Harbor Coffee 500 $ bar bezahlt. Trag das ein.“', q6='„Was schuldet mir jedes Unternehmen persönlich?“',
 ask_outro='Mehr Beispiele in den [Prompt-Rezepten](docs/recipes.md) (Englisch). Deine KI denkt; Aggregate sorgt dafür, dass die Zahlen darunter stimmen: jede Zahlung einmal gezählt, Salden mit deiner Bank abgeglichen und jeder Eintrag bis zur Quelle nachvollziehbar.',
 h_start='Loslegen', selfonly='nur selbst gehostet', hosted='Gehostet (etwa 2 Minuten)', selfhost='Selbst gehostet (etwa 10 Minuten)',
 r_where='Wo es läuft', r_where_s='Dein Rechner oder Server, mit Docker oder Node', r_conn='Verbindungen', r_conn_h='Für dich eingerichtet', r_conn_s='Eigene Anbieter-Schlüssel nutzen oder Kontoauszüge hochladen', r_backup='Backups und Updates', r_backup_h='Übernehmen wir', r_backup_s='Deine Sache', r_cost='Kosten', r_cost_h='Kostenlos während des Early Access', r_cost_s='Kostenlos (AGPL-3.0)', r_start='Start', signup='Registrieren', r_start_h=', dann unten deine KI verbinden',
 h_connect='Verbinde deine KI', how='So geht’s', setup_note='zeigt, was es ändern würde; mit `--yes` wird es geschrieben', claude_how='Einstellungen → Connectors → **Benutzerdefinierten Connector hinzufügen** → Link unten einfügen', chatgpt_how='Als Connector hinzufügen und den Link unten einfügen',
 link_intro='Oder kopiere den Link in jede KI, die MCP unterstützt:', connect_outro='Du meldest dich an und legst in einem einfachen Satz genau fest, was diese KI sehen darf. Eigener Server? Dann nutze `https://<dein-server>/mcp`.',
 h_connects='Was es verbindet', c_banks='Banken und Karten', c_banks_d='Jede Bank oder Karte über Plaid oder SimpleFIN Bridge, dazu Mercury, Brex, Ramp und Wise direkt', c_pay='Zahlungen', c_acct='Buchhaltung', c_payroll='Lohnabrechnung', c_payroll_d='Finch, Deel und Gusto-artige Lohnzahlungen, die in deinen Bankdaten erkannt werden', c_cap='Cap Table', c_cap_d='Eingebaut, mit Import aus Carta und Pulley und Open Cap Table Format', c_else='Alles andere', c_else_d='Kontoauszüge (CSV, OFX, QFX, QBO), PDFs und Fotos von Belegen, per E-Mail geschickte Rechnungen, oder sag es einfach deiner KI', c_soon='Demnächst', c_soon_d='BILL, Rippling und Justworks: fertig gebaut und im Test mit echten Konten',
 connects_outro='Aggregate liest nur bei deinen Anbietern und hat keine Möglichkeit, Geld zu bewegen. Jedes deiner Unternehmen steht nebeneinander, dazu ein privater Bereich **Persönlich**.',
 h_safety='Sicherheit', s1='Deine KI kann niemals Geld bewegen.', s1d='Keine Zahlungen, keine bezahlten Rechnungen, keine versendeten Rechnungen oder E-Mails. Niemals.', s2='Jede KI bekommt ihre eigene Berechtigung,', s2d='als lesbarer Satz formuliert: welche Unternehmen, welche Datenarten, nur lesen oder lesen und hinzufügen, und wann sie abläuft. Bei jeder einzelnen Anfrage geprüft.', s3='Alles wird protokolliert und lässt sich rückgängig machen.', s3d='Jede Frage einer KI und jeder Eintrag, den sie anlegt, mit Vermerk, wer ihn angelegt hat. 30 Tage rückgängig machbar, oder schalte die Prüfung ein, damit KI-Änderungen auf dich warten. Jede KI mit einem Klick pausieren oder sperren.', s4='Deine Geheimnisse bleiben verschlüsselt.', s4d='Anbieter-Tokens werden mit einem Schlüssel außerhalb der Datenbank verschlüsselt (KMS und 1Password werden unterstützt). Bank-Logins laufen über Plaid; Aggregate sieht sie nie.', s5='Gegen Prompt Injection gebaut.', s5d='Text aus Dokumenten und Notizen gilt als nicht vertrauenswürdig, und bei jeder Änderung läuft eine Red-Team-Suite mit Injection-Angriffen.', s6='Passkeys', s6d='(oder ein per E-Mail gesendeter Code) werden erneut verlangt, bevor Konten verbunden werden oder eine KI mehr Zugriff bekommt.',
 h_run='Selbst betreiben', run_intro='Alles ist Open Source, auch jede Funktion der gehosteten Version. Zum Selbsthosten brauchst du Node 22.18+ oder Docker.',
 run_warn='Kopiere `.env` an einen sicheren Ort außerhalb dieses Rechners.', run_warn_d='Der darin enthaltene `AGFN_MASTER_KEY` verschlüsselt deine gespeicherten Bank-Tokens und deine Backups; ohne ihn ist beides nicht lesbar.', run_guide='Vollständige Anleitung:', selfhosting='Selbst hosten (Englisch)',
 full_list='Alle 40 Tools und weitere Details stehen in der [englischen README](README.md).',
 h_license='Lizenz', license='[AGPL-3.0-only](LICENSE). Frei nutzbar, veränderbar und selbst hostbar. Wenn du eine veränderte Version als Dienst für andere betreibst, veröffentliche deine Änderungen unter derselben Lizenz.',
)
L['fr'] = dict(
 early='Aggregate en est à ses débuts. Sur la version hébergée, Plaid, la connexion Stripe et l’app Shopify attendent l’approbation de chaque fournisseur ; d’ici là, connectez vos banques via SimpleFIN Bridge ou des relevés, et Shopify avec les clés de votre propre app. Les autres connecteurs suivent la documentation de chaque fournisseur et sont en cours de vérification avec de vrais comptes. Issues et corrections bienvenues.',
 headline='Demandez à votre IA où en sont vos finances.',
 sub1='Un grand livre en partie double, open source, avec un serveur MCP.', sub2='Chaque compte, entreprise et placement, dans un seul lien pour Claude, ChatGPT ou vos propres agents.', sub3='Rapproché au centime près, et votre IA ne peut jamais déplacer d’argent.',
 nav_site='Site web', nav_start='Commencer', nav_self='Auto-hébergement', nav_safety='Sécurité', nav_docs='Documentation',
 lag='Cette traduction peut être en retard sur le README en anglais, qui fait foi.',
 gif_alt='Claude Code, à qui l’on demande « Combien de trésorerie avons-nous ? », appelle l’outil get_overview d’Aggregate et répond avec la trésorerie de chaque entreprise et le total.',
 faq1q='Aggregate voit-il le mot de passe de ma banque ?', faq1a='Non. Vous vous connectez à votre banque via Plaid, et à chaque application sur sa propre page. Aggregate reçoit un jeton, chiffré avec une clé conservée hors de la base de données, et ne l’utilise que pour lire.',
 faq2q='Mes données servent-elles à entraîner des modèles d’IA ?', faq2a='Non. Aggregate n’utilise jamais vos données pour entraîner des modèles et ne laisse personne d’autre le faire. Ce que lit votre IA relève de la politique de votre fournisseur d’IA.',
 faq3q='Peut-il déplacer de l’argent ?', faq3a='Jamais. Aucun outil ni aucune connexion ne peut payer, virer, régler une facture ou envoyer quoi que ce soit.', faq4q='Comment calcule-t-il la trésorerie, le burn et le runway ?', faq4a='Toujours de la même façon. Chaque chiffre est calculé par Aggregate, pas par votre IA, selon une <a href="docs/guides/definitions.md">définition</a> écrite (en anglais), et il répond « inconnu » plutôt que de deviner.',
 diagram_alt='Banques, applis de paiement, comptabilité, factures, paie, table de capitalisation et reçus arrivent dans Aggregate, qui les fournit à Claude, ChatGPT, Cursor et vos propres agents par un seul lien.',
 h_who='Pour qui', founders='Fondateurs', founders_d='Plusieurs entreprises côte à côte, et ce que chacune vous doit', business='Entreprises', business_d='Banques, cartes, encaissements, factures, factures fournisseurs et paie dans un seul grand livre', investors='Investisseurs', investors_d='Vos placements, et vos participations dans des entreprises', individuals='Particuliers', individuals_d='Uniquement vos comptes, cartes et espèces, dans un espace privé',
 h_ask='Ce que vous pouvez demander', ask_intro='Une fois connecté, il suffit de demander :',
 q1='« Combien de trésorerie avons-nous sur l’ensemble de nos entreprises, et combien de mois de runway ? »', q2='« Quelles factures sont en retard, et qui nous doit le plus ? »', q3='« Comment se portent mes placements ? »', q4='« Combien y a-t-il sur mes comptes personnels en ce moment ? »', q5='« J’ai payé un prestataire 500 $ en espèces pour Harbor Coffee. Enregistre-le. »', q6='« Combien chaque entreprise me doit-elle personnellement ? »',
 ask_outro='Plus d’exemples dans les [recettes de prompts](docs/recipes.md) (en anglais). Votre IA réfléchit ; Aggregate s’assure que les chiffres en dessous sont justes : chaque paiement compté une seule fois, les soldes vérifiés auprès de votre banque, et chaque écriture traçable jusqu’à sa source.',
 h_start='Commencer', selfonly='auto-hébergé uniquement', hosted='Hébergé (environ 2 minutes)', selfhost='Auto-hébergé (environ 10 minutes)',
 r_where='Où ça tourne', r_where_s='Votre machine ou votre serveur, avec Docker ou Node', r_conn='Connexions', r_conn_h='Configurées pour vous', r_conn_s='Vos propres clés de fournisseur, ou l’import de relevés', r_backup='Sauvegardes et mises à jour', r_backup_h='Prises en charge', r_backup_s='À votre charge', r_cost='Prix', r_cost_h='Gratuit pendant l’accès anticipé', r_cost_s='Gratuit (AGPL-3.0)', r_start='Démarrer', signup='Inscrivez-vous', r_start_h=', puis connectez votre IA ci-dessous',
 h_connect='Connectez votre IA', how='Comment', setup_note='montre ce qui changerait ; ajoutez `--yes` pour l’écrire', claude_how='Paramètres → Connecteurs → **Ajouter un connecteur personnalisé** → collez le lien ci-dessous', chatgpt_how='Ajoutez-le comme connecteur et collez le lien ci-dessous',
 link_intro='Ou copiez le lien dans n’importe quelle IA compatible MCP :', connect_outro='Vous vous connectez, puis vous choisissez précisément ce que cette IA peut voir, en une phrase simple. Vous avez votre propre serveur ? Utilisez `https://<votre-serveur>/mcp`.',
 h_connects='Ce qu’il connecte', c_banks='Banques et cartes', c_banks_d='N’importe quelle banque ou carte via Plaid ou SimpleFIN Bridge, plus Mercury, Brex, Ramp et Wise en direct', c_pay='Paiements', c_acct='Comptabilité', c_payroll='Paie', c_payroll_d='Finch, Deel, et les paies de type Gusto repérées dans vos données bancaires', c_cap='Table de capitalisation', c_cap_d='Intégrée, avec import depuis Carta et Pulley et Open Cap Table Format', c_else='Tout le reste', c_else_d='Relevés (CSV, OFX, QFX, QBO), PDF et photos de reçus, factures envoyées par e-mail, ou dites-le simplement à votre IA', c_soon='Bientôt', c_soon_d='BILL, Rippling et Justworks : développés, en test avec de vrais comptes',
 connects_outro='Aggregate ne fait que lire chez vos fournisseurs et n’a aucun moyen de déplacer de l’argent. Toutes vos entreprises vivent côte à côte, plus un espace **Personnel** privé.',
 h_safety='Sécurité', s1='Votre IA ne peut jamais déplacer d’argent.', s1d='Aucun paiement, aucune facture réglée, aucune facture ni aucun e-mail envoyé. Jamais.', s2='Chaque IA a sa propre autorisation,', s2d='rédigée comme une phrase lisible : quelles entreprises, quels types de données, lecture seule ou lecture et ajout, et sa date d’expiration. Vérifiée à chaque requête.', s3='Tout est journalisé et annulable.', s3d='Chaque question posée par une IA et chaque écriture qu’elle ajoute, avec l’auteur indiqué. Annulation possible pendant 30 jours, ou activez la relecture pour que les changements de l’IA vous attendent. Mettez en pause ou révoquez n’importe quelle IA en un clic.', s4='Vos secrets restent chiffrés.', s4d='Les jetons des fournisseurs sont chiffrés avec une clé conservée hors de la base de données (KMS et 1Password pris en charge). Les connexions bancaires passent par Plaid et ne sont jamais vues par Aggregate.', s5='Conçu contre l’injection de prompts.', s5d='Le texte des documents et des notes est traité comme non fiable, et une batterie d’attaques par injection (red team) tourne à chaque modification.', s6='Les passkeys', s6d='(ou un code envoyé par e-mail) sont redemandées avant de connecter des comptes ou de donner plus d’accès à une IA.',
 h_run='Faites-le tourner vous-même', run_intro='Tout est open source, y compris chaque fonction de la version hébergée. L’auto-hébergement demande Node 22.18+ ou Docker.',
 run_warn='Copiez `.env` en lieu sûr, hors de cette machine.', run_warn_d='Son `AGFN_MASTER_KEY` chiffre vos jetons bancaires stockés et vos sauvegardes ; sans elle, ni les uns ni les autres ne peuvent être lus.', run_guide='Guide complet :', selfhosting='auto-hébergement (en anglais)',
 full_list='Les 40 outils et tous les détails sont dans le [README en anglais](README.md).',
 h_license='Licence', license='[AGPL-3.0-only](LICENSE). Libre à utiliser, modifier et auto-héberger. Si vous proposez une version modifiée en tant que service à d’autres, partagez vos modifications sous la même licence.',
)
for code, d in L.items():
    out = T.replace('LANGROW', LANGROW).format(**d)
    open(os.path.join(ROOT, f'README.{code}.md'), 'w').write(out)
    print(code, len(out))
