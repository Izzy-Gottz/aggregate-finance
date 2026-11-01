// @agfn/connector-payroll-detect: payroll without a payroll API.
// Bank-row detection (estimated runs + settlement links) and payroll register CSV upload.
import type { ConnectorDescription } from '@agfn/contracts'

export * from './detect.ts'
export * from './register.ts'

export const PAYROLL_DETECT: ConnectorDescription = {
  key: 'payroll-detect',
  name: 'Payroll from bank',
  group: 'payroll',
  provides: ['payroll'],
  freshness: 'updates with your bank feed; amounts are estimates',
  auth: 'none',
}

export const PAYROLL_REGISTER: ConnectorDescription = {
  key: 'payroll-register',
  name: 'Payroll report upload',
  group: 'payroll',
  provides: ['payroll'],
  freshness: 'updates when you upload a payroll register (CSV)',
  auth: 'file',
}
export * from './provider.ts'
