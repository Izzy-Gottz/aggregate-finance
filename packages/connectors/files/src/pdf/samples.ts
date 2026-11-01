// Synthetic statements in each bank's layout (Latin-1 text only: the test PDF font can't carry •, – or −) (made-up names, numbers and account numbers), for tests and for
// checking a layout by eye. Test only: not imported by the connector.
import { makePdf, type PdfText } from './test-kit.ts'

type Row = [date: string, description: string, amount: string, balance?: string]

/** Lines top to bottom; a line is cells at x positions. */
function page(lines: Array<Array<[number, string]>>): PdfText[] {
  return lines.flatMap((cells, i) => cells.map(([x, text]) => ({ x, y: 760 - i * 14, text, size: 9 })))
}
const row = ([d, desc, amt, bal]: Row): Array<[number, string]> => [[50, d], [110, desc], [430, amt], ...(bal ? ([[510, bal]] as Array<[number, string]>) : [])]
const one = (text: string): Array<[number, string]> => [[50, text]]

export interface ChaseCheckingOpts {
  opening?: string
  closing?: string
  rows?: Row[]
  period?: string
  wrap?: string
}

export function chaseChecking(o: ChaseCheckingOpts = {}): Uint8Array {
  const rows: Row[] = o.rows ?? [
    ['09/03', 'Card Purchase 09/02 Sample Coffee Co', '-4.50', '995.50'],
    ['09/15', 'Payroll Deposit Example Corp', '2,000.00', '2,995.50'],
    ['09/20', 'Online Transfer To Sav ...1111', '-500.00', '2,495.50'],
  ]
  const lines: Array<Array<[number, string]>> = [
    one('JPMorgan Chase Bank, N.A.'),
    one(o.period ?? 'September 1, 2026 through September 30, 2026'),
    one('Account Number: 000000123456789'),
    one('CHECKING SUMMARY'),
    [[50, 'Beginning Balance'], [430, `$${o.opening ?? '1,000.00'}`]],
    [[50, 'Ending Balance'], [430, `$${o.closing ?? '2,495.50'}`]],
    one('*start*transaction detail'),
    [[50, 'DATE'], [110, 'DESCRIPTION'], [430, 'AMOUNT'], [510, 'BALANCE']],
    [[110, 'Beginning Balance'], [510, `$${o.opening ?? '1,000.00'}`]],
    ...rows.flatMap((r, i) => (i === 0 && o.wrap ? [row(r), [[110, o.wrap]] as Array<[number, string]>] : [row(r)])),
    [[110, 'Ending Balance'], [510, `$${o.closing ?? '2,495.50'}`]],
    one('*end*transaction detail'),
    one('Page 1 of 1'),
  ]
  return makePdf({ pages: [{ texts: page(lines) }] })
}

