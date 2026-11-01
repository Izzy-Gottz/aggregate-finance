// A small, strict XML reader for bank statements (ISO 20022 camt). No DTDs: a DOCTYPE or ENTITY declaration is
// refused outright, so external entities (XXE) and entity expansion ("billion laughs") can't happen. Only the five
// predefined entities and numeric character references are decoded. Namespaces prefixes are dropped from names.

import { invalid } from './text.ts'

export interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
  /** 1-based line where the element starts. */
  line: number
}

export interface XmlLimits {
  /** Most elements in one document (default 2,000,000). */
  maxElements?: number
  /** Deepest nesting (default 64). */
  maxDepth?: number
}

const PREDEFINED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(s: string, line: number): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);?/g, (all, ref: string) => {
    if (!all.endsWith(';')) throw invalid(`line ${line}: bare "&" in XML text`, 'xml_malformed')
    if (ref[0] === '#') {
      const cp = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
      if (!Number.isFinite(cp) || cp < 1 || cp > 0x10ffff) throw invalid(`line ${line}: bad character reference ${all}`, 'xml_malformed')
      return String.fromCodePoint(cp)
    }
    const v = PREDEFINED[ref]
    if (v === undefined) throw invalid(`line ${line}: unknown entity ${all} (DTD entities aren't allowed)`, 'xml_entity')
    return v
  })
}

const local = (qname: string) => qname.slice(qname.indexOf(':') + 1)

/** Parse a whole document; returns the root element. Throws invalid_input on anything malformed or unsafe. */
export function parseXml(text: string, limits: XmlLimits = {}): XmlNode {
  const maxElements = limits.maxElements ?? 2_000_000
  const maxDepth = limits.maxDepth ?? 64
  const stack: XmlNode[] = []
  let root: XmlNode | undefined
  let count = 0
  let line = 1
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const advance = (to: number) => {
    for (let k = i; k < to; k++) if (text.charCodeAt(k) === 10) line++
    i = to
  }
  const need = (marker: string, from: number, what: string) => {
    const at = text.indexOf(marker, from)
    if (at < 0) throw invalid(`line ${line}: unterminated ${what}`, 'xml_malformed')
    return at
  }

  while (i < text.length) {
    const lt = text.indexOf('<', i)
    const chunk = lt < 0 ? text.slice(i) : text.slice(i, lt)
    if (chunk) {
      const top = stack[stack.length - 1]
      if (top) top.text += decodeEntities(chunk, line)
      else if (chunk.trim()) throw invalid(`line ${line}: text outside the root element`, 'xml_malformed')
      advance(lt < 0 ? text.length : lt)
    }
    if (lt < 0) break

    if (text.startsWith('<?', i)) {
      advance(need('?>', i + 2, 'processing instruction') + 2)
    } else if (text.startsWith('<!--', i)) {
      advance(need('-->', i + 4, 'comment') + 3)
    } else if (text.startsWith('<![CDATA[', i)) {
      const end = need(']]>', i + 9, 'CDATA section')
      const top = stack[stack.length - 1]
      if (!top) throw invalid(`line ${line}: CDATA outside the root element`, 'xml_malformed')
      top.text += text.slice(i + 9, end)
      advance(end + 3)
    } else if (text.startsWith('<!', i)) {
      // <!DOCTYPE …> and <!ENTITY …>: never processed, always refused.
      throw invalid(`line ${line}: DOCTYPE and ENTITY declarations aren't allowed in statement files`, 'xml_doctype')
    } else if (text.startsWith('</', i)) {
      const end = need('>', i + 2, 'closing tag')
      const name = local(text.slice(i + 2, end).trim())
      const open = stack.pop()
      if (!open || open.name !== name) throw invalid(`line ${line}: </${name}> doesn't close ${open ? `<${open.name}>` : 'anything'}`, 'xml_malformed')
      advance(end + 1)
    } else {
      // Start tag: name, attributes (quoted), optional self-close.
      let j = i + 1
      let quote = ''
      for (; j < text.length; j++) {
        const ch = text[j]
        if (quote) {
          if (ch === quote) quote = ''
        } else if (ch === '"' || ch === "'") quote = ch
        else if (ch === '>') break
        else if (ch === '<') throw invalid(`line ${line}: "<" inside a tag`, 'xml_malformed')
      }
      if (j >= text.length) throw invalid(`line ${line}: unterminated tag`, 'xml_malformed')
      const body = text.slice(i + 1, j)
      const selfClose = body.endsWith('/')
      const inner = selfClose ? body.slice(0, -1) : body
      const m = /^([A-Za-z_][\w.:-]*)/.exec(inner)
      if (!m) throw invalid(`line ${line}: bad tag name`, 'xml_malformed')
      const attrs: Record<string, string> = {}
      const rest = inner.slice(m[1]!.length)
      const attrRe = /\s+([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g
      let consumed = 0
      for (let a = attrRe.exec(rest); a; a = attrRe.exec(rest)) {
        if (a.index !== consumed) break
        attrs[local(a[1]!)] = decodeEntities(a[3] ?? a[4] ?? '', line)
        consumed = attrRe.lastIndex
      }
      if (rest.slice(consumed).trim()) throw invalid(`line ${line}: bad attributes on <${m[1]}>`, 'xml_malformed')
      if (++count > maxElements) throw invalid(`statement file has more than ${maxElements} XML elements`, 'file_too_large')
      const node: XmlNode = { name: local(m[1]!), attrs, children: [], text: '', line }
      const parent = stack[stack.length - 1]
      if (parent) parent.children.push(node)
      else if (root) throw invalid(`line ${line}: more than one root element`, 'xml_malformed')
      else root = node
      if (!selfClose) {
        if (stack.length >= maxDepth) throw invalid(`line ${line}: XML nested deeper than ${maxDepth}`, 'xml_malformed')
        stack.push(node)
      }
      advance(j + 1)
    }
  }
  if (stack.length) throw invalid(`<${stack[stack.length - 1]!.name}> is never closed`, 'xml_malformed')
  if (!root) throw invalid('no XML root element', 'xml_malformed')
  return root
}

/** First child element by local name (path like 'Acct/Id/IBAN'). */
export function child(node: XmlNode | undefined, path: string): XmlNode | undefined {
  let cur = node
  for (const part of path.split('/')) {
    cur = cur?.children.find((c) => c.name === part)
    if (!cur) return undefined
  }
  return cur
}

export function children(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : []
}

/** Trimmed text at a path, or undefined when absent or empty. */
export function textAt(node: XmlNode | undefined, path: string): string | undefined {
  const t = child(node, path)?.text.trim()
  return t ? t : undefined
}
