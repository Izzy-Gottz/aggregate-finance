# Email-in setup

Each company gets a secret address like `acme-k3j9w2…@in.example.com` (shown under "Add anything"). Forwarded bills and
receipts arrive as **unread documents**; the person's AI reads them with `list_documents` / `get_document` and records them
after confirming. Members who can add documents to that company may send from their sign-in address; anyone else only
once an owner or admin lists them (exact addresses or `@domain`) under "Who can email this address". Refused mail
shows in the activity log ("Email from x refused: not an allowed sender"). Mail that fails DMARC, or
fails SPF without a passing DKIM signature, is refused. Up to 10 attachments per email, 8 MB each; PDF, JPG, PNG, HEIC,
CSV, OFX, QFX.

Server settings:

```
INBOUND_EMAIL_DOMAIN=in.example.com
INBOUND_WEBHOOK_SECRET=<long random string>
```

Webhook: `POST https://<your server>/api/inbound/email/<address token>` (the part before `@`).

## Resend (hosted default)

Resend receives the whole domain and posts one signed event per email. Aggregate then fetches the sender, Resend's
SPF/DKIM/DMARC results and the attachments from Resend's API. The event itself carries only metadata.

1. In Resend, add the receiving domain (`in.example.com`) and set its MX record as Resend shows.
2. Create a webhook for the event `email.received` with the URL `https://<your server>/api/inbound/email/resend`.
3. Set on the server:
   ```
   INBOUND_EMAIL_DOMAIN=in.example.com
   RESEND_WEBHOOK_SECRET=whsec_…        # the webhook's signing secret
   RESEND_API_KEY=re_…                  # a key that can read received emails
   ```
   `INBOUND_WEBHOOK_SECRET` isn't used for Resend. The Svix signature (`svix-id`, `svix-timestamp`, `svix-signature`,
   timestamps within 5 minutes) proves the delivery came from Resend.

Mail to anything that isn't a company's secret address is acknowledged and dropped. Files over 8 MB are skipped
without being downloaded. Resend's download links last an hour, and Aggregate fetches them right away.

## Postmark

Inbound stream → Webhook URL: `https://postmark:<INBOUND_WEBHOOK_SECRET>@<your server>/api/inbound/email/{{token}}`.
Postmark sends its inbound JSON; use a per-company URL, or route on `OriginalRecipient` with one URL per address.

## Cloudflare Email Routing (Email Worker)

Route `*@in.example.com` to a Worker that posts the generic JSON:

```js
import PostalMime from 'postal-mime'
export default {
  async email(message, env) {
    const mail = await PostalMime.parse(message.raw)
    const token = message.to.split('@')[0]
    const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
    await fetch(`${env.AGFN_URL}/api/inbound/email/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agfn-inbound-secret': env.INBOUND_WEBHOOK_SECRET },
      body: JSON.stringify({
        from: message.from, to: [message.to], subject: mail.subject, messageId: mail.messageId,
        auth: { spf: message.headers.get('received-spf')?.split(' ')[0]?.toLowerCase() },
        attachments: mail.attachments.map((a) => ({ filename: a.filename, contentType: a.mimeType, content: b64(a.content) })),
      }),
    })
  },
}
```

Responses: `200 {accepted, documents, skipped}` (also for refused senders, so providers don't retry), `403` for a wrong
secret or unknown address, `503` when email-in isn't configured.
