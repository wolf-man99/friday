import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: (...args: unknown[]) => invoke(...args) } } }))

const { completeGmailConnection, GmailServiceError, startGmailConnection } = await import('./gmail')
const { FunctionsFetchError, FunctionsHttpError } = await import('@supabase/supabase-js')

beforeEach(() => {
  invoke.mockReset()
  localStorage.clear()
})

describe('Gmail connection calls', () => {
  it('keeps the browser key from start and hands it back exactly once on complete', async () => {
    invoke.mockResolvedValueOnce({ data: { url: 'https://accounts.google.com/x', browserKey: 'K'.repeat(43) }, error: null })
    expect(await startGmailConnection()).toEqual({ url: 'https://accounts.google.com/x' })

    invoke.mockResolvedValue({ data: { connection: { id: 'c1' } }, error: null })
    await completeGmailConnection('T'.repeat(43))
    expect(invoke).toHaveBeenLastCalledWith('gmail-connection', {
      body: { action: 'complete', ticket: 'T'.repeat(43), browserKey: 'K'.repeat(43) },
    })
    await completeGmailConnection('T'.repeat(43))
    expect(invoke).toHaveBeenLastCalledWith('gmail-connection', { body: { action: 'complete', ticket: 'T'.repeat(43), browserKey: null } })
  })

  it('turns the function’s refusals into their own words', async () => {
    const response = new Response(JSON.stringify({ error: 'wrong_browser', message: 'Started in a different browser.' }), { status: 403 })
    invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(response) })
    await expect(completeGmailConnection('t')).rejects.toMatchObject({ code: 'wrong_browser', message: 'Started in a different browser.' })
  })

  it('says when the function isn’t deployed or can’t be reached', async () => {
    invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(new Response('{"code":"NOT_FOUND"}', { status: 404 })) })
    await expect(startGmailConnection()).rejects.toMatchObject({ code: 'not_deployed' })
    invoke.mockResolvedValue({ data: null, error: new FunctionsFetchError(new TypeError('Failed to fetch')) })
    const error = await startGmailConnection().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GmailServiceError)
    expect((error as Error).message).toMatch(/Couldn’t reach Friday’s Gmail service/)
  })
})
