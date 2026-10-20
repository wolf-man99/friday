// Reading alert emails. Fixtures are typical wordings of Indian bank, card and
// wallet alerts (written for these tests, not taken from anyone's mailbox).

import assert from 'node:assert/strict'
import { htmlToText, institutionFor, INSTITUTION_DOMAINS, parseAlert, type ParsedAlert, type RawEmail, senderVerified } from '../_shared/alerts.ts'
import { DEFAULT_ALERT_SENDERS } from '../_shared/gmailQuery.ts'

const IST = { timeZone: 'Asia/Kolkata' }
/** 18 Oct 2026, 10:00 IST: when Gmail received most of these. */
const RECEIVED = Date.parse('2026-10-18T04:30:00Z')

function email(from: string, subject: string, text: string, extra: Partial<RawEmail> = {}): RawEmail {
  const domain = from.match(/@([^>\s]+)/)?.[1] ?? ''
  return {
    id: 'm1',
    internalDate: RECEIVED,
    from,
    subject,
    text,
    authResults: [`mx.google.com; dkim=pass header.i=@${domain} header.s=s1; spf=pass; dmarc=pass (p=REJECT) header.from=${domain}`],
    ...extra,
  }
}

function parsed(raw: RawEmail): ParsedAlert {
  const result = parseAlert(raw, IST)
  if (!result.ok) throw new Error(`expected a transaction, got skip ${result.skip}`)
  return result.alert
}

function expectFields(alert: ParsedAlert, expected: Partial<ParsedAlert> & { institutionKey?: string }) {
  const { institutionKey, ...rest } = expected
  if (institutionKey) assert.equal(alert.institution.key, institutionKey)
  for (const [key, value] of Object.entries(rest)) {
    assert.deepEqual(alert[key as keyof ParsedAlert], value, key)
  }
}

const HDFC = 'HDFC Bank InstaAlerts <alerts@hdfcbank.net>'

// -----------------------------------------------------------------------------
// Banks
// -----------------------------------------------------------------------------

Deno.test('HDFC UPI debit', () => {
  const alert = parsed(email(HDFC, '❗ You have done a UPI txn. Check details!',
    'Dear Customer, Rs.250.00 has been debited from account **1234 to VPA bluetokai@okaxis BLUE TOKAI on 18-10-26. Your UPI transaction reference number is 429182736451. If you did not authorize this transaction, please report it immediately by calling 18002586161. Warm Regards, HDFC Bank'))
  expectFields(alert, {
    institutionKey: 'hdfc', instrument: 'bank', accountMask: '1234', kind: 'expense', amountMinor: 25000, currency: 'INR',
    merchant: 'BLUE TOKAI', reference: '429182736451', entryStatus: 'posted', categoryHint: 'Food & dining',
    dateSource: 'text', senderVerified: true,
  })
  // A date without a time, on the day Gmail received it: the email's own time.
  assert.equal(alert.occurredAt, new Date(RECEIVED).toISOString())
  assert.ok(alert.confidence >= 0.9)
})

Deno.test('HDFC UPI credit', () => {
  const alert = parsed(email(HDFC, 'You have received money!',
    'Dear Customer, Rs.1500.00 has been credited to your account **1234 by VPA abc@okicici ANITA SHARMA on 17-10-26. Your UPI transaction reference number is 428812345678.'))
  expectFields(alert, { kind: 'income', amountMinor: 150000, accountMask: '1234', merchant: 'ANITA SHARMA', reference: '428812345678' })
  assert.equal(alert.occurredAt, '2026-10-17T06:30:00.000Z', 'no time given: midday IST')
})

Deno.test('HDFC credit card spend (both wordings)', () => {
  const older = parsed(email(HDFC, 'Alert : Update on your HDFC Bank Credit Card',
    'Dear Card Member, Thank you for using your HDFC Bank Credit Card ending 9001 for Rs 1,499.00 at AMAZON on 17-10-2026 12:30:45. Authorization code:- 123456'))
  expectFields(older, {
    instrument: 'credit_card', accountMask: '9001', kind: 'expense', amountMinor: 149900, merchant: 'AMAZON',
    categoryHint: 'Shopping', occurredAt: '2026-10-17T07:00:45.000Z',
  })
  const newer = parsed(email(HDFC, 'Rs.1499.00 debited via Credit Card **9001',
    'Dear Customer, Rs.1499.00 is debited from your HDFC Bank Credit Card ending 9001 towards AMAZON on 17 Oct, 2026 at 12:30:45. If you did not authorize this transaction, please call us.'))
  expectFields(newer, { instrument: 'credit_card', accountMask: '9001', kind: 'expense', amountMinor: 149900, merchant: 'AMAZON', occurredAt: '2026-10-17T07:00:45.000Z' })
})

