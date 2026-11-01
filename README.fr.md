<p align="center">
  <a href="https://aggregate.finance">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
      <img alt="Aggregate" src=".github/assets/logo-light.svg" width="380">
    </picture>
  </a>
</p>

<h3 align="center">Demandez à votre IA où en sont vos finances.</h3>

<p align="center">
  Un grand livre en partie double, open source, avec un serveur MCP.<br>
  Chaque compte, entreprise et placement, dans un seul lien pour Claude, ChatGPT ou vos propres agents.<br>
  Rapproché au centime près, et votre IA ne peut jamais déplacer d’argent.
</p>

<p align="center">
  <a href="https://aggregate.finance"><b>Site web</b></a> ·
  <a href="#get-started"><b>Commencer</b></a> ·
  <a href="#run-it-yourself"><b>Auto-hébergement</b></a> ·
  <a href="#safety"><b>Sécurité</b></a> ·
  <a href="docs/connect-your-ai.md"><b>Documentation</b></a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-C8B38A?style=flat-square&labelColor=0F0E0D"></a>
  <a href="#get-started"><img alt="MCP: remote and local" src="https://img.shields.io/badge/MCP-remote%20%2B%20local-C8B38A?style=flat-square&labelColor=0F0E0D"></a>
  <a href="#run-it-yourself"><img alt="Self-host with Docker" src="https://img.shields.io/badge/self--host-Docker-C8B38A?style=flat-square&labelColor=0F0E0D"></a>
</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português (Brasil)</a> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a></p>

> [!NOTE]
> Cette traduction peut être en retard sur le README en anglais, qui fait foi.

<p align="center">
  <img alt="Claude Code, à qui l’on demande « Combien de trésorerie avons-nous ? », appelle l’outil get_overview d’Aggregate et répond avec la trésorerie de chaque entreprise et le total." src=".github/assets/demo.gif" width="860">
</p>

<table>
<tr><td><b>Aggregate voit-il le mot de passe de ma banque ?</b></td><td>Non. Vous vous connectez à votre banque via Plaid, et à chaque application sur sa propre page. Aggregate reçoit un jeton, chiffré avec une clé conservée hors de la base de données, et ne l’utilise que pour lire.</td></tr>
<tr><td><b>Mes données servent-elles à entraîner des modèles d’IA ?</b></td><td>Non. Aggregate n’utilise jamais vos données pour entraîner des modèles et ne laisse personne d’autre le faire. Ce que lit votre IA relève de la politique de votre fournisseur d’IA.</td></tr>
<tr><td><b>Peut-il déplacer de l’argent ?</b></td><td>Jamais. Aucun outil ni aucune connexion ne peut payer, virer, régler une facture ou envoyer quoi que ce soit.</td></tr>
<tr><td><b>Comment calcule-t-il la trésorerie, le burn et le runway ?</b></td><td>Toujours de la même façon. Chaque chiffre est calculé par Aggregate, pas par votre IA, selon une <a href="docs/guides/definitions.md">définition</a> écrite (en anglais), et il répond « inconnu » plutôt que de deviner.</td></tr>
<tr><td><b>Que ne fait-il pas encore ?</b></td><td>La crypto, les banques hors des États-Unis (importez plutôt vos relevés), les ventes en espèces dans Square, et plus. Tout est dans <a href="docs/guides/limits.md">Limites connues</a> (en anglais), avec ce qui se passe à la place.</td></tr>
</table>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/how-it-works-dark.png">
    <img alt="Banques, applis de paiement, comptabilité, factures, paie, table de capitalisation et reçus arrivent dans Aggregate, qui les fournit à Claude, ChatGPT, Cursor et vos propres agents par un seul lien." src=".github/assets/how-it-works-light.png" width="860">
  </picture>
</p>

## Pour qui

|  |  |
|---|---|
| **Fondateurs** | Plusieurs entreprises côte à côte, et ce que chacune vous doit |
| **Entreprises** | Banques, cartes, encaissements, factures, factures fournisseurs et paie dans un seul grand livre |
| **Investisseurs** | Vos placements, et vos participations dans des entreprises |
| **Particuliers** | Uniquement vos comptes, cartes et espèces, dans un espace privé |

## Ce que vous pouvez demander

Une fois connecté, il suffit de demander :

> *« Combien de trésorerie avons-nous sur l’ensemble de nos entreprises, et combien de mois de runway ? »*
>
> *« Quelles factures sont en retard, et qui nous doit le plus ? »*
>
> *« Comment se portent mes placements ? »*
>
> *« Combien y a-t-il sur mes comptes personnels en ce moment ? »*
>
> *« J’ai payé un prestataire 500 $ en espèces pour Harbor Coffee. Enregistre-le. »*
>
> *« Combien chaque entreprise me doit-elle personnellement ? »*

Plus d’exemples dans les [recettes de prompts](docs/recipes.md) (en anglais). Votre IA réfléchit ; Aggregate s’assure que les chiffres en dessous sont justes : chaque paiement compté une seule fois, les soldes vérifiés auprès de votre banque, et chaque écriture traçable jusqu’à sa source.

<a id="get-started"></a>
## Commencer

