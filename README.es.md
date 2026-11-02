<p align="center">
  <a href="https://aggregate.finance">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
      <img alt="Aggregate" src=".github/assets/logo-light.svg" width="380">
    </picture>
  </a>
</p>

<h3 align="center">Pregúntale a tu IA por tus finanzas.</h3>

<p align="center">
  Un libro mayor de partida doble, de código abierto, con servidor MCP.<br>
  Cada cuenta, empresa e inversión, en un solo enlace para Claude, ChatGPT o tus propios agentes.<br>
  Conciliado al centavo, y tu IA nunca puede mover dinero.
</p>

<p align="center">
  <a href="https://aggregate.finance"><b>Sitio web</b></a> ·
  <a href="#get-started"><b>Empezar</b></a> ·
  <a href="#run-it-yourself"><b>Autoalojar</b></a> ·
  <a href="#safety"><b>Seguridad</b></a> ·
  <a href="docs/connect-your-ai.md"><b>Documentación</b></a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-C8B38A?style=flat-square&labelColor=0F0E0D"></a>
  <a href="#get-started"><img alt="MCP: remote and local" src="https://img.shields.io/badge/MCP-remote%20%2B%20local-C8B38A?style=flat-square&labelColor=0F0E0D"></a>
  <a href="#run-it-yourself"><img alt="Self-host with Docker" src="https://img.shields.io/badge/self--host-Docker-C8B38A?style=flat-square&labelColor=0F0E0D"></a>
</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português (Brasil)</a> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a></p>

> [!NOTE]
> Esta traducción puede ir por detrás del README en inglés, que es la versión de referencia.

<p align="center">
  <img alt="Claude Code, ante la pregunta “¿Cuánto efectivo tenemos?”, llama a la herramienta get_overview de Aggregate y responde con el efectivo de cada empresa y el total." src=".github/assets/demo.gif" width="860">
</p>

<table>
<tr><td><b>¿Aggregate ve la contraseña de mi banco?</b></td><td>No. Inicias sesión en tu banco a través de Plaid, y en cada app en su propia página. Aggregate recibe un token, cifrado con una clave guardada fuera de la base de datos, y solo lo usa para leer.</td></tr>
<tr><td><b>¿Mis datos entrenan modelos de IA?</b></td><td>No. Aggregate nunca usa tus datos para entrenar modelos ni deja que nadie lo haga. Lo que lee tu IA se rige por la política de tu proveedor de IA.</td></tr>
<tr><td><b>¿Puede mover dinero?</b></td><td>Nunca. No hay ninguna herramienta ni conexión que pueda pagar, transferir, pagar una factura o enviar nada.</td></tr>
<tr><td><b>¿Cómo calcula el efectivo, el burn y el runway?</b></td><td>Siempre igual. Cada cifra la calcula Aggregate, no tu IA, según una <a href="docs/guides/definitions.md">definición</a> escrita (en inglés), y dice “desconocido” en lugar de adivinar.</td></tr>
<tr><td><b>¿Qué no hace todavía?</b></td><td>Cripto, bancos fuera de EE. UU. (sube extractos en su lugar), ventas en efectivo en Square y más. Todo está en <a href="docs/guides/limits.md">Límites conocidos</a> (en inglés), con lo que pasa en su lugar.</td></tr>
</table>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/how-it-works-dark.png">
    <img alt="Bancos, apps de pago, contabilidad, facturas, nómina, tabla de capitalización y recibos llegan a Aggregate, que los sirve a Claude, ChatGPT, Cursor y tus propios agentes con un solo enlace." src=".github/assets/how-it-works-light.png" width="860">
  </picture>
</p>

## Para quién es

|  |  |
|---|---|
| **Fundadores** | Varias empresas una al lado de otra, y lo que cada una te debe |
| **Empresas** | Bancos, tarjetas, cobros, facturas, pagos a proveedores y nómina en un solo libro |
| **Inversores** | Tus inversiones y tus participaciones en empresas |
| **Particulares** | Solo tus cuentas, tarjetas y efectivo, en un espacio privado |

## Qué puedes preguntar

Una vez conectado, solo pregunta:

> *“¿Cuánto efectivo tenemos entre todas nuestras empresas y cuántos meses de pista nos quedan?”*
>
> *“¿Qué facturas están vencidas y quién nos debe más?”*
>
> *“¿Cómo van mis inversiones?”*
>
> *“¿Cuánto hay ahora mismo en mis cuentas personales?”*
>
> *“Le pagué a un contratista 500 $ en efectivo para Harbor Coffee. Regístralo.”*
>
> *“¿Cuánto me debe personalmente cada empresa?”*

Más ejemplos en las [recetas de prompts](docs/recipes.md) (en inglés). Tu IA piensa; Aggregate se asegura de que los números de debajo sean correctos: cada pago se cuenta una vez, los saldos se cotejan con tu banco y cada registro se puede rastrear hasta su origen.

<a id="get-started"></a>
## Empezar

