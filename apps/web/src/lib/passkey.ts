/** A readable default name for a new passkey, e.g. "Mac" or "iPhone". */
export function passkeyName(): string {
  const ua = navigator.userAgent
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : 'This device'
}

/** Browsers offer passkeys only on https or localhost: a self-hosted server on http://<LAN IP> can't use them. */
export function passkeysAvailable(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && typeof (window as { PublicKeyCredential?: unknown }).PublicKeyCredential !== 'undefined'
}