Deno.test('HDFC NEFT salary credit', () => {
  const alert = parsed(email(HDFC, 'Account update for your HDFC Bank A/c',
    'Dear Customer, INR 85,000.00 deposited to A/c No XX1234 towards NEFT Cr-ICIC0000001-ACME PAYROLL SALARY OCT on 01-10-26. Avl Bal: INR 1,23,456.78'))
  expectFields(alert, { kind: 'income', amountMinor: 8500000, accountMask: '1234', categoryHint: 'Salary' })
})

Deno.test('ICICI account debit names the payee after the semicolon', () => {
  const alert = parsed(email('ICICI Bank <customercare@icicibank.com>', 'Transaction alert for your ICICI Bank account',
    'Dear Customer, ICICI Bank Acct XX234 debited for Rs 250.00 on 18-Oct-26; BLUETOKAI credited. UPI:429182736451. Call 18002662 for dispute. SMS BLOCK 234 to 9215676766.'))
  expectFields(alert, { kind: 'expense', amountMinor: 25000, accountMask: '234', merchant: 'BLUETOKAI', reference: '429182736451', instrument: 'bank' })
})

Deno.test('ICICI credit card', () => {
  const alert = parsed(email('ICICI Bank <credit_cards@icicibank.com>', 'Transaction alert for your ICICI Bank Credit Card',
    'Dear Customer, Your ICICI Bank Credit Card XX9001 has been used for a transaction of INR 1,499.00 on Oct 17, 2026 at 12:30:45. Info: AMAZON. The Available Credit Limit on your card is INR 98,501.00 and Total Credit Limit is INR 1,00,000.00.'))
  expectFields(alert, { instrument: 'credit_card', accountMask: '9001', kind: 'expense', amountMinor: 149900, merchant: 'AMAZON', occurredAt: '2026-10-17T07:00:45.000Z' })
  assert.ok(alert.confidence >= 0.9, 'credit limits aren\'t transaction amounts')
})

Deno.test('SBI account debit and credit', () => {
  const debit = parsed(email('SBI <donotreply.sbiatm@sbi.co.in>', 'Transaction Alert',
    'Dear Customer, Your A/C XXXXX1234 Debited INR 250.00 on 18/10/26 -Transferred to BLUE TOKAI. Avl Balance INR 12,345.67-SBI'))
  expectFields(debit, { kind: 'expense', amountMinor: 25000, accountMask: '1234', merchant: 'BLUE TOKAI' })
  const credit = parsed(email('SBI <donotreply.sbiatm@sbi.co.in>', 'Transaction Alert',
    'Dear Customer, your A/c XXXXXXXX1234 has been credited by Rs.1500.00 on 17Oct26 transfer from ANITA SHARMA Ref No 428812345678 -SBI'))
  expectFields(credit, { kind: 'income', amountMinor: 150000, accountMask: '1234', reference: '428812345678', occurredAt: '2026-10-17T06:30:00.000Z' })
})

Deno.test('SBI Card spend', () => {
  const alert = parsed(email('SBI Card <onlinesbicard@sbicard.com>', 'Transaction Alert from SBI Card',
    'Rs.1,499.00 spent on your SBI Credit Card ending 9001 at AMAZON on 17/10/26. Trxn. not done by you? Report at sbicard.com/Dispute'))
  expectFields(alert, { institutionKey: 'sbicard', instrument: 'credit_card', accountMask: '9001', kind: 'expense', amountMinor: 149900, merchant: 'AMAZON' })
})

Deno.test('Axis account UPI debit and card spend', () => {
  const upi = parsed(email('Axis Bank <alerts@axisbank.com>', 'Debit transaction alert',
    'INR 250.00 debited A/c no. XX1234 18-10-26, 08:15:32 UPI/P2M/429182736451/BLUE TOKAI Not you? SMS BLOCKUPI Cust ID to 919951860002 Axis Bank'))
  expectFields(upi, { kind: 'expense', amountMinor: 25000, accountMask: '1234', reference: '429182736451', occurredAt: '2026-10-18T02:45:32.000Z' })
  const card = parsed(email('Axis Bank <alerts@axisbank.com>', 'Transaction alert on Axis Bank Credit Card',
    'Transaction alert for your Axis Bank Credit Card no. XX9001: INR 1499 spent at AMAZON on 17-10-26 12:30:45 IST. Available limit: INR 48,501.'))
  expectFields(card, { instrument: 'credit_card', accountMask: '9001', kind: 'expense', amountMinor: 149900, merchant: 'AMAZON' })
})