export function chaseCard(o: { newBalance?: string; period?: string; rows?: { payments?: Row[]; purchases?: Row[] }; couponBox?: boolean; authorizedUser?: boolean } = {}): Uint8Array {
  const payments = o.rows?.payments ?? [['12/30', 'Payment Thank You - Web', '-300.00']]
  const purchases = o.rows?.purchases ?? [
    ['12/28', 'SAMPLE BOOKSTORE PORTLAND OR', '25.00'],
    ['01/05', 'EXAMPLE AIRLINES 800-555-0100', '410.25'],
  ]
  const lines: Array<Array<[number, string]>> = [
    one('Manage your account online: www.chase.com/cardhelp'),
    // The payment coupon: "New Balance" in a heading row, its figure on the line below (before the summary's own line).
    ...(o.couponBox
      ? ([
          [[50, 'Payment Due Date'], [200, 'New Balance'], [350, 'Minimum Payment Due']],
          [[50, '02/12/26'], [200, `$${o.newBalance ?? (o.authorizedUser ? '680.25' : '635.25')}`], [350, '$40.00']],
        ] as Array<Array<[number, string]>>)
      : []),
    one('ACCOUNT SUMMARY'),
    one('Account Number: XXXX XXXX XXXX 4321'),
    [[50, 'Previous Balance'], [430, '$500.00']],
    [[50, 'Payment, Credits'], [430, '-$300.00']],
    [[50, 'Purchases'], [430, '+$435.25']],
    [[50, 'New Balance'], [430, `$${o.newBalance ?? '635.25'}`]],
    one(o.period ?? 'Opening/Closing Date 12/16/25 - 01/15/26'),
    one('ACCOUNT ACTIVITY'),
    [[50, 'Date of Transaction'], [110, 'Merchant Name or Transaction Description'], [430, '$ Amount']],
    one('PAYMENTS AND OTHER CREDITS'),
    ...payments.map(row),
    one('PURCHASE'),
    ...purchases.map(row),
    // An authorized user's own list, each card closed by its "TRANSACTIONS THIS CYCLE (CARD …)" subtotal.
    ...(o.authorizedUser
      ? ([
          [[50, 'SAMPLE HOLDER'], [300, 'TRANSACTIONS THIS CYCLE (CARD 4321) $135.25']],
          one('OTHER MEMBER'),
          one('PURCHASE'),
          row(['01/09', 'EXAMPLE PHARMACY SALEM OR', '45.00']),
          [[50, 'OTHER MEMBER'], [300, 'TRANSACTIONS THIS CYCLE (CARD 8765) $45.00']],
        ] as Array<Array<[number, string]>>)
      : []),
    one('2026 Totals Year-to-Date'),
    [[50, 'Total fees charged in 2026'], [430, '$0.00']],
  ]
  return makePdf({ pages: [{ texts: page(lines) }] })
}

export function bofaChecking(o: { depositsTotal?: string; withdrawals?: Row[] } = {}): Uint8Array {
  const withdrawals = o.withdrawals ?? [
    ['09/05/26', 'CHECKCARD 0904 SAMPLE HARDWARE', '-62.10'],
    ['09/18/26', 'ONLINE BANKING TRANSFER TO CHK 9999', '-200.00'],
  ]
  const lines: Array<Array<[number, string]>> = [
    one('Bank of America, N.A.'),
    one('Your Adv Plus Banking'),
    one('for September 1, 2026 to September 30, 2026'),
    one('Account number: 1234 5678 9012'),
    [[50, 'Beginning balance on September 1, 2026'], [430, '$3,000.00']],
    [[50, 'Deposits and other additions'], [430, '1,500.00']],
    [[50, 'Withdrawals and other subtractions'], [430, '-262.10']],
    [[50, 'Checks'], [430, '-125.00']],
    [[50, 'Service fees'], [430, '-12.00']],
    [[50, 'Ending balance on September 30, 2026'], [430, '$4,100.90']],
    one('Deposits and other additions'),
    [[50, 'Date'], [110, 'Description'], [430, 'Amount']],
    row(['09/15/26', 'EXAMPLE CORP DES:PAYROLL ID:XXXXX', '1,500.00']),
    [[50, 'Total deposits and other additions'], [430, `$${o.depositsTotal ?? '1,500.00'}`]],
    one('Withdrawals and other subtractions'),
    ...withdrawals.map(row),
    [[50, 'Total withdrawals and other subtractions'], [430, '-$262.10']],
    one('Checks'),
    [[50, '09/10/26'], [110, '1001'], [200, '-50.00'], [280, '09/22/26'], [340, '1002'], [430, '-75.00']],
    [[50, 'Total checks'], [430, '-$125.00']],
    one('Service fees'),
    row(['09/30/26', 'Monthly Maintenance Fee', '-12.00']),
    [[50, 'Total service fees'], [430, '-$12.00']],
    one('Daily ledger balances'),
    [[50, '09/05'], [110, '2,937.90'], [200, '09/15'], [280, '4,437.90']],
  ]
  return makePdf({ pages: [{ texts: page(lines) }] })
}

