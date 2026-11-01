// Help from inside the app: the setup guide and a person to email.
export const SUPPORT_EMAIL = 'support@aggregate.finance'
export const GUIDE_URL = '/docs/connect-your-ai'

export const openGuide = (): void => void window.open(GUIDE_URL, '_blank', 'noopener')
export const emailSupport = (): void => void location.assign(`mailto:${SUPPORT_EMAIL}`)

/** The plan while the app is in beta (11-01): free, with a promise of notice. Never "free forever". */
export const PLAN = 'Free during beta'
export const PLAN_DETAIL = 'Aggregate is free while we’re in beta. We may introduce paid plans later, and we’ll let you know before anything changes.'
