import { describe, expect, it } from 'vitest'
import { validate } from './SignIn'

const filled = { name: 'Sai', email: 'sai@example.com', password: 'correct-horse' }

describe('sign-in / sign-up validation', () => {
  it('requires name, email and password to create an account', () => {
    expect(validate('sign-up', { name: '  ', email: '', password: '' })).toEqual({
      name: 'Enter your name',
      email: 'Enter your email address',
      password: 'Enter your password',
    })
    expect(validate('sign-up', filled)).toEqual({})
  })

  it('checks the email format and password length on sign-up', () => {
    expect(validate('sign-up', { ...filled, email: 'sai@' }).email).toBe('That doesn’t look like an email address')
    expect(validate('sign-up', { ...filled, password: 'short' }).password).toBe('Passwords need at least 8 characters')
  })

  it('asks only for email and password to sign in, and only email to reset', () => {
    expect(validate('sign-in', { name: '', email: 'sai@example.com', password: 'x' })).toEqual({})
    expect(validate('sign-in', { name: '', email: 'sai@example.com', password: '' })).toEqual({ password: 'Enter your password' })
    expect(validate('reset', { name: '', email: 'sai@example.com', password: '' })).toEqual({})
  })
})
