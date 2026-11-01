import { randomBytes } from 'node:crypto'

// Prints fresh secrets for .env. Nothing is written to disk.
console.log(`AUTH_SECRET=${randomBytes(32).toString('base64url')}`)
console.log(`AGFN_MASTER_KEY=${randomBytes(32).toString('base64')}`)
