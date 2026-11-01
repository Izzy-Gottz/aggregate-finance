<p align="center">
  <a href="https://aggregate.finance">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
      <img alt="Aggregate" src=".github/assets/logo-light.svg" width="380">
    </picture>
  </a>
</p>

<h3 align="center">Frag deine KI nach deinen Finanzen.</h3>

<p align="center">
  Ein quelloffenes Hauptbuch mit doppelter Buchführung und MCP-Server.<br>
  Jedes Konto, jedes Unternehmen und jede Beteiligung, in einem Link für Claude, ChatGPT oder deine eigenen Agenten.<br>
  Auf den Cent abgestimmt, und deine KI kann niemals Geld bewegen.
</p>

<p align="center">
  <a href="https://aggregate.finance"><b>Website</b></a> ·
  <a href="#get-started"><b>Loslegen</b></a> ·
  <a href="#run-it-yourself"><b>Selbst hosten</b></a> ·
  <a href="#safety"><b>Sicherheit</b></a> ·
  <a href="docs/connect-your-ai.md"><b>Doku</b></a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-C8B38A?style=flat-square&labelColor=0F0E0D"></a>
  <a href="#get-started"><img alt="MCP: remote and local" src="https://img.shields.io/badge/MCP-remote%20%2B%20local-C8B38A?style=flat-square&labelColor=0F0E0D"></a>
  <a href="#run-it-yourself"><img alt="Self-host with Docker" src="https://img.shields.io/badge/self--host-Docker-C8B38A?style=flat-square&labelColor=0F0E0D"></a>
</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português (Brasil)</a> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a></p>

> [!NOTE]
> Diese Übersetzung kann hinter der englischen README zurückliegen; maßgeblich ist die englische Fassung.

<p align="center">
  <img alt="Claude Code, gefragt „Wie viel Geld haben wir?“, ruft das Aggregate-Tool get_overview auf und nennt den Kassenbestand jedes Unternehmens und die Summe." src=".github/assets/demo.gif" width="860">
</p>

<table>
<tr><td><b>Sieht Aggregate mein Bankpasswort?</b></td><td>Nein. Bei deiner Bank meldest du dich über Plaid an, bei jeder App auf ihrer eigenen Seite. Aggregate erhält ein Token, verschlüsselt mit einem Schlüssel außerhalb der Datenbank, und nutzt es nur zum Lesen.</td></tr>
<tr><td><b>Werden mit meinen Daten KI-Modelle trainiert?</b></td><td>Nein. Aggregate nutzt deine Daten nie zum Training und erlaubt es auch niemand anderem. Was deine KI liest, unterliegt der Richtlinie deines KI-Anbieters.</td></tr>
<tr><td><b>Kann es Geld bewegen?</b></td><td>Niemals. Es gibt kein Tool und keine Verbindung, die zahlen, überweisen, eine Rechnung begleichen oder etwas versenden kann.</td></tr>
<tr><td><b>Wie berechnet es Cash, Burn und Runway?</b></td><td>Immer gleich. Jede Zahl berechnet Aggregate, nicht deine KI, nach einer schriftlich festgelegten <a href="docs/guides/definitions.md">Definition</a> (auf Englisch), und sagt „unbekannt“, statt zu raten.</td></tr>
<tr><td><b>Was kann es noch nicht?</b></td><td>Krypto, Banken außerhalb der USA (stattdessen Kontoauszüge hochladen), Barverkäufe in Square und mehr. Alles steht unter <a href="docs/guides/limits.md">Bekannte Grenzen</a> (auf Englisch), jeweils mit dem, was stattdessen passiert.</td></tr>
</table>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/how-it-works-dark.png">
    <img alt="Banken, Zahlungs-Apps, Buchhaltung, Rechnungen, Lohnabrechnung, Cap Table und Belege fließen in Aggregate, das sie über einen Link an Claude, ChatGPT, Cursor und deine eigenen Agenten liefert." src=".github/assets/how-it-works-light.png" width="860">
  </picture>
</p>

## Für wen

|  |  |
|---|---|
| **Gründer** | Mehrere Unternehmen nebeneinander, und was jedes dir schuldet |
| **Unternehmen** | Banken, Karten, Zahlungen, Ausgangs- und Eingangsrechnungen und Löhne in einem Hauptbuch |
| **Investoren** | Deine Anlagen und deine Beteiligungen an Unternehmen |
| **Privatpersonen** | Nur deine eigenen Konten, Karten und Bargeld, in einem privaten Bereich |

## Was du fragen kannst

Sobald es verbunden ist, frag einfach:

> *„Wie viel Geld haben wir über alle Unternehmen hinweg, und wie viele Monate Runway?“*
>
> *„Welche Rechnungen sind überfällig, und wer schuldet uns am meisten?“*
>
> *„Wie laufen meine Investments?“*
>
> *„Wie viel ist gerade auf meinen privaten Konten?“*
>
> *„Ich habe einem Auftragnehmer für Harbor Coffee 500 $ bar bezahlt. Trag das ein.“*
>
> *„Was schuldet mir jedes Unternehmen persönlich?“*

Mehr Beispiele in den [Prompt-Rezepten](docs/recipes.md) (Englisch). Deine KI denkt; Aggregate sorgt dafür, dass die Zahlen darunter stimmen: jede Zahlung einmal gezählt, Salden mit deiner Bank abgeglichen und jeder Eintrag bis zur Quelle nachvollziehbar.

<a id="get-started"></a>
## Loslegen