|  | **Alojado (unos 2 minutos)** | **Autoalojado (unos 10 minutos)** |
|---|---|---|
| **Dónde se ejecuta** | app.aggregate.finance | Tu equipo o servidor, con Docker o Node |
| **Conexiones** | Configuradas por nosotros | Usa tus propias claves de proveedor o sube extractos |
| **Copias de seguridad y actualizaciones** | Nos encargamos | Tuyas |
| **Coste** | Gratis durante el acceso anticipado | Gratis (AGPL-3.0) |
| **Empieza** | [Regístrate](https://app.aggregate.finance) y conecta tu IA abajo | [Autoalojar](#run-it-yourself) |

## Conecta tu IA

| AI | Cómo |
|---|---|
| **Claude Code** | `claude mcp add --transport http agfn https://app.aggregate.finance/mcp` |
| **Cursor, VS Code, Windsurf, Claude Code** | `npx aggregate-finance setup` (muestra qué cambiaría; añade `--yes` para escribirlo) |
| **Claude** | Ajustes → Conectores → **Añadir conector personalizado** → pega el enlace de abajo |
| **ChatGPT** | Añádelo como conector y pega el enlace de abajo |

O copia el enlace en cualquier IA compatible con MCP:

```
https://app.aggregate.finance/mcp
```

Inicias sesión y eliges exactamente qué puede ver esa IA, en una frase sencilla. ¿Tienes tu propio servidor? Usa `https://<tu-servidor>/mcp`.

## Qué conecta

|  |  |
|---|---|
| **Bancos y tarjetas** | Cualquier banco o tarjeta a través de Plaid o SimpleFIN Bridge, y además Mercury, Brex, Ramp y Wise directamente |
| **Cobros** | Stripe, Square, Shopify, Paddle, App Store, Google Play · PayPal, Lemon Squeezy, Polar (solo autoalojado) |
| **Contabilidad** | QuickBooks, Xero |
| **Nómina** | Finch, Deel y nóminas tipo Gusto detectadas en tus datos bancarios |
| **Tabla de capitalización** | Integrada, con importación desde Carta y Pulley y Open Cap Table Format |
| **Todo lo demás** | Extractos (CSV, OFX, QFX, QBO), PDF y fotos de recibos, facturas enviadas por correo, o simplemente díselo a tu IA |
| **Próximamente** | BILL, Rippling y Justworks: ya desarrollados y en pruebas con cuentas reales |

Aggregate solo lee de tus proveedores y no tiene ninguna forma de mover dinero. En la versión alojada, el acceso a Stripe y Square también es de solo lectura en el origen. QuickBooks, BILL, Lemon Squeezy y Expensify no ofrecen acceso de solo lectura, así que lo que conceden podría permitir más que leer; Aggregate solo lee de los cuatro. Todas tus empresas conviven una al lado de otra, más un espacio **Personal** privado.

> [!NOTE]
> Aggregate está en una fase temprana. En la versión alojada, Stripe está en el Stripe App Marketplace desde el 26-10-2026 y Shopify en la Shopify App Store desde el 22-10-2026. Xero conecta hasta 5 organizaciones en la versión alojada hasta que Xero certifique la app. Los demás conectores siguen la documentación de cada proveedor y se están verificando con cuentas reales. Issues y correcciones son muy bienvenidos.

<a id="safety"></a>
## Seguridad

- **Tu IA nunca puede mover dinero.** Ni pagos, ni facturas pagadas, ni facturas o correos enviados. Nunca.
- **Cada IA tiene su propio permiso,** escrito como una frase que puedes leer: qué empresas, qué tipos de datos, solo lectura o lectura y alta, y cuándo caduca. Se comprueba en cada solicitud.
- **Todo queda registrado y se puede deshacer.** Cada pregunta de una IA y cada registro que añade, marcados con quién lo añadió. Deshacer durante 30 días, o activar la revisión para que los cambios de la IA esperen tu visto bueno. Pausa o revoca cualquier IA con un clic.
- **Tus secretos siguen cifrados.** Los tokens de los proveedores se cifran con una clave guardada fuera de la base de datos (compatible con KMS y 1Password). El acceso al banco pasa por Plaid y Aggregate nunca lo ve.
- **Pensado contra la inyección de prompts.** El texto de documentos y notas se trata como no confiable, y en cada cambio se ejecuta una batería de ataques de inyección (red team).
- **Las passkeys** (o un código enviado por correo) se vuelven a pedir antes de conectar cuentas o dar más acceso a una IA.

<a id="run-it-yourself"></a>
## Ejecútalo tú mismo

Todo es código abierto, incluidas todas las funciones de la versión alojada. Para autoalojar necesitas Node 22.18+ o Docker.

```sh
git clone https://github.com/Izzy-Gottz/aggregate-finance && cd aggregate-finance
(umask 077; printf 'AUTH_SECRET=%s\nAGFN_MASTER_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" > .env)
docker compose up -d         # http://localhost:8787
```

**Copia `.env` a un lugar seguro, fuera de esta máquina.** Su `AGFN_MASTER_KEY` cifra los tokens bancarios guardados y tus copias de seguridad; sin ella no se puede leer ninguno de los dos. Guía completa: [autoalojamiento (en inglés)](docs/self-hosting.md).

Las 40 herramientas y el resto de detalles están en el [README en inglés](README.md).

## Licencia

[AGPL-3.0-only](LICENSE). Libre para usar, modificar y autoalojar. Si ofreces una versión modificada como servicio a otras personas, comparte tus cambios con la misma licencia.
