// 20px line icons (Lucide-style geometry, drawn here so we ship no icon package). Decorative: always aria-hidden,
// the text next to each icon carries the meaning.
import { html } from './html.ts'

const P: Record<string, string> = {
  chevron: 'M9 6l6 6-6 6',
  back: 'M15 6l-6 6 6 6',
  close: 'M6 6l12 12M18 6L6 18',
  bank: 'M3 10h18M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18M12 3l9 5H3z',
  card: 'M3 6h18v12H3zM3 10h18M7 15h3',
  cash: 'M3 7h18v10H3zM12 9.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM6 10v4M18 10v4',
  file: 'M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h6',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6',
  check: 'M5 12l5 5 9-10',
  plus: 'M12 5v14M5 12h14',
  menu: 'M4 7h16M4 12h16M4 17h16',
  down: 'M6 9l6 6 6-6',
  person: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  key: 'M15 7a4 4 0 11-3.9 4.9L4 19v2h3v-2h2v-2h2l1.1-1.1A4 4 0 0115 7z',
  bucket: 'M4 7h16l-2 13H6zM8 7a4 4 0 018 0',
  alert: 'M12 4l9 16H3zM12 10v4M12 17v.5',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  pause: 'M9 5v14M15 5v14',
}

export type IconName = keyof typeof P

export const Icon = ({ name, size = 20 }: { name: IconName; size?: number }) =>
  html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d=${P[name]} /></svg>`
