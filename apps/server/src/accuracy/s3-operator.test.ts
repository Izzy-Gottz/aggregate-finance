// S3 Operator, checked against its independent answer key to the cent (docs/accuracy/README.md).
// Regenerate the key with `python3 scripts/accuracy/key.py s3-operator`.
import { join } from 'node:path'
import { accuracySuite } from './run.ts'

accuracySuite(join(import.meta.dirname, 's3-operator'), 'accuracy S3: operator')
