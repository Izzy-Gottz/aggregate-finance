// S1 Individual, checked against its independent answer key to the cent (docs/accuracy/README.md).
// Regenerate the key with `python3 scripts/accuracy/key.py s1-individual`.
import { join } from 'node:path'
import { accuracySuite } from './run.ts'

accuracySuite(join(import.meta.dirname, 's1-individual'), 'accuracy S1: individual')
