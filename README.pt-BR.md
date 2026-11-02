<p align="center">
  <a href="https://aggregate.finance">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
      <img alt="Aggregate" src=".github/assets/logo-light.svg" width="380">
    </picture>
  </a>
</p>

<h3 align="center">Pergunte à sua IA sobre suas finanças.</h3>

<p align="center">
  Um livro-razão de partidas dobradas, open source, com servidor MCP.<br>
  Todas as contas, empresas e investimentos, em um único link para Claude, ChatGPT ou seus próprios agentes.<br>
  Conciliado até o centavo, e sua IA nunca pode movimentar dinheiro.
</p>

<p align="center">
  <a href="https://aggregate.finance"><b>Site</b></a> ·
  <a href="#get-started"><b>Começar</b></a> ·
  <a href="#run-it-yourself"><b>Hospedar você mesmo</b></a> ·
  <a href="#safety"><b>Segurança</b></a> ·
  <a href="docs/connect-your-ai.md"><b>Documentação</b></a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-C8B38A?style=flat-square&labelColor=0F0E0D"></a>
  <a href="#get-started"><img alt="MCP: remote and local" src="https://img.shields.io/badge/MCP-remote%20%2B%20local-C8B38A?style=flat-square&labelColor=0F0E0D"></a>
  <a href="#run-it-yourself"><img alt="Self-host with Docker" src="https://img.shields.io/badge/self--host-Docker-C8B38A?style=flat-square&labelColor=0F0E0D"></a>
</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português (Brasil)</a> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a></p>

> [!NOTE]
> Esta tradução pode estar atrás do README em inglês, que é a versão oficial.

<p align="center">
  <img alt="O Claude Code, ao ouvir “Quanto temos em caixa?”, chama a ferramenta get_overview do Aggregate e responde com o caixa de cada empresa e o total." src=".github/assets/demo.gif" width="860">
</p>

<table>
<tr><td><b>O Aggregate vê a senha do meu banco?</b></td><td>Não. Você entra no banco pelo Plaid, e em cada app pela página dele. O Aggregate recebe um token, criptografado com uma chave guardada fora do banco de dados, e só o usa para ler.</td></tr>
<tr><td><b>Meus dados treinam modelos de IA?</b></td><td>Não. O Aggregate nunca usa seus dados para treinar modelos e não deixa ninguém fazer isso. O que sua IA lê segue a política do seu provedor de IA.</td></tr>
<tr><td><b>Ele pode movimentar dinheiro?</b></td><td>Nunca. Não existe ferramenta nem conexão capaz de pagar, transferir, quitar uma conta ou enviar qualquer coisa.</td></tr>
<tr><td><b>Como ele calcula caixa, burn e runway?</b></td><td>Sempre do mesmo jeito. Cada número é calculado pelo Aggregate, não pela sua IA, a partir de uma <a href="docs/guides/definitions.md">definição</a> escrita (em inglês), e ele diz “desconhecido” em vez de chutar.</td></tr>
<tr><td><b>O que ele ainda não faz?</b></td><td>Cripto, bancos fora dos EUA (envie extratos em vez disso), vendas em dinheiro no Square e mais. Tudo está em <a href="docs/guides/limits.md">Limites conhecidos</a> (em inglês), com o que acontece no lugar.</td></tr>
</table>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/how-it-works-dark.png">
    <img alt="Bancos, apps de pagamento, contabilidade, faturas, folha de pagamento, cap table e recibos chegam ao Aggregate, que os entrega ao Claude, ChatGPT, Cursor e seus próprios agentes por um único link." src=".github/assets/how-it-works-light.png" width="860">
  </picture>
</p>

## Para quem é

|  |  |
|---|---|
| **Fundadores** | Várias empresas lado a lado, e quanto cada uma deve a você |
| **Empresas** | Bancos, cartões, recebimentos, faturas, contas a pagar e folha em um só livro-razão |
| **Investidores** | Seus investimentos e as participações que você tem em empresas |
| **Pessoas físicas** | Só suas contas, cartões e dinheiro, em um espaço privado |

## O que você pode perguntar

Depois de conectar, é só perguntar:

> *“Quanto temos em caixa somando todas as empresas, e quantos meses de runway?”*
>
> *“Quais faturas estão vencidas, e quem nos deve mais?”*
>
> *“Como estão meus investimentos?”*
>
> *“Quanto tem nas minhas contas pessoais agora?”*
>
> *“Paguei US$ 500 em dinheiro a um prestador para a Harbor Coffee. Registre.”*
>
> *“Quanto cada empresa me deve pessoalmente?”*

Mais exemplos nas [receitas de prompts](docs/recipes.md) (em inglês). Sua IA pensa; o Aggregate garante que os números por baixo estejam certos: cada pagamento contado uma vez, saldos conferidos com o banco e cada registro rastreável até a origem.

<a id="get-started"></a>
## Começar

