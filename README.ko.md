<p align="center">
  <a href="https://aggregate.finance">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
      <img alt="Aggregate" src=".github/assets/logo-light.svg" width="380">
    </picture>
  </a>
</p>

<h3 align="center">AI에게 내 재무 상황을 물어보세요.</h3>

<p align="center">
  MCP 서버를 갖춘 오픈소스 복식부기 원장.<br>
  모든 계좌, 회사, 보유 자산을 Claude, ChatGPT 또는 직접 만든 에이전트를 위한 링크 하나로.<br>
  1센트 단위까지 대사하고, AI는 절대 돈을 옮길 수 없습니다.
</p>

<p align="center">
  <a href="https://aggregate.finance"><b>웹사이트</b></a> ·
  <a href="#get-started"><b>시작하기</b></a> ·
  <a href="#run-it-yourself"><b>셀프 호스팅</b></a> ·
  <a href="#safety"><b>안전</b></a> ·
  <a href="docs/connect-your-ai.md"><b>문서</b></a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-C8B38A?style=flat-square&labelColor=0F0E0D"></a>
  <a href="#get-started"><img alt="MCP: remote and local" src="https://img.shields.io/badge/MCP-remote%20%2B%20local-C8B38A?style=flat-square&labelColor=0F0E0D"></a>
  <a href="#run-it-yourself"><img alt="Self-host with Docker" src="https://img.shields.io/badge/self--host-Docker-C8B38A?style=flat-square&labelColor=0F0E0D"></a>
</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português (Brasil)</a> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a></p>

> [!NOTE]
> 이 번역은 영어 README보다 늦게 업데이트될 수 있습니다. 영어판이 기준입니다.

<p align="center">
  <img alt="Claude Code에 “현금이 얼마나 있지?”라고 물으면 Aggregate의 get_overview 도구를 호출해 회사별 현금과 합계를 답합니다." src=".github/assets/demo.gif" width="860">
</p>

<table>
<tr><td><b>Aggregate가 은행 비밀번호를 보나요?</b></td><td>아니요. 은행 로그인은 Plaid에서, 각 앱 로그인은 그 앱의 페이지에서 합니다. Aggregate가 받는 토큰은 데이터베이스 밖에 보관된 키로 암호화되며, 읽기에만 사용됩니다.</td></tr>
<tr><td><b>내 데이터로 AI 모델을 학습시키나요?</b></td><td>아니요. Aggregate는 여러분의 데이터로 모델을 학습시키지 않으며 다른 누구에게도 허용하지 않습니다. AI가 읽는 내용에는 사용하는 AI 제공자의 정책이 적용됩니다.</td></tr>
<tr><td><b>돈을 옮길 수 있나요?</b></td><td>절대 안 됩니다. 결제, 이체, 청구서 납부, 무언가를 보내는 일을 할 수 있는 도구나 연결은 없습니다.</td></tr>
<tr><td><b>현금, 번, 런웨이는 어떻게 계산하나요?</b></td><td>항상 같은 방식입니다. 각 수치는 AI가 아니라 Aggregate가 문서로 정한 <a href="docs/guides/definitions.md">정의</a>(영어)대로 계산하며, 알 수 없을 때는 추측하지 않고 “알 수 없음”이라고 답합니다.</td></tr>
<tr><td><b>아직 안 되는 것은?</b></td><td>암호화폐, 미국 외 은행(대신 거래명세서 업로드), Square 현금 매출 등입니다. 모두 <a href="docs/guides/limits.md">알려진 제한 사항</a>(영어)에 대신 어떻게 되는지와 함께 정리되어 있습니다.</td></tr>
</table>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/how-it-works-dark.png">
    <img alt="은행, 결제 앱, 회계, 인보이스, 급여, 지분 구조표, 영수증이 모두 Aggregate로 모이고, 링크 하나로 Claude, ChatGPT, Cursor와 직접 만든 에이전트에 제공됩니다." src=".github/assets/how-it-works-light.png" width="860">
  </picture>
</p>

## 누구를 위한 것인가요

|  |  |
|---|---|
| **창업자** | 여러 회사를 나란히, 그리고 각 회사가 나에게 빚진 금액까지 |
| **사업체** | 은행, 카드, 결제, 인보이스, 청구서, 급여를 원장 하나에 |
| **투자자** | 보유 자산과 여러 회사에 가진 지분 |
| **개인** | 내 계좌, 카드, 현금만 비공개 공간에 |

## 이런 걸 물어볼 수 있어요

연결한 뒤에는 그냥 물어보세요:

> *“우리 회사들 전부 합쳐 현금이 얼마고, 몇 달 버틸 수 있어?”*
>
> *“연체된 인보이스는 뭐고, 누가 가장 많이 빚졌어?”*
>
> *“내 투자 성과는 어때?”*
>
> *“지금 내 개인 계좌에 얼마 있어?”*
>
> *“Harbor Coffee 일로 외주 업체에 현금 500달러를 줬어. 기록해 줘.”*
>
> *“각 회사가 나 개인에게 얼마를 빚지고 있어?”*

더 많은 예시는 [프롬프트 레시피](docs/recipes.md)(영어)에 있습니다. 생각은 AI가 하고, Aggregate는 그 아래의 숫자가 정확하도록 합니다. 모든 결제는 한 번만 세고, 잔액은 은행과 대조하며, 모든 기록은 출처까지 추적할 수 있습니다.

<a id="get-started"></a>
## 시작하기

