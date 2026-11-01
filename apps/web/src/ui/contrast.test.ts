// WCAG contrast for every text/background pair the design system uses, in both themes (MASTER §2 Look; ux.md §10).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!]))
}
const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf(":root[data-theme='dark']")))
const dark = { ...light, ...tokens(css.slice(css.indexOf(":root[data-theme='dark']"), css.indexOf('@media (max-width'))) }

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}
export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

const PAIRS: Array<[fg: string, bg: string, min: number]> = [
  ['ink', 'page', 7],
  ['ink', 'surface', 7],
  ['grey', 'page', 4.5],
  ['grey', 'surface', 4.5],
  ['grey', 'hover', 4.5],
  ['red', 'page', 4.5],
  ['red', 'surface', 4.5],
  ['amber', 'page', 4.5],
  ['amber', 'surface', 4.5],
  ['btn-ink', 'btn', 7],
  ['ink', 'tile', 7],
  ['grey', 'tile', 4.5],
  // Non-text: a field's or segmented control's edge, and a link's underline (WCAG 1.4.11).
  ['edge', 'page', 3],
  ['edge', 'surface', 3],
]

describe('contrast', () => {
  it('reads the two themes apart', () => expect(light.page).not.toBe(dark.page))
  for (const [name, t] of [['light', light], ['dark', dark]] as const) {
    for (const [fg, bg, min] of PAIRS) {
      it(`${name}: ${fg} on ${bg} ≥ ${min}:1`, () => {
        expect(t[fg], fg).toBeTruthy()
        expect(contrast(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(min)
      })
    }
  }
})
