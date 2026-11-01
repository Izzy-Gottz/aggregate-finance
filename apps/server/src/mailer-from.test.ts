import { describe, expect, it } from 'vitest'
import { mailFromProblem, smtpMailer } from './mailer.ts'

describe('email sender checks', () => {
  it('warns when SMTP is set without MAIL_FROM on a host no provider accepts as a sender', () => {
    expect(mailFromProblem({ SMTP_URL: 'smtps://u:p@smtp.example.com:465' }, 'http://localhost:8787')).toMatch(/no-reply@localhost.*MAIL_FROM=/)
    expect(mailFromProblem({ SMTP_URL: 'smtps://u:p@smtp.example.com:465' }, 'http://192.168.1.20:8787')).toMatch(/MAIL_FROM/)
    expect(mailFromProblem({ SMTP_URL: 'smtps://u:p@smtp.example.com:465' }, 'https://books.example.com')).toBeNull()
    expect(mailFromProblem({ SMTP_URL: 'smtps://u:p@smtp.example.com:465', MAIL_FROM: 'A <a@example.com>' }, 'http://localhost:8787')).toBeNull()
    expect(mailFromProblem({}, 'http://localhost:8787')).toBeNull()
  })

  it('a refused send is logged with the provider’s reason (never the message or recipient) and still fails', async () => {
    const seen: Array<Record<string, unknown>> = []
    // Nothing listens on port 9: the send fails like a refused connection.
    const m = smtpMailer('smtp://127.0.0.1:9', 'Aggregate <no-reply@example.com>', (_msg, f) => void seen.push(f))
    await expect(m.send({ to: 'someone@example.com', subject: 'Sign in', text: 'https://x/verify?token=secret-token' })).rejects.toBeTruthy()
    expect(seen).toHaveLength(1)
    expect(JSON.stringify(seen[0])).not.toMatch(/secret-token|someone@example\.com/)
  })
})
