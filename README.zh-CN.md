<p align="center">
  <a href="https://aggregate.finance">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
      <img alt="Aggregate" src=".github/assets/logo-light.svg" width="380">
    </picture>
  </a>
</p>

<h3 align="center">问问你的 AI，你的财务状况如何。</h3>

<p align="center">
  一个带 MCP 服务器的开源复式记账账本。<br>
  所有账户、公司和持仓，汇成一个链接，交给 Claude、ChatGPT 或你自己的智能体。<br>
  精确对账到每一分钱，而且你的 AI 永远无法动用资金。
</p>

<p align="center">
  <a href="https://aggregate.finance"><b>官网</b></a> ·
  <a href="#get-started"><b>开始使用</b></a> ·
  <a href="#run-it-yourself"><b>自行部署</b></a> ·
  <a href="#safety"><b>安全</b></a> ·
  <a href="docs/connect-your-ai.md"><b>文档</b></a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-C8B38A?style=flat-square&labelColor=0F0E0D"></a>
  <a href="#get-started"><img alt="MCP: remote and local" src="https://img.shields.io/badge/MCP-remote%20%2B%20local-C8B38A?style=flat-square&labelColor=0F0E0D"></a>
  <a href="#run-it-yourself"><img alt="Self-host with Docker" src="https://img.shields.io/badge/self--host-Docker-C8B38A?style=flat-square&labelColor=0F0E0D"></a>
</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português (Brasil)</a> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a></p>

> [!NOTE]
> 本译文可能落后于英文版 README，请以英文版为准。

<p align="center">
  <img alt="在 Claude Code 中提问“我们有多少现金？”，它调用 Aggregate 的 get_overview 工具，给出每家公司的现金和总额。" src=".github/assets/demo.gif" width="860">
</p>

<table>
<tr><td><b>Aggregate 能看到我的银行密码吗？</b></td><td>不能。你通过 Plaid 登录银行，其他应用则在各自的页面登录。Aggregate 拿到的令牌用存放在数据库之外的密钥加密，并且只用于读取。</td></tr>
<tr><td><b>我的数据会被用来训练 AI 模型吗？</b></td><td>不会。Aggregate 从不用你的数据训练模型，也不允许任何人这样做。你的 AI 读取的内容，适用你所用 AI 服务商自己的政策。</td></tr>
<tr><td><b>它能动用资金吗？</b></td><td>永远不能。没有任何工具或连接可以付款、转账、支付账单或发送任何东西。</td></tr>
<tr><td><b>现金、烧钱率和资金跑道是怎么算的？</b></td><td>每次都用同一种算法。每个数字由 Aggregate 按一条写明的<a href="docs/guides/definitions.md">定义</a>（英文）计算，而不是由你的 AI 计算；算不出时会说“未知”，不会去猜。</td></tr>
<tr><td><b>还有哪些做不到？</b></td><td>加密货币、美国以外的银行（可改为上传对账单）、Square 里的现金销售等。全部列在<a href="docs/guides/limits.md">已知限制</a>（英文）中，并写明替代做法。</td></tr>
</table>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/how-it-works-dark.png">
    <img alt="银行、支付应用、会计、发票、薪资、股权结构表和收据都汇入 Aggregate，再通过一个链接提供给 Claude、ChatGPT、Cursor 和你自己的智能体。" src=".github/assets/how-it-works-light.png" width="860">
  </picture>
</p>

## 适合谁

|  |  |
|---|---|
| **创始人** | 多家公司并排查看，以及每家公司欠你多少 |
| **企业** | 银行、信用卡、收款、发票、账单和薪资，都在一个账本里 |
| **投资人** | 你的持仓，以及你在各公司持有的股份 |
| **个人** | 只有你自己的账户、信用卡和现金，放在私人空间里 |

## 你可以问什么

连接好之后，直接问：

> *“我们所有公司加起来有多少现金，还能撑几个月？”*
>
> *“哪些发票逾期了，谁欠我们最多？”*
>
> *“我的投资表现怎么样？”*
>
> *“我的个人账户里现在有多少钱？”*
>
> *“我替 Harbor Coffee 用现金付了承包商 500 美元，记一笔。”*
>
> *“每家公司个人欠我多少？”*

更多示例见[提示词食谱](docs/recipes.md)（英文）。思考交给你的 AI，Aggregate 负责底层数字准确：每笔付款只算一次，余额与银行核对，每条记录都能追溯到来源。

<a id="get-started"></a>
## 开始使用