|  | **Hospedado (cerca de 2 minutos)** | **Auto-hospedado (cerca de 10 minutos)** |
|---|---|---|
| **Onde roda** | app.aggregate.finance | Sua máquina ou servidor, com Docker ou Node |
| **Conexões** | Configuradas para você | Use suas próprias chaves de provedor ou envie extratos |
| **Backups e atualizações** | Feitos para você | Por sua conta |
| **Custo** | Grátis durante o acesso antecipado | Grátis (AGPL-3.0) |
| **Comece** | [Cadastre-se](https://app.aggregate.finance) e conecte sua IA abaixo | [Hospedar você mesmo](#run-it-yourself) |

## Conecte sua IA

| AI | Como |
|---|---|
| **Claude Code** | `claude mcp add --transport http agfn https://app.aggregate.finance/mcp` |
| **Cursor, VS Code, Windsurf, Claude Code** | `npx aggregate-finance setup` (mostra o que mudaria; adicione `--yes` para gravar) |
| **Claude** | Configurações → Conectores → **Adicionar conector personalizado** → cole o link abaixo |
| **ChatGPT** | Adicione como conector e cole o link abaixo |

Ou copie o link em qualquer IA compatível com MCP:

```
https://app.aggregate.finance/mcp
```

Você entra e escolhe exatamente o que essa IA pode ver, em uma frase simples. Tem seu próprio servidor? Use `https://<seu-servidor>/mcp`.

## O que ele conecta

|  |  |
|---|---|
| **Bancos e cartões** | Qualquer banco ou cartão pelo Plaid ou SimpleFIN Bridge, além de Mercury, Brex, Ramp e Wise diretamente |
| **Pagamentos** | Stripe, Square, Shopify, Paddle, App Store, Google Play · PayPal, Lemon Squeezy, Polar (só auto-hospedado) |
| **Contabilidade** | QuickBooks, Xero |
| **Folha de pagamento** | Finch, Deel e folhas no estilo Gusto identificadas nos seus dados bancários |
| **Cap table** | Integrada, com importação do Carta e do Pulley e Open Cap Table Format |
| **Todo o resto** | Extratos (CSV, OFX, QFX, QBO), PDFs e fotos de recibos, contas enviadas por e-mail, ou é só contar para sua IA |
| **Em breve** | BILL, Rippling e Justworks: já desenvolvidos, em testes com contas reais |

O Aggregate só lê dos seus provedores e não tem como movimentar dinheiro. Na versão hospedada, o acesso à Stripe e à Square também é somente leitura na origem. QuickBooks, BILL, Lemon Squeezy e Expensify não oferecem acesso somente leitura, então o que eles concedem poderia permitir mais do que ler; o Aggregate só lê dos quatro. Todas as suas empresas ficam lado a lado, mais um espaço **Pessoal** privado.

> [!NOTE]
> O Aggregate está no começo. Na versão hospedada, a Stripe está no Stripe App Marketplace desde 26/10/2026 e a Shopify na Shopify App Store desde 22/10/2026. O Xero conecta até 5 organizações na versão hospedada até que a Xero certifique o app. Os outros conectores seguem a documentação de cada provedor e estão sendo verificados com contas reais. Issues e correções são muito bem-vindos.

<a id="safety"></a>
## Segurança

- **Sua IA nunca pode movimentar dinheiro.** Nada de pagamentos, contas quitadas, faturas ou e-mails enviados. Nunca.
- **Cada IA tem sua própria permissão,** escrita como uma frase que você consegue ler: quais empresas, quais tipos de dados, só leitura ou leitura e inclusão, e quando expira. Verificada em cada requisição.
- **Tudo fica registrado e pode ser desfeito.** Cada pergunta de uma IA e cada registro que ela inclui, marcados com quem incluiu. Desfaça por 30 dias, ou ative a revisão para que as mudanças da IA esperem por você. Pause ou revogue qualquer IA com um clique.
- **Seus segredos ficam criptografados.** Os tokens dos provedores são criptografados com uma chave guardada fora do banco de dados (com suporte a KMS e 1Password). O login do banco passa pelo Plaid e o Aggregate nunca o vê.
- **Feito para resistir a prompt injection.** Texto de documentos e anotações é tratado como não confiável, e um conjunto de ataques de injeção (red team) roda a cada mudança.
- **Passkeys** (ou um código enviado por e-mail) são pedidas de novo antes de conectar contas ou dar mais acesso a uma IA.

<a id="run-it-yourself"></a>
## Rode você mesmo

Tudo é open source, inclusive cada recurso da versão hospedada. Para auto-hospedar, você precisa de Node 22.18+ ou Docker.

```sh
git clone https://github.com/Izzy-Gottz/aggregate-finance && cd aggregate-finance
(umask 077; printf 'AUTH_SECRET=%s\nAGFN_MASTER_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" > .env)
docker compose up -d         # http://localhost:8787
```

**Copie o `.env` para um lugar seguro, fora desta máquina.** O `AGFN_MASTER_KEY` dele criptografa seus tokens bancários guardados e seus backups; sem ele, nenhum dos dois pode ser lido. Guia completo: [auto-hospedagem (em inglês)](docs/self-hosting.md).

As 40 ferramentas e os demais detalhes estão no [README em inglês](README.md).

## Licença

[AGPL-3.0-only](LICENSE). Livre para usar, modificar e auto-hospedar. Se você oferecer uma versão modificada como serviço para outras pessoas, compartilhe suas mudanças sob a mesma licença.