|  | **Hébergé (environ 2 minutes)** | **Auto-hébergé (environ 10 minutes)** |
|---|---|---|
| **Où ça tourne** | app.aggregate.finance | Votre machine ou votre serveur, avec Docker ou Node |
| **Connexions** | Configurées pour vous | Vos propres clés de fournisseur, ou l’import de relevés |
| **Sauvegardes et mises à jour** | Prises en charge | À votre charge |
| **Prix** | Gratuit pendant l’accès anticipé | Gratuit (AGPL-3.0) |
| **Démarrer** | [Inscrivez-vous](https://app.aggregate.finance), puis connectez votre IA ci-dessous | [Auto-hébergement](#run-it-yourself) |

## Connectez votre IA

| AI | Comment |
|---|---|
| **Claude Code** | `claude mcp add --transport http agfn https://app.aggregate.finance/mcp` |
| **Cursor, VS Code, Windsurf, Claude Code** | `npx aggregate-finance setup` (montre ce qui changerait ; ajoutez `--yes` pour l’écrire) |
| **Claude** | Paramètres → Connecteurs → **Ajouter un connecteur personnalisé** → collez le lien ci-dessous |
| **ChatGPT** | Ajoutez-le comme connecteur et collez le lien ci-dessous |

Ou copiez le lien dans n’importe quelle IA compatible MCP :

```
https://app.aggregate.finance/mcp
```

Vous vous connectez, puis vous choisissez précisément ce que cette IA peut voir, en une phrase simple. Vous avez votre propre serveur ? Utilisez `https://<votre-serveur>/mcp`.

## Ce qu’il connecte

|  |  |
|---|---|
| **Banques et cartes** | N’importe quelle banque ou carte via Plaid ou SimpleFIN Bridge, plus Mercury, Brex, Ramp et Wise en direct |
| **Paiements** | Stripe, Square, Shopify, Paddle, App Store, Google Play · PayPal, Lemon Squeezy, Polar (auto-hébergé uniquement) |
| **Comptabilité** | QuickBooks, Xero |
| **Paie** | Finch, Deel, et les paies de type Gusto repérées dans vos données bancaires |
| **Table de capitalisation** | Intégrée, avec import depuis Carta et Pulley et Open Cap Table Format |
| **Tout le reste** | Relevés (CSV, OFX, QFX, QBO), PDF et photos de reçus, factures envoyées par e-mail, ou dites-le simplement à votre IA |
| **Bientôt** | BILL, Rippling et Justworks : développés, en test avec de vrais comptes |

Aggregate ne fait que lire chez vos fournisseurs et n’a aucun moyen de déplacer de l’argent. Toutes vos entreprises vivent côte à côte, plus un espace **Personnel** privé.

> [!NOTE]
> Aggregate en est à ses débuts. Sur la version hébergée, Plaid, la connexion Stripe et l’app Shopify attendent l’approbation de chaque fournisseur ; d’ici là, connectez vos banques via SimpleFIN Bridge ou des relevés, et Shopify avec les clés de votre propre app. Les autres connecteurs suivent la documentation de chaque fournisseur et sont en cours de vérification avec de vrais comptes. Issues et corrections bienvenues.

<a id="safety"></a>
## Sécurité

- **Votre IA ne peut jamais déplacer d’argent.** Aucun paiement, aucune facture réglée, aucune facture ni aucun e-mail envoyé. Jamais.
- **Chaque IA a sa propre autorisation,** rédigée comme une phrase lisible : quelles entreprises, quels types de données, lecture seule ou lecture et ajout, et sa date d’expiration. Vérifiée à chaque requête.
- **Tout est journalisé et annulable.** Chaque question posée par une IA et chaque écriture qu’elle ajoute, avec l’auteur indiqué. Annulation possible pendant 30 jours, ou activez la relecture pour que les changements de l’IA vous attendent. Mettez en pause ou révoquez n’importe quelle IA en un clic.
- **Vos secrets restent chiffrés.** Les jetons des fournisseurs sont chiffrés avec une clé conservée hors de la base de données (KMS et 1Password pris en charge). Les connexions bancaires passent par Plaid et ne sont jamais vues par Aggregate.
- **Conçu contre l’injection de prompts.** Le texte des documents et des notes est traité comme non fiable, et une batterie d’attaques par injection (red team) tourne à chaque modification.
- **Les passkeys** (ou un code envoyé par e-mail) sont redemandées avant de connecter des comptes ou de donner plus d’accès à une IA.

<a id="run-it-yourself"></a>
## Faites-le tourner vous-même

Tout est open source, y compris chaque fonction de la version hébergée. L’auto-hébergement demande Node 22.18+ ou Docker.

```sh
git clone https://github.com/Izzy-Gottz/aggregate-finance && cd aggregate-finance
(umask 077; printf 'AUTH_SECRET=%s\nAGFN_MASTER_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" > .env)
docker compose up -d         # http://localhost:8787
```

**Copiez `.env` en lieu sûr, hors de cette machine.** Son `AGFN_MASTER_KEY` chiffre vos jetons bancaires stockés et vos sauvegardes ; sans elle, ni les uns ni les autres ne peuvent être lus. Guide complet : [auto-hébergement (en anglais)](docs/self-hosting.md).

Les 40 outils et tous les détails sont dans le [README en anglais](README.md).

## Licence

[AGPL-3.0-only](LICENSE). Libre à utiliser, modifier et auto-héberger. Si vous proposez une version modifiée en tant que service à d’autres, partagez vos modifications sous la même licence.