export function amex(o: { newBalance?: string } = {}): Uint8Array {
  const lines: Array<Array<[number, string]>> = [
    one('American Express'),
    [[50, 'Closing Date 09/27/26'], [300, 'Account Ending 7-65432']],
    one('Days in Billing Period: 30'),
    [[50, 'Previous Balance'], [430, '$1,200.00']],
    [[50, 'Payments/Credits'], [430, '-$1,200.00']],
    [[50, 'New Charges'], [430, '+$88.40']],
    [[50, 'New Balance'], [430, `$${o.newBalance ?? '88.40'}`]],
    one('Payments and Credits'),
    one('Detail'),
    row(['09/02/26*', 'AUTOPAY PAYMENT RECEIVED - THANK YOU', '-$1,200.00'].map((c) => c.replace('*', '')) as Row),
    one('New Charges'),
    one('Detail'),
    row(['09/10/26', 'SAMPLE BAKERY BROOKLYN NY', '$12.40']),
    [[110, 'BAKERY']],
    row(['09/21/26', 'EXAMPLE TRANSIT 800-555-0199 NY', '$76.00']),
    one('Fees'),
    [[50, 'Total Fees for this Period'], [430, '$0.00']],
    one('Interest Charge Calculation'),
  ]
  return makePdf({ pages: [{ texts: page(lines) }] })
}

export function bofaCard(o: { purchasesTotal?: string } = {}): Uint8Array {
  const lines: Array<Array<[number, string]>> = [
    one('Bank of America'),
    one('August 22 - September 21, 2026'),
    one('Account# XXXX XXXX XXXX 2468'),
    [[50, 'Previous Balance'], [430, '$740.00']],
    [[50, 'Payments and Other Credits'], [430, '-$740.00']],
    [[50, 'Purchases and Adjustments'], [430, '$59.99']],
    [[50, 'New Balance Total'], [430, '$59.99']],
    one('Payments and Other Credits'),
    [[50, '09/01'], [100, '09/01'], [150, 'PAYMENT - THANK YOU'], [400, '4521'], [440, '2468'], [490, '-740.00']],
    [[50, 'TOTAL PAYMENTS AND OTHER CREDITS FOR THIS PERIOD'], [430, '-$740.00']],
    one('Purchases and Adjustments'),
    [[50, '08/30'], [100, '08/31'], [150, 'SAMPLE SOFTWARE CO 800-555-0123 CA'], [400, '7731'], [440, '2468'], [490, '59.99']],
    [[50, 'TOTAL PURCHASES AND ADJUSTMENTS FOR THIS PERIOD'], [430, `$${o.purchasesTotal ?? '59.99'}`]],
    one('2026 Totals Year-to-Date'),
  ]
  return makePdf({ pages: [{ texts: page(lines) }] })
}

export function wellsChecking(o: { closing?: string } = {}): Uint8Array {
  const lines: Array<Array<[number, string]>> = [
    one('Wells Fargo Everyday Checking'),
    one('September 30, 2026'),
    one('Account number: 9876543210'),
    [[50, 'Beginning balance on 9/1'], [430, '$1,000.00']],
    [[50, 'Deposits/Additions'], [430, '800.00']],
    [[50, 'Withdrawals/Subtractions'], [430, '- 135.25']],
    [[50, 'Ending balance on 9/30'], [430, `$${o.closing ?? '1,664.75'}`]],
    one('Transaction history'),
    [[50, 'Date'], [90, 'Check'], [150, 'Description'], [300, 'Deposits/Additions'], [400, 'Withdrawals/Subtractions'], [510, 'Ending daily balance']],
    [[50, '9/2'], [150, 'Sample Grocer Purchase'], [400, '35.25'], [510, '964.75']],
    [[50, '9/12'], [150, 'Example Co Payroll'], [300, '800.00']],
    [[50, '9/12'], [90, '1201'], [150, 'Check'], [400, '100.00'], [510, '1,664.75']],
    [[50, 'Ending balance on 9/30'], [510, '1,664.75']],
    [[50, 'Totals'], [300, '$800.00'], [400, '$135.25']],
  ]
  return makePdf({ pages: [{ texts: page(lines) }] })
}

