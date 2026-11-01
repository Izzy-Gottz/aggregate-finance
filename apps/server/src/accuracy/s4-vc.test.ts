// S4 VC, checked against its independent answer key to the cent (docs/accuracy/README.md).
// Regenerate the key with `python3 scripts/accuracy/key.py s4-vc`.
import { join } from 'node:path'
import { accuracySuite } from './run.ts'

accuracySuite(join(import.meta.dirname, 's4-vc'), 'accuracy S4: vc')
