// S5 Same money, checked against its independent answer key to the cent (docs/accuracy/README.md).
// Regenerate the key with `python3 scripts/accuracy/key.py s5-same-money`.
import { join } from 'node:path'
import { accuracySuite } from './run.ts'

accuracySuite(join(import.meta.dirname, 's5-same-money'), 'accuracy S5: same money')