export function citiCard(o: { newBalance?: string } = {}): Uint8Array {
  const lines: Array<Array<[number, string]>> = [
    one('Citi Double Cash Card'),
    one('Billing Period: 08/23/26-09/22/26'.replace('-', ' - ')),
    one('Account number ending in: 1357'),
    [[50, 'Previous balance'], [430, '$300.00']],
    [[50, 'Payments'], [430, '-$300.00']],
    [[50, 'Purchases'], [430, '+$45.60']],
    [[50, 'New balance'], [430, `$${o.newBalance ?? '45.60'}`]],
    one('Payments, Credits and Adjustments'),
    [[50, '09/05'], [90, '09/05'], [150, 'AUTOPAY 999990000012345RAUTOPAY AUTO-PMT'], [450, '-$300.00']],
    one('Standard Purchases'),
    [[50, '08/30'], [90, '08/31'], [150, 'SAMPLE PHARMACY ANYTOWN US'], [450, '$15.60']],
    [[50, '09/14'], [90, '09/15'], [150, 'EXAMPLE PARKING ANYTOWN US'], [450, '$30.00']],
    one('Fees Charged'),
    [[50, 'Total fees charged this period'], [450, '$0.00']],
    one('2026 totals year-to-date'),
  ]
  return makePdf({ pages: [{ texts: page(lines) }] })
}

export function capOneCard(o: { newBalance?: string; summaryHeading?: boolean; twoHolders?: boolean } = {}): Uint8Array {
  const lines: Array<Array<[number, string]>> = [
    one('Capital One Quicksilver'),
    one('Aug 23, 2026 - Sep 22, 2026 | 31 days in Billing Cycle'),
    one('Account ending in 8642'),
    // Real statements open with a summary box whose heading row names "New Balance" among other labels (no amount after it).
    ...(o.summaryHeading ? [[[50, 'New Balance'], [160, 'Minimum Payment Due'], [300, 'Fees Charged'], [430, '+ $0.00']] as Array<[number, string]>] : []),
    [[50, 'Previous Balance'], [430, '$120.00']],
    [[50, 'New Balance'], [430, `= $${o.newBalance ?? '64.10'}`]],
    one('Payments, Credits and Adjustments'),
    [[50, 'Sep 1'], [90, 'Sep 1'], [150, 'CAPITAL ONE AUTOPAY PYMT'], [450, '- $120.00']],
    one('SAMPLE HOLDER #8642: Transactions'),
    [[50, 'Trans Date'], [90, 'Post Date'], [150, 'Description'], [450, 'Amount']],
    [[50, 'Aug 25'], [90, 'Aug 26'], [150, 'SAMPLE TACOS ANYTOWN'], [450, '$14.10']],
    [[50, 'Sep 10'], [90, 'Sep 11'], [150, 'EXAMPLE STREAMING'], [450, '$50.00']],
    // An authorized user: their own Payments and Transactions lists and subtotal, then one total for the whole card.
    // A foreign purchase carries three detail lines (amount in the other currency, currency, rate).
    ...(o.twoHolders
      ? ([
          [[50, 'SAMPLE HOLDER #8642: Total Transactions'], [450, '$64.10']],
          one('OTHER HOLDER #9753: Payments, Credits and Adjustments'),
          [[50, 'Trans Date'], [90, 'Post Date'], [150, 'Description'], [450, 'Amount']],
          one('OTHER HOLDER #9753: Transactions'),
          [[50, 'Trans Date'], [90, 'Post Date'], [150, 'Description'], [450, 'Amount']],
          [[50, 'Sep 12'], [90, 'Sep 13'], [150, 'EXAMPLE CAFE ABROAD'], [450, '$10.00']],
          [[150, '9.20']],
          [[150, 'EURO']],
          [[150, '* 1.0870 Exchange Rate']],
          [[50, 'OTHER HOLDER #9753: Total Transactions'], [450, '$10.00']],
        ] as Array<Array<[number, string]>>)
      : []),
    [[50, 'Total Transactions for This Period'], [450, o.twoHolders ? '$74.10' : '$64.10']],
    one('Totals Year-to-Date'),
  ]
  return makePdf({ pages: [{ texts: page(lines) }] })
}