|  | **Gehostet (etwa 2 Minuten)** | **Selbst gehostet (etwa 10 Minuten)** |
|---|---|---|
| **Wo es läuft** | app.aggregate.finance | Dein Rechner oder Server, mit Docker oder Node |
| **Verbindungen** | Für dich eingerichtet | Eigene Anbieter-Schlüssel nutzen oder Kontoauszüge hochladen |
| **Backups und Updates** | Übernehmen wir | Deine Sache |
| **Kosten** | Kostenlos während des Early Access | Kostenlos (AGPL-3.0) |
| **Start** | [Registrieren](https://app.aggregate.finance), dann unten deine KI verbinden | [Selbst hosten](#run-it-yourself) |

## Verbinde deine KI

| AI | So geht’s |
|---|---|
| **Claude Code** | `claude mcp add --transport http agfn https://app.aggregate.finance/mcp` |
| **Cursor, VS Code, Windsurf, Claude Code** | `npx aggregate-finance setup` (zeigt, was es ändern würde; mit `--yes` wird es geschrieben) |
| **Claude** | Einstellungen → Connectors → **Benutzerdefinierten Connector hinzufügen** → Link unten einfügen |
| **ChatGPT** | Als Connector hinzufügen und den Link unten einfügen |

Oder kopiere den Link in jede KI, die MCP unterstützt:

```
https://app.aggregate.finance/mcp
```

Du meldest dich an und legst in einem einfachen Satz genau fest, was diese KI sehen darf. Eigener Server? Dann nutze `https://<dein-server>/mcp`.

## Was es verbindet

|  |  |
|---|---|
| **Banken und Karten** | Jede Bank oder Karte über Plaid oder SimpleFIN Bridge, dazu Mercury, Brex, Ramp und Wise direkt |
| **Zahlungen** | Stripe, Square, Shopify, Paddle, App Store, Google Play · PayPal, Lemon Squeezy, Polar (nur selbst gehostet) |
| **Buchhaltung** | QuickBooks, Xero |
| **Lohnabrechnung** | Finch, Deel und Gusto-artige Lohnzahlungen, die in deinen Bankdaten erkannt werden |
| **Cap Table** | Eingebaut, mit Import aus Carta und Pulley und Open Cap Table Format |
| **Alles andere** | Kontoauszüge (CSV, OFX, QFX, QBO), PDFs und Fotos von Belegen, per E-Mail geschickte Rechnungen, oder sag es einfach deiner KI |
| **Demnächst** | BILL, Rippling und Justworks: fertig gebaut und im Test mit echten Konten |

Aggregate liest nur bei deinen Anbietern und hat keine Möglichkeit, Geld zu bewegen. Jedes deiner Unternehmen steht nebeneinander, dazu ein privater Bereich **Persönlich**.

> [!NOTE]
> Aggregate ist noch früh dran. In der gehosteten Version warten Plaid, die Stripe-Anmeldung und die Shopify-App noch auf die Freigabe des jeweiligen Anbieters; bis dahin verbindest du Banken über SimpleFIN Bridge oder Kontoauszüge und Shopify mit den Schlüsseln deiner eigenen App. Die übrigen Connectoren folgen der Dokumentation des jeweiligen Anbieters und werden mit echten Konten geprüft. Issues und Fixes sind sehr willkommen.

<a id="safety"></a>
## Sicherheit

- **Deine KI kann niemals Geld bewegen.** Keine Zahlungen, keine bezahlten Rechnungen, keine versendeten Rechnungen oder E-Mails. Niemals.
- **Jede KI bekommt ihre eigene Berechtigung,** als lesbarer Satz formuliert: welche Unternehmen, welche Datenarten, nur lesen oder lesen und hinzufügen, und wann sie abläuft. Bei jeder einzelnen Anfrage geprüft.
- **Alles wird protokolliert und lässt sich rückgängig machen.** Jede Frage einer KI und jeder Eintrag, den sie anlegt, mit Vermerk, wer ihn angelegt hat. 30 Tage rückgängig machbar, oder schalte die Prüfung ein, damit KI-Änderungen auf dich warten. Jede KI mit einem Klick pausieren oder sperren.
- **Deine Geheimnisse bleiben verschlüsselt.** Anbieter-Tokens werden mit einem Schlüssel außerhalb der Datenbank verschlüsselt (KMS und 1Password werden unterstützt). Bank-Logins laufen über Plaid; Aggregate sieht sie nie.
- **Gegen Prompt Injection gebaut.** Text aus Dokumenten und Notizen gilt als nicht vertrauenswürdig, und bei jeder Änderung läuft eine Red-Team-Suite mit Injection-Angriffen.
- **Passkeys** (oder ein per E-Mail gesendeter Code) werden erneut verlangt, bevor Konten verbunden werden oder eine KI mehr Zugriff bekommt.

<a id="run-it-yourself"></a>
## Selbst betreiben

Alles ist Open Source, auch jede Funktion der gehosteten Version. Zum Selbsthosten brauchst du Node 22.18+ oder Docker.

```sh
git clone https://github.com/Izzy-Gottz/aggregate-finance && cd aggregate-finance
(umask 077; printf 'AUTH_SECRET=%s\nAGFN_MASTER_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" > .env)
docker compose up -d         # http://localhost:8787
```

**Kopiere `.env` an einen sicheren Ort außerhalb dieses Rechners.** Der darin enthaltene `AGFN_MASTER_KEY` verschlüsselt deine gespeicherten Bank-Tokens und deine Backups; ohne ihn ist beides nicht lesbar. Vollständige Anleitung: [Selbst hosten (Englisch)](docs/self-hosting.md).

Alle 40 Tools und weitere Details stehen in der [englischen README](README.md).

## Lizenz

[AGPL-3.0-only](LICENSE). Frei nutzbar, veränderbar und selbst hostbar. Wenn du eine veränderte Version als Dienst für andere betreibst, veröffentliche deine Änderungen unter derselben Lizenz.
