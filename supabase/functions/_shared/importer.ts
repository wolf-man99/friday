// Importing past months from Gmail, one small step per request so no request
// runs long and every step can be retried or resumed:
//   import-start    { months }      find the alert emails in those months
//   import-scan     { jobId }       read the next few; store only what they say
//   import-accounts { jobId }       the accounts and cards they mention
//   import-confirm  { jobId, decisions }  link / create / ignore / review each
//   import-run      { jobId }       record the next batch (or send it to review)
//   import-undo     { jobId }       remove what an import recorded
//   import-cancel   { jobId }       stop before anything is recorded
// The database (migration 0005) holds the rules; this module talks to Gmail.

import { type Access, type AccessDeps, gmailAccess } from './access.ts'
import { parseAlert } from './alerts.ts'
import { emailFromMessage } from './emailBody.ts'
import { buildImportQuery } from './gmailQuery.ts'
import { getFullMessage, GoogleError, listAllMessageIds } from './google.ts'
import type { AccountDecision, ScannedItem } from './store.ts'

/** At most this many alert emails in one import. */
export const IMPORT_MAX_MESSAGES = 1500
/** Emails read per scan request, and read at once. */
export const SCAN_BATCH = 15
const SCAN_PARALLEL = 5
/** Emails recorded per run request. */
export const RUN_BATCH = 40

type Reply = (status: number, body: unknown) => Response

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MONTH = /^\d{4}-\d{2}$/

export const IMPORT_ACTIONS = ['import-start', 'import-scan', 'import-accounts', 'import-confirm', 'import-run', 'import-undo', 'import-cancel'] as const
export type ImportAction = (typeof IMPORT_ACTIONS)[number]

export async function handleImport(
  action: ImportAction,
  userId: string,
  body: Record<string, unknown>,
  deps: AccessDeps,
  reply: Reply,
): Promise<Response> {
  if (action === 'import-start') return await start(userId, body.months, deps, reply)

  const jobId = typeof body.jobId === 'string' && UUID.test(body.jobId) ? body.jobId : null
  if (!jobId) return reply(400, { error: 'bad_request', message: 'Which import?' })

  switch (action) {
    case 'import-scan':
      return await scan(userId, jobId, deps, reply)
    case 'import-accounts':
      return reply(200, { accounts: await deps.store.importAccounts(userId, jobId) })
    case 'import-confirm': {
      const decisions = parseDecisions(body.decisions)
      if (!decisions) return reply(400, { error: 'bad_request', message: 'Choose what to do with each account.' })
      const result = await deps.store.importApplyAccounts(userId, jobId, decisions)
      deps.log('gmail_import_accounts', { action, count: decisions.length })
      return reply(200, result)
    }
    case 'import-run': {
      const result = await deps.store.importRun(userId, jobId, RUN_BATCH)
      deps.log('gmail_import_run', { action, count: result.processed, status: result.status })
      return reply(200, result)
    }
    case 'import-undo': {
      const result = await deps.store.importUndo(userId, jobId)
      deps.log('gmail_import_undone', { action, count: result.removed })
      return reply(200, result)
    }
    case 'import-cancel':
      await deps.store.importCancel(userId, jobId)
      return reply(200, { cancelled: true })
  }
}

async function start(userId: string, rawMonths: unknown, deps: AccessDeps, reply: Reply) {
  const months = Array.isArray(rawMonths) ? rawMonths.filter((m): m is string => typeof m === 'string' && MONTH.test(m)) : []
  if (months.length === 0 || months.length > 3 || months.length !== (rawMonths as unknown[]).length) {
    return reply(400, { error: 'bad_request', message: 'Choose up to three months.' })
  }
  // Check access first, so a revoked connection doesn't leave an empty import behind.
  const access = await gmailAccess(userId, deps, 'import-start')
  if (!access.ok) return reply(access.status, access.body)

  const { jobId, ranges } = await deps.store.importBegin(userId, months)
  try {
    const ids = new Set<string>()
    let truncated = false
    for (const range of ranges) {
      const query = buildImportQuery(deps.config.alertSenders, range.start, range.end)
      const found = await listAllMessageIds(deps.fetch, access.endpoints, access.accessToken, query, IMPORT_MAX_MESSAGES - ids.size)
      for (const id of found.ids) ids.add(id)
      truncated ||= found.truncated
      if (ids.size >= IMPORT_MAX_MESSAGES) break
    }
    const total = await deps.store.importAddMessages(userId, jobId, [...ids], truncated)
    deps.log('gmail_import_started', { action: 'import-start', count: total })
    return reply(200, { jobId, total, truncated })
  } catch (error) {
    await deps.store.importFail(userId, jobId, error instanceof GoogleError ? 'gmail_unavailable' : 'internal').catch(() => undefined)
    throw error
  }
}

