// Leave for a URL the server handed back (an OAuth step). The consent page lives at /#/connect-ai/consent, so from the
// sign-in page (/#/sign-in?…) only the hash changes and the browser wouldn't load anything: the app, still signed out in
// memory, would bounce straight back to sign-in. Load the page fresh instead, so it starts with the new session.
export function leaveFor(url: string): void {
  const to = new URL(url, location.href)
  if (to.origin === location.origin && to.pathname === location.pathname && to.search === location.search) {
    location.replace(to.href)
    location.reload()
  } else location.assign(to.href)
}