Deno.test('Kotak sent and received', () => {
  const sent = parsed(email('Kotak Mahindra Bank <BankAlerts@kotak.com>', 'Kotak Bank: Sent Rs.250.00',
    'Sent Rs.250.00 from Kotak Bank AC X1234 to bluetokai@okaxis on 18-10-26.UPI Ref 429182736451. Not you, https://kotak.com/KBANKT/Fraud'))
  expectFields(sent, { kind: 'expense', amountMinor: 25000, accountMask: '1234', merchant: 'bluetokai@okaxis', reference: '429182736451' })
  const received = parsed(email('Kotak Mahindra Bank <BankAlerts@kotak.com>', 'Kotak Bank: Received Rs.1500.00',
    'Received Rs.1500.00 in your Kotak Bank AC X1234 from abc@okicici on 17-10-26.UPI Ref:428812345678.'))
  expectFields(received, { kind: 'income', amountMinor: 150000, merchant: 'abc@okicici', reference: '428812345678' })
})

Deno.test('Yes Bank, IDFC FIRST, Amex', () => {
  expectFields(parsed(email('YES BANK <alerts@yesbank.in>', 'Debit Alert',
    'Dear Customer, INR 999.00 has been debited from your account XXXX5678 on 16-10-2026 for UPI/429100000001/SWIGGY. Available balance INR 5,000.00.')),
    { institutionKey: 'yes', kind: 'expense', amountMinor: 99900, accountMask: '5678', reference: '429100000001' })
  expectFields(parsed(email('IDFC FIRST Bank <transaction.alerts@idfcfirstbank.com>', 'Debit Alert',
    'Your A/C XXXXXXX4321 has been debited with INR 2,100.00 on 15-OCT-2026 towards IMPS/PHONEPE/428700000002. Available balance is INR 10,000.00.')),
    { institutionKey: 'idfcfirst', kind: 'expense', amountMinor: 210000, accountMask: '4321' })
  expectFields(parsed(email('American Express <AmericanExpress@welcome.americanexpress.com>', 'Your Card was used',
    'Alert: You\'ve spent INR 3,250.00 on your AMEX card ** 41007 at MAKEMYTRIP on 14 October 2026 at 09:10 PM IST.')),
    { institutionKey: 'amex', instrument: 'credit_card', accountMask: '1007', kind: 'expense', amountMinor: 325000, merchant: 'MAKEMYTRIP', categoryHint: 'Travel', occurredAt: '2026-10-14T15:40:00.000Z' })
})

// -----------------------------------------------------------------------------
// Wallets
// -----------------------------------------------------------------------------

Deno.test('Paytm wallet and Amazon Pay balance', () => {
  expectFields(parsed(email('Paytm <no-reply@paytm.com>', 'Payment successful',
    'Paid Rs.120 to Chai Point from Paytm Wallet. Order ID 23456789012. Updated Wallet Balance Rs.880')),
    { institutionKey: 'paytm', instrument: 'wallet', accountMask: null, kind: 'expense', amountMinor: 12000, merchant: 'Chai Point', categoryHint: 'Food & dining' })
  const amazon = parsed(email('Amazon Pay <no-reply@amazonpay.in>', 'Payment successful',
    'You paid ₹499 to Zepto using Amazon Pay balance on 16 Oct 2026.'))
  expectFields(amazon, { institutionKey: 'amazonpay', instrument: 'wallet', kind: 'expense', amountMinor: 49900, merchant: 'Zepto', categoryHint: 'Groceries' })
})

// -----------------------------------------------------------------------------
// Transfers, refunds, declines, other currencies
// -----------------------------------------------------------------------------

Deno.test('a card bill paid from the bank is a transfer, not spending', () => {
  const alert = parsed(email(HDFC, 'Account debited',
    'Dear Customer, Rs.15,000.00 has been debited from account **1234 towards your ICICI Credit Card bill payment on 05-10-26. Ref No 427600000003.'))
  expectFields(alert, { kind: 'transfer', transferHint: 'card_payment', accountMask: '1234', amountMinor: 1500000 })
  assert.ok(alert.confidence < 0.9, 'transfers always go to review')
})

