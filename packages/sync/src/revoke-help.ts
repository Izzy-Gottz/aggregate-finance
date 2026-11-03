// What a person must do at a provider when Aggregate can't end its access from here: a pasted key only they can delete,
// or a provider with no revoke call. Shown on disconnect and in the workspace and account delete summaries, because once
// the secret is wiped nobody can revoke it later. A connector's own `notRevoked` wins over these.

// One pattern everywhere: "In <Provider>, go to <path> → <what to do>." The app says "One more step:" before it. Only the
// paths a provider's docs give are written out: Paddle, Chargebee, App Store Connect, Google Play, SimpleFIN and Justworks
// have none here on purpose, and none of these has been walked through on a real account except where 43 has said so.
const STEPS: Record<string, string> = {
  billcom: 'In BILL, go to Settings → Sync & Integrations → Remove the sync token.',
  deel: 'In Deel, remove Aggregate, or go to the Developer Center → Delete the organization token.',
  mercury: 'In Mercury, go to Settings → Remove Aggregate, or delete the token if you pasted one.',
  wise: 'In Wise, go to Your Account → API tokens → Delete the token.',
  harvest: 'In Harvest ID, open Security and sign out Aggregate. If you pasted a token, open Developers and revoke it.',
  lightspeed: 'In Lightspeed Retail, open your connected apps and remove Aggregate. If you pasted a personal token, delete it there.',
  sumup: 'SumUp documents no way for Aggregate to end a sign-in, so ask SumUp to remove Aggregate’s access. If you pasted a key, go to Settings → For Developers → Toolkit → API Keys and revoke it.',
  mollie: 'Aggregate ends its access at Mollie when you disconnect. To check, open Settings, then Connected apps, in Mollie and remove Aggregate.',
  whop: 'Aggregate ends its access at Whop when you disconnect. To check, open Settings, then Authorized apps, in Whop and remove Aggregate.',
  ownerrez: 'Aggregate ends its access at OwnerRez when you disconnect. To check, look for Aggregate in the apps connected to your OwnerRez account and remove it.',
  squarespace: 'In your site’s settings, open Extensions and disconnect Aggregate.',
  wix: 'In your site’s dashboard, open Apps and remove Aggregate.',
  adsense: 'In your Google Account, open Security → Third-party apps and remove Aggregate.',
  youtube: 'In your Google Account, open Security → Third-party apps and remove Aggregate.',
  pinterest: 'In your Pinterest settings, remove Aggregate from your connected apps.',
  woocommerce: 'In WooCommerce, go to Settings → Advanced → REST API → Revoke the key.',
  paddle: 'In Paddle, revoke the API key.',
  chargebee: 'In Chargebee, delete the read-only key.',
  freshbooks: 'In FreshBooks, go to your account’s connected apps → Remove Aggregate.',
  revenuecat: 'In RevenueCat, go to Project settings → API keys → Revoke the secret key.',
  appstore: 'In App Store Connect, revoke the key.',
  googleplay: 'In Google Play Console, remove the service account.',
  simplefin: 'In the SimpleFIN Bridge, remove Aggregate’s access.',
  gumroad: 'In Gumroad, go to your account settings → Authorized applications → Remove Aggregate.',
  shopify: 'In Shopify, go to Settings → Apps → Uninstall Aggregate.',
  polar: 'In Polar, go to Settings → Remove Aggregate.',
  patreon: 'In Patreon, go to Settings → More → Connected Apps → Remove Aggregate.',
}

export function notRevokedWarning(connectorKey: string, name: string): string {
  return STEPS[connectorKey] ?? `In ${name}, remove Aggregate or delete the key.`
}
