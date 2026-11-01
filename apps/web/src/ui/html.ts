import type { VNode } from 'preact'
import { html as bound } from 'htm/preact'

/** Tagged-template JSX for Preact (no build-time transform). */
export const html = bound as (strings: TemplateStringsArray, ...values: unknown[]) => VNode
