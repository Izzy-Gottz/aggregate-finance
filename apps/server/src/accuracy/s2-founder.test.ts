// S2 Solo founder, checked against its independent answer key to the cent (docs/accuracy/README.md).
// Regenerate the key with `python3 scripts/accuracy/key.py s2-founder`.
import { join } from 'node:path'
import { accuracySuite } from './run.ts'

accuracySuite(join(import.meta.dirname, 's2-founder'), 'accuracy S2: solo founder')