|  | **托管版（约 2 分钟）** | **自行部署（约 10 分钟）** |
|---|---|---|
| **运行在哪里** | app.aggregate.finance | 你自己的电脑或服务器，用 Docker 或 Node |
| **连接** | 为你配置好 | 使用你自己的服务商密钥，或上传对账单 |
| **备份和更新** | 为你完成 | 你自己负责 |
| **费用** | 早期体验期间免费 | 免费（AGPL-3.0） |
| **开始** | [注册](https://app.aggregate.finance)，然后按下方步骤连接你的 AI | [自行部署](#run-it-yourself) |

## 连接你的 AI

| AI | 方法 |
|---|---|
| **Claude Code** | `claude mcp add --transport http agfn https://app.aggregate.finance/mcp` |
| **Cursor, VS Code, Windsurf, Claude Code** | `npx aggregate-finance setup` (先显示会改动什么；加上 `--yes` 才会写入) |
| **Claude** | 设置 → 连接器 → **添加自定义连接器** → 粘贴下面的链接 |
| **ChatGPT** | 把它添加为连接器，并粘贴下面的链接 |

或者把这个链接复制到任何支持 MCP 的 AI 中：

```
https://app.aggregate.finance/mcp
```

登录后，用一句通俗的话精确选择这个 AI 能看到什么。如果是自己部署的服务器，请改用 `https://<你的服务器>/mcp`。

## 能连接什么

|  |  |
|---|---|
| **银行和信用卡** | 通过 Plaid 或 SimpleFIN Bridge 连接任何银行或信用卡，另可直连 Mercury、Brex、Ramp 和 Wise |
| **收款** | Stripe, Square, Shopify, Paddle, App Store, Google Play · PayPal, Lemon Squeezy (自行部署时可用) |
| **会计** | QuickBooks, Xero |
| **薪资** | Finch、Deel，以及从银行数据中识别出的 Gusto 类薪资 |
| **股权结构表** | 内置，支持从 Carta 和 Pulley 导入，以及 Open Cap Table Format |
| **其他一切** | 对账单（CSV、OFX、QFX、QBO）、收据的 PDF 和照片、通过邮件发来的账单，或者直接告诉你的 AI |
| **即将推出** | BILL、Rippling 和 Justworks：已开发完成，正在用真实账户测试 |

Aggregate 只会从你的服务商读取数据，没有任何办法转移资金。你拥有的每家公司并排存在，另外还有一个私人的**个人**空间。

> [!NOTE]
> Aggregate 还处于早期阶段。在托管版上，Plaid、Stripe 登录和 Shopify 应用正在等待各服务商审批；在此之前，银行可通过 SimpleFIN Bridge 或对账单连接，Shopify 可使用你自己应用的密钥。其他连接器按各服务商的文档开发，正在用真实账户验证。欢迎提交问题和修复。

<a id="safety"></a>
## 安全

- **你的 AI 永远无法动用资金。** 不付款，不支付账单，不发送发票或邮件。永远不会。
- **每个 AI 都有自己的权限，** 写成一句你能读懂的话：哪些公司、哪些数据、只读还是可读可添加、何时过期。每次请求都会检查。
- **一切都有记录，都能撤销。** AI 的每个问题和添加的每条记录都会标明来源。30 天内可撤销，也可以开启审核，让 AI 的改动等你确认。一键暂停或撤销任何 AI。
- **你的密钥始终加密。** 服务商令牌用存放在数据库之外的密钥加密（支持 KMS 和 1Password）。银行登录经由 Plaid，Aggregate 永远看不到。
- **为防范提示注入而设计。** 来自文档和备注的文本被视为不可信内容，每次改动都会运行一套注入攻击的红队测试。
- **通行密钥（Passkey）** （或邮件发送的验证码）在连接账户或给 AI 更多权限之前需要再次验证。

<a id="run-it-yourself"></a>
## 自行部署

全部开源，包括托管版的每一项功能。自行部署需要 Node 22.18+ 或 Docker。

```sh
git clone https://github.com/Izzy-Gottz/aggregate-finance && cd aggregate-finance
(umask 077; printf 'AUTH_SECRET=%s\nAGFN_MASTER_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" > .env)
docker compose up -d         # http://localhost:8787
```

**把 `.env` 复制到这台机器之外的安全位置。** 其中的 `AGFN_MASTER_KEY` 用来加密你存储的银行令牌和备份；没有它，两者都无法读取。 完整指南： [自行部署（英文）](docs/self-hosting.md).

全部 40 个工具和更多细节见[英文版 README](README.md)。

## 许可证

[AGPL-3.0-only](LICENSE)。可以免费使用、修改和自行部署。如果你把修改后的版本作为服务提供给他人，需要以同一许可证公开你的修改。