Deno.test('a payment received on a card is a transfer', () => {
  const alert = parsed(email('ICICI Bank <credit_cards@icicibank.com>', 'Payment received',
    'Dear Customer, Payment of INR 15,000.00 has been received towards your ICICI Bank Credit Card XX9001 on 06-10-2026. Thank you.'))
  expectFields(alert, { kind: 'transfer', transferHint: 'card_payment', instrument: 'credit_card', accountMask: '9001' })
})

Deno.test('a refund is a refund (never income)', () => {
  const alert = parsed(email('ICICI Bank <credit_cards@icicibank.com>', 'Refund credited',
    'Dear Customer, a refund of INR 499.00 from AMAZON has been credited to your ICICI Bank Credit Card XX9001 on 16-10-2026.'))
  expectFields(alert, { kind: 'refund', amountMinor: 49900, accountMask: '9001' })
  assert.ok(alert.confidence < 0.9)
})

Deno.test('an ATM withdrawal is a transfer into cash', () => {
  expectFields(parsed(email(HDFC, 'ATM withdrawal',
    'Rs.2000.00 withdrawn at ATM HDFC0001 from A/c XX1234 on 12-10-26 18:20:11. Avl bal Rs.10,000.00')),
    { kind: 'transfer', transferHint: 'cash_withdrawal', amountMinor: 200000, accountMask: '1234' })
})

Deno.test('a declined payment is marked declined', () => {
  expectFields(parsed(email(HDFC, 'Transaction declined',
    'Your transaction of Rs 7,000.00 at FLIPKART on HDFC Bank Credit Card ending 9001 was declined on 16-10-2026 due to insufficient limit.')),
    { entryStatus: 'declined', amountMinor: 700000, kind: 'expense', accountMask: '9001' })
})

Deno.test('another currency is kept as it is', () => {
  expectFields(parsed(email(HDFC, 'Alert : Update on your HDFC Bank Credit Card',
    'Thank you for using your HDFC Bank Credit Card ending 9001 for USD 12.00 at OPENAI *CHATGPT on 15-10-2026 03:00:00.')),
    { currency: 'USD', amountMinor: 1200, kind: 'expense' })
})

Deno.test('an HTML email', () => {
  const html = `<html><head><style>.x{color:red}</style><title>Alert</title></head><body><table><tr><td>Dear Customer,</td></tr>
    <tr><td>Rs.&nbsp;250.00 has been debited from account **1234 to VPA bluetokai@okaxis BLUE TOKAI on 18-10-26.</td></tr>
    <tr><td>Your UPI transaction reference number is 429182736451.</td></tr></table><!-- tracking --></body></html>`
  expectFields(parsed(email(HDFC, 'You have done a UPI txn', htmlToText(html))),
    { kind: 'expense', amountMinor: 25000, accountMask: '1234', reference: '429182736451', merchant: 'BLUE TOKAI' })
})

// -----------------------------------------------------------------------------
// Things that must not fool it
// -----------------------------------------------------------------------------

Deno.test('the balance after the transaction is never the amount', () => {
  expectFields(parsed(email(HDFC, 'Account update',
    'Dear Customer, Avl Bal INR 12,345.67 after Rs.450.00 was debited from A/c XX1234 at DMART on 15-10-26.')),
    { amountMinor: 45000 })
  expectFields(parsed(email(HDFC, 'Account update',
    'Rs.450.00 debited from A/c XX1234 at DMART on 15-10-26. Avl Bal INR 12,345.67')), { amountMinor: 45000, merchant: 'DMART', categoryHint: 'Groceries' })
})

Deno.test('a disclaimer in the footer doesn\'t flip a credit into a debit', () => {
  const alert = parsed(email(HDFC, 'Money received',
    'Rs.1500.00 has been credited to your account **1234 on 17-10-26.\n\nImportant: HDFC Bank will never ask for your OTP. If any amount is debited from your account without your knowledge, call us.'))
  expectFields(alert, { kind: 'income', amountMinor: 150000 })
})