|  | **호스팅(약 2분)** | **셀프 호스팅(약 10분)** |
|---|---|---|
| **실행 위치** | app.aggregate.finance | 내 컴퓨터나 서버(Docker 또는 Node) |
| **연결** | 설정해 드림 | 내 제공자 키를 쓰거나 거래 내역서를 업로드 |
| **백업과 업데이트** | 대신 처리 | 직접 관리 |
| **비용** | 얼리 액세스 기간 무료 | 무료(AGPL-3.0) |
| **시작** | [가입](https://app.aggregate.finance)한 뒤 아래에서 AI 연결 | [셀프 호스팅](#run-it-yourself) |

## AI 연결하기

| AI | 방법 |
|---|---|
| **Claude Code** | `claude mcp add --transport http agfn https://app.aggregate.finance/mcp` |
| **Cursor, VS Code, Windsurf, Claude Code** | `npx aggregate-finance setup` (무엇이 바뀔지 먼저 보여 줍니다. 실제로 쓰려면 `--yes` 추가) |
| **Claude** | 설정 → 커넥터 → **사용자 지정 커넥터 추가** → 아래 링크 붙여넣기 |
| **ChatGPT** | 커넥터로 추가하고 아래 링크 붙여넣기 |

또는 MCP를 지원하는 AI에 이 링크를 복사하세요:

```
https://app.aggregate.finance/mcp
```

로그인한 뒤, 그 AI가 볼 수 있는 범위를 쉬운 한 문장으로 정확히 고릅니다. 직접 운영하는 서버라면 `https://<내-서버>/mcp`를 쓰세요.

## 연결할 수 있는 것

|  |  |
|---|---|
| **은행과 카드** | Plaid 또는 SimpleFIN Bridge를 통해 모든 은행과 카드, 그리고 Mercury, Brex, Ramp, Wise는 직접 연결 |
| **결제** | Stripe, Square, Shopify, Paddle, App Store, Google Play · PayPal, Lemon Squeezy, Polar (셀프 호스팅 전용) |
| **회계** | QuickBooks, Xero |
| **급여** | Finch, Deel, 그리고 은행 데이터에서 찾아낸 Gusto 방식의 급여 |
| **지분 구조표** | 기본 내장. Carta와 Pulley 가져오기, Open Cap Table Format 지원 |
| **그 밖의 모든 것** | 거래 내역서(CSV, OFX, QFX, QBO), 영수증 PDF와 사진, 이메일로 받은 청구서, 또는 AI에게 말하기만 하면 됨 |
| **곧 지원** | BILL, Rippling, Justworks: 개발 완료, 실제 계정으로 테스트 중 |

Aggregate는 연결된 서비스에서 데이터를 읽기만 하며, 돈을 옮길 방법이 전혀 없습니다. 소유한 모든 회사가 나란히 있고, 비공개 **개인** 공간도 있습니다.

> [!NOTE]
> Aggregate는 아직 초기 단계입니다. 호스팅 버전에서는 Plaid, Stripe 로그인, Shopify 앱이 각 제공자의 승인을 기다리고 있습니다. 그때까지 은행은 SimpleFIN Bridge나 거래 내역서로, Shopify는 내 앱의 키로 연결하세요. 다른 커넥터는 각 제공자의 문서에 맞춰 만들어 실제 계정으로 검증하고 있습니다. 이슈와 수정 제안을 환영합니다.

<a id="safety"></a>
## 안전

- **AI는 절대 돈을 옮길 수 없습니다.** 결제도, 청구서 납부도, 인보이스나 이메일 발송도 없습니다. 절대로.
- **AI마다 각자의 권한.** 읽을 수 있는 한 문장으로 적힙니다: 어떤 회사, 어떤 종류의 데이터, 읽기만 또는 읽기와 추가, 만료 시점. 요청할 때마다 매번 확인합니다.
- **모든 것이 기록되고 되돌릴 수 있습니다.** AI가 한 모든 질문과 추가한 모든 기록에 누가 추가했는지 표시됩니다. 30일 동안 되돌릴 수 있고, AI의 변경이 내 확인을 기다리도록 검토를 켤 수도 있습니다. 어떤 AI든 클릭 한 번으로 일시 중지하거나 해지합니다.
- **비밀 정보는 암호화된 채로.** 제공자 토큰은 데이터베이스 밖에 보관된 키로 암호화됩니다(KMS와 1Password 지원). 은행 로그인은 Plaid를 거치며 Aggregate는 절대 보지 못합니다.
- **프롬프트 인젝션에 대비한 설계.** 문서와 메모의 텍스트는 신뢰할 수 없는 것으로 취급하며, 변경할 때마다 인젝션 공격 레드팀 테스트를 실행합니다.
- **패스키** (또는 이메일로 받은 코드)는 계정을 연결하거나 AI에 더 많은 권한을 줄 때 다시 필요합니다.

<a id="run-it-yourself"></a>
## 직접 운영하기

호스팅 버전의 모든 기능을 포함해 전부 오픈소스입니다. 셀프 호스팅에는 Node 22.18 이상 또는 Docker가 필요합니다.

```sh
git clone https://github.com/Izzy-Gottz/aggregate-finance && cd aggregate-finance
(umask 077; printf 'AUTH_SECRET=%s\nAGFN_MASTER_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" > .env)
docker compose up -d         # http://localhost:8787
```

**`.env`를 이 컴퓨터 밖 안전한 곳에 복사해 두세요.** 그 안의 `AGFN_MASTER_KEY`가 저장된 은행 토큰과 백업을 암호화합니다. 이 키가 없으면 둘 다 읽을 수 없습니다. 전체 가이드: [셀프 호스팅(영어)](docs/self-hosting.md).

40개 도구 전체 목록과 자세한 내용은 [영어 README](README.md)에 있습니다.

## 라이선스

[AGPL-3.0-only](LICENSE). 무료로 사용하고, 수정하고, 직접 호스팅할 수 있습니다. 수정한 버전을 다른 사람에게 서비스로 제공한다면 같은 라이선스로 변경 사항을 공개해야 합니다.
