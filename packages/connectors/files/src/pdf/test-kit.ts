// Test only (the Docker image drops test-kit.ts): a tiny PDF writer for synthetic statements. Text goes at exact
// coordinates in Helvetica, so a test can lay out any bank's columns with made-up names and numbers. No real
// statement is ever committed.
import { createHash } from 'node:crypto'

export interface PdfText {
  x: number
  y: number
  text: string
  size?: number
}

export interface PdfPage {
  texts?: PdfText[]
  /** Draw a filled box and no text (a page that is only a picture, like a scan). */
  imageOnly?: boolean
}

export interface MakePdf {
  pages: PdfPage[]
  /** Encrypt with this user password (RC4 40-bit, standard security handler revision 2). */
  userPassword?: string
  /** Replace the page font dictionary (for hostile-font fixtures). Written as-is. */
  fontDict?: string
  /** Extra objects appended verbatim, numbered after the generated ones; `{n}` in fontDict refers to the first. */
  extraObjects?: string[]
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

/** A single-file PDF 1.4 with an xref table. Returns bytes. */
export function makePdf(spec: MakePdf): Uint8Array {
  const objs: string[] = []
  const add = (body: string) => objs.push(body) // object number = index + 1
  const n = spec.pages.length
  // 1 catalog, 2 pages, 3 font, then per page: page object + content stream.
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add(`<< /Type /Pages /Count ${n} /Kids [${spec.pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] >>`)
  const firstExtra = 4 + n * 2
  add((spec.fontDict ?? '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>').replace(/\{n\}/g, String(firstExtra)))
  for (const [i, p] of spec.pages.entries()) {
    const ops = p.imageOnly
      ? '0.6 g 50 50 500 700 re f'
      : (p.texts ?? []).map((t) => `BT /F1 ${t.size ?? 10} Tf 1 0 0 1 ${t.x} ${t.y} Tm (${esc(t.text)}) Tj ET`).join('\n')
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`)
    add(`<< /Length ${Buffer.byteLength(ops, 'latin1')} >>\nstream\n${ops}\nendstream`)
  }
  for (const e of spec.extraObjects ?? []) add(e)

  let trailerExtra = ''
  if (spec.userPassword !== undefined) {
    const enc = rc4Security(spec.userPassword, 'owner-' + spec.userPassword)
    add(enc.dict)
    trailerExtra = ` /Encrypt ${objs.length} 0 R /ID [<${enc.id}> <${enc.id}>]`
  }

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
  const offsets: number[] = []
  for (const [i, body] of objs.entries()) {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  }
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(out, 'latin1'))
}

// --- standard security handler, revision 2 (enough to make a PDF that needs a password to open) ---

const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex')
const padded = (pw: string) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32)
const md5 = (...parts: Buffer[]) => createHash('md5').update(Buffer.concat(parts)).digest()

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i)
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255
    ;[s[i], s[j]] = [s[j]!, s[i]!]
  }
  const out = Buffer.alloc(data.length)
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255
    j = (j + s[i]!) & 255
    ;[s[i], s[j]] = [s[j]!, s[i]!]
    out[k] = data[k]! ^ s[(s[i]! + s[j]!) & 255]!
  }
  return out
}

function rc4Security(user: string, owner: string): { dict: string; id: string } {
  const id = createHash('md5').update(`agfn-test-${user}`).digest()
  const o = rc4(md5(padded(owner)).subarray(0, 5), padded(user))
  const p = -4 // all permissions
  const pBytes = Buffer.alloc(4)
  pBytes.writeInt32LE(p)
  const key = md5(padded(user), o, pBytes, id).subarray(0, 5)
  const u = rc4(key, PAD)
  return { dict: `<< /Filter /Standard /V 1 /R 2 /O <${o.toString('hex')}> /U <${u.toString('hex')}> /P ${p} >>`, id: id.toString('hex') }
}