export function usBankChecking(o: { closing?: string } = {}): Uint8Array {
  const lines: Array<Array<[number, string]>> = [
    one('U.S. Bank Smartly Checking'),
    one('Statement Period: Sep 1, 2026 through Sep 30, 2026'),
    one('Account Number: 1-234-5678-9012'),
    [[50, 'Beginning Balance on Sep 1'], [430, '$500.00']],
    [[50, 'Ending Balance on Sep 30, 2026'], [430, `$${o.closing ?? '1,377.01'}`]],
    one('Customer Deposits'),
    [[50, 'Sep 15'], [150, 'Mobile Check Deposit'], [450, '1,000.00']],
    [[50, 'Total Customer Deposits'], [450, '$1,000.00']],
    one('Other Withdrawals'),
    [[50, 'Sep 4'], [150, 'Electronic Withdrawal To SAMPLE UTILITY'], [450, '72.99-']],
    [[50, 'Sep 20'], [150, 'Debit Purchase EXAMPLE MARKET'], [450, '50.00-']],
    [[50, 'Total Other Withdrawals'], [450, '$122.99-']],
    one('Balance Summary'),
  ]
  return makePdf({ pages: [{ texts: page(lines) }] })
}

export function pncChecking(o: { ending?: string } = {}): Uint8Array {
  const lines: Array<Array<[number, string]>> = [
    one('PNC Bank Virtual Wallet'),
    one('For the period 09/01/2026 to 09/30/2026'),
    one('Primary account number: XX-XXXX-2580'),
    one('Balance Summary'),
    [[50, 'Beginning balance'], [170, 'Deposits and other additions'], [310, 'Checks and other deductions'], [450, 'Ending balance']],
    [[50, '2,000.00'], [170, '650.00'], [310, '210.40'], [450, o.ending ?? '2,439.60']],
    one('Deposits and Other Additions'),
    one('ACH Additions'),
    [[50, '09/15'], [110, '650.00'], [200, 'Direct Deposit - Example Payroll']],
    one('Checks and Other Deductions'),
    one('Debit Card Purchases'),
    [[50, '09/06'], [110, '10.40'], [200, '1234 Debit Card Purchase Sample Cafe']],
    one('ACH Deductions'),
    [[50, '09/25'], [110, '200.00'], [200, 'Corporate ACH Sample Insurance']],
    one('Daily Balance Detail'),
  ]
  return makePdf({ pages: [{ texts: page(lines) }] })
}

export function mercury(o: { ending?: string } = {}): Uint8Array {
  const lines: Array<Array<[number, string]>> = [
    one('Mercury'),
    one('Checking ..4455'),
    one('Sep 1, 2026 - Sep 30, 2026'),
    [[50, 'Starting balance'], [430, '$10,000.00']],
    [[50, 'Money in'], [430, '$2,500.00']],
    [[50, 'Money out'], [430, '-$1,250.00']],
    [[50, 'Ending balance'], [430, `$${o.ending ?? '11,250.00'}`]],
    one('Transactions'),
    [[50, 'Date'], [110, 'Description'], [430, 'Amount']],
    [[50, 'Sep 03'], [110, 'Sample Cloud Hosting'], [430, '-$1,250.00']],
    [[50, 'Sep 15'], [110, 'Example Customer Inc'], [430, '$2,500.00']],
  ]
  return makePdf({ pages: [{ texts: page(lines) }] })
}
