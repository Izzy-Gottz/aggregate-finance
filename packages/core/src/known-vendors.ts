// Vendors whose kind of spending is certain from the name alone. A provider's category is a guess from the text:
// Plaid has read "FLY.IO" as an airline (travel) one month and left it uncategorized the next. For these names the
// answer doesn't depend on the guess, so the same vendor books to the same category every month.
//
// Only names that can't be anything else are listed: domains (fly.io, render.com) or unmistakable brands. A plain word
// that could be a shop, a bar or a train ("fly", "neon", "railway", "linear") is never matched alone.
//
// It decides only WHAT kind of spending, never whether money is spending: a refund from one of these is still a refund
// only when the provider says so, and money in from them (a GitHub Sponsors payout) is still asked about. A person's own
// category or rule always wins over this list.

const CLOUD: RegExp[] = [
  /\bfly\.io\b|\bflyio\b|\bfly io\b/,
  /\bvercel\b/,
  /\bcloudflare\b/,
  /\baws\b|\bamazon web services\b/,
  /\bneon(\.| )?tech\b|\bneon,? inc\b|\bneondb\b/,
  /\bdigitalocean\b/,
  /\bheroku\b/,
  /\bnetlify\b/,
  /\brender\.com\b/,
  /\brailway\.app\b/,
  /\bsupabase\b/,
  /\bhetzner\b/,
  /\blinode\b/,
  /\bgoogle \*?cloud\b|\bgoogle cloud platform\b/,
  /\b(microsoft|msft) ?\*? ?azure\b/,
]

const SOFTWARE: RegExp[] = [
  /\bgithub\b/,
  /\bgitlab\b/,
  /\bfigma\b/,
  /\batlassian\b/,
  /\b1password\b/,
  /\blinear\.app\b/,
  /\bnotion\.so\b|\bnotion labs\b/,
  /\bslack technologies\b|\bslack\.com\b/,
  /\bgoogle \*?(gsuite|workspace)\b/,
]

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ')

function match(text: string): 'cloud' | 'software' | null {
  const t = norm(text)
  if (CLOUD.some((re) => re.test(t))) return 'cloud'
  if (SOFTWARE.some((re) => re.test(t))) return 'software'
  return null
}

/** The expense role for a vendor known by name, from the cleaned counterparty first, then the raw bank text. */
export function knownVendorRole(ev: { counterparty?: string; rawText?: string }): 'cloud' | 'software' | null {
  return (ev.counterparty ? match(ev.counterparty) : null) ?? (ev.rawText ? match(ev.rawText) : null)
}