async function scan(userId: string, jobId: string, deps: AccessDeps, reply: Reply) {
  const { messageIds, timeZone } = await deps.store.importPending(userId, jobId, SCAN_BATCH)
  if (messageIds.length === 0) return reply(200, await deps.store.importSave(userId, jobId, []))

  const access = await gmailAccess(userId, deps, 'import-scan')
  if (!access.ok) return reply(access.status, access.body)

  const items: ScannedItem[] = []
  for (let i = 0; i < messageIds.length; i += SCAN_PARALLEL) {
    const batch = messageIds.slice(i, i + SCAN_PARALLEL)
    items.push(...(await Promise.all(batch.map((id) => readOne(id, access, timeZone, deps)))))
  }
  const result = await deps.store.importSave(userId, jobId, items)
  deps.log('gmail_import_scanned', { action: 'import-scan', count: items.length, status: result.status })
  return reply(200, result)
}

/** One email → its facts, or why it was skipped. The email itself goes no further. */
async function readOne(id: string, access: Access & { ok: true }, timeZone: string, deps: AccessDeps): Promise<ScannedItem> {
  let message
  try {
    message = await getFullMessage(deps.fetch, access.endpoints, access.accessToken, id)
  } catch (error) {
    // Deleted since it was found: nothing to import.
    if (error instanceof GoogleError && error.status === 404) return { messageId: id, skip: 'not_found' }
    throw error
  }
  const result = parseAlert(emailFromMessage(message), { timeZone })
  if (!result.ok) return { messageId: id, skip: result.skip }
  const alert = result.alert
  return {
    messageId: id,
    alert: {
      institutionKey: alert.institution.key,
      institutionName: alert.institution.name,
      instrument: alert.instrument,
      accountMask: alert.accountMask,
      kind: alert.kind,
      transferHint: alert.transferHint,
      amountMinor: alert.amountMinor,
      currency: alert.currency,
      occurredAt: alert.occurredAt,
      merchant: alert.merchant,
      reference: alert.reference,
      entryStatus: alert.entryStatus,
      categoryHint: alert.categoryHint,
      confidence: alert.confidence,
      senderVerified: alert.senderVerified,
    },
  }
}

function parseDecisions(raw: unknown): AccountDecision[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) return null
  const decisions: AccountDecision[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null
    const d = item as Record<string, unknown>
    if (typeof d.institutionKey !== 'string' || typeof d.instrument !== 'string') return null
    if (!['link', 'create', 'ignore', 'review'].includes(String(d.action))) return null
    if (d.action === 'link' && !(typeof d.accountId === 'string' && UUID.test(d.accountId))) return null
    decisions.push({
      institutionKey: d.institutionKey,
      instrument: d.instrument,
      accountMask: typeof d.accountMask === 'string' ? d.accountMask : '',
      action: d.action as AccountDecision['action'],
      ...(d.action === 'link' ? { accountId: d.accountId as string } : {}),
      ...(d.action === 'create'
        ? {
            name: typeof d.name === 'string' ? d.name.slice(0, 60) : undefined,
            type: typeof d.type === 'string' ? d.type : undefined,
            openingBalanceMinor: Number.isSafeInteger(d.openingBalanceMinor) ? (d.openingBalanceMinor as number) : undefined,
          }
        : {}),
    })
  }
  return decisions
}
