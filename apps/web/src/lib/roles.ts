import type { DataType } from '@agfn/contracts'
import type { RolePreset } from '../api/types.ts'

/** Role presets → the full grid (MASTER §2 Roles). */
export function gridFor(role: RolePreset): Record<DataType, 'none' | 'view' | 'add'> {
  const all = (v: 'none' | 'view' | 'add'): Record<DataType, 'none' | 'view' | 'add'> => ({
    balances: v, transactions: v, invoices: v, bills: v, buckets: v, payroll: v, equity: v, documents: v, reports: v, personal: 'none',
  })
  switch (role) {
    case 'owner':
    case 'admin':
      return all('add')
    case 'finance':
      return { ...all('add'), equity: 'view' }
    case 'accountant':
      return { ...all('view'), documents: 'add', payroll: 'none', equity: 'none' }
    case 'investor':
      return { ...all('none'), balances: 'view', reports: 'view', equity: 'view' }
    case 'employee':
      return { ...all('none'), documents: 'add' }
  }
}
