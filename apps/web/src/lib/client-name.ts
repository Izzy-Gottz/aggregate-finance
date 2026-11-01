/**
 * The AI's name on the consent screen. A client that identifies by a metadata-document URL (CIMD) names itself, so
 * its verified host is shown too: "Example AI (client.example)". A registered client's name is shown as it is.
 */
export function shownClientName(clientId: string, name: string | undefined): string {
  const shown = name?.trim() || 'Your AI'
  let host: string | undefined
  try {
    const u = new URL(clientId)
    if (u.protocol === 'https:') host = u.hostname.toLowerCase()
  } catch {
    /* an opaque registered client id */
  }
  return host && !shown.toLowerCase().includes(host) ? `${shown} (${host})` : shown
}