Deno.test('emails that aren\'t transactions are skipped', () => {
  const skip = (raw: RawEmail) => {
    const result = parseAlert(raw, IST)
    return result.ok ? 'parsed' : result.skip
  }
  assert.equal(skip(email(HDFC, 'OTP for your transaction', '482913 is the OTP for your transaction of Rs.1,499.00 at AMAZON. Valid for 5 mins. Do not share.')), 'otp')
  assert.equal(skip(email(HDFC, 'Your HDFC Bank Credit Card Statement for October 2026',
    'Dear Customer, your statement is ready. Total amount due Rs.24,000.00; minimum amount due Rs.1,200.00. Payment due date 05-11-2026.')), 'statement')
  assert.equal(skip(email(HDFC, 'Congratulations! You are pre-approved',
    'You are eligible for a pre-approved personal loan of up to Rs.5,00,000. Apply now!')), 'promotion')
  assert.equal(skip(email(HDFC, 'Login alert', 'Dear Customer, a login to NetBanking was detected on 18-10-26 at 10:00. If this was not you, call us.')), 'not_a_transaction')
  assert.equal(skip(email('Someone <alerts@hdfcbank-secure.example>', 'Account debited', 'Rs.250 debited from A/c XX1234')), 'unknown_sender')
  assert.equal(skip(email(HDFC, 'Hello', 'Dear Customer, thank you for banking with us.')), 'no_amount')
})

Deno.test('an alert that fails sender checks is never confident', () => {
  const alert = parsed(email(HDFC, 'You have done a UPI txn',
    'Rs.250.00 has been debited from account **1234 to VPA x@ybl SHOP on 18-10-26.', { authResults: ['mx.google.com; dkim=fail header.i=@hdfcbank.net; spf=softfail'] }))
  assert.equal(alert.senderVerified, false)
  assert.ok(alert.confidence <= 0.6)
})

Deno.test('no date in the text: the time Gmail received it, slightly less sure', () => {
  const alert = parsed(email(HDFC, 'UPI txn', 'Rs.250.00 has been debited from account **1234 to VPA x@ybl SHOP.'))
  assert.equal(alert.dateSource, 'email')
  assert.equal(alert.occurredAt, new Date(RECEIVED).toISOString())
  assert.equal(alert.confidence, 0.92)
})

Deno.test('a date far from when the email arrived is not trusted', () => {
  const alert = parsed(email(HDFC, 'UPI txn', 'Rs.250.00 has been debited from account **1234 to VPA x@ybl SHOP on 18-01-25.'))
  assert.equal(alert.dateSource, 'email')
})

Deno.test('no account number: not confident', () => {
  const alert = parsed(email('PhonePe <noreply@phonepe.com>', 'Payment successful', 'You paid ₹250 to BLUE TOKAI on 18 Oct 2026. UPI Ref No. 429182736451'))
  expectFields(alert, { institutionKey: 'phonepe', accountMask: null, reference: '429182736451' })
  assert.ok(alert.confidence <= 0.6)
})

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

Deno.test('htmlToText', () => {
  assert.equal(htmlToText('<p>Rs.&nbsp;250&#46;00 &amp; more</p><div>Line&#x20;two</div><script>x()</script>'), 'Rs. 250.00 & more\nLine two')
})

Deno.test('senderVerified: DKIM or DMARC for the sender\'s own domain', () => {
  assert.equal(senderVerified(['mx.google.com; dkim=pass header.i=@hdfcbank.net'], 'a <alerts@hdfcbank.net>'), true)
  assert.equal(senderVerified(['mx.google.com; dkim=pass header.d=hdfcbank.net'], 'a <alerts@mail.hdfcbank.net>'), true, 'parent domain signs')
  assert.equal(senderVerified(['mx.google.com; dkim=pass header.i=@evil.example; dmarc=fail header.from=hdfcbank.net'], 'a <alerts@hdfcbank.net>'), false)
  assert.equal(senderVerified(['mx.google.com; dkim=none; dmarc=pass (p=NONE) header.from=icicibank.com'], 'b <x@icicibank.com>'), true)
  assert.equal(senderVerified([], 'a <alerts@hdfcbank.net>'), false)
})

Deno.test('institutionFor: subdomains count, look-alikes don\'t', () => {
  assert.equal(institutionFor('x <alerts@mailers.hdfcbank.net>')?.key, 'hdfc')
  assert.equal(institutionFor('x <alerts@hdfcbank.net.evil.example>'), null)
  assert.equal(institutionFor('x <a@nothdfcbank.net>'), null)
  assert.equal(institutionFor('Yes <a@yesbank.in>')?.name, 'Yes Bank')
})

Deno.test('every recognised institution is searched for', () => {
  for (const domain of INSTITUTION_DOMAINS) assert.ok(DEFAULT_ALERT_SENDERS.includes(domain), domain)
})
