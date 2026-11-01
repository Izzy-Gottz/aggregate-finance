// A typed or pasted email, tidied before it's checked: surrounding spaces and the full stop of a copied sentence
// ("me@x.com.") are dropped, so they never read as "That doesn't look like an email address."
export const cleanEmail = (s: string) => s.trim().replace(/\.$/, '').trim()
