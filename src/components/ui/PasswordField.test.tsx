import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { PasswordField } from './Field'

function Harness() {
  const [value, setValue] = useState('')
  return <PasswordField label="Password" value={value} onChange={(e) => setValue(e.target.value)} />
}

describe('PasswordField', () => {
  it('hides the password by default and toggles visibility without losing the value', async () => {
    render(<Harness />)
    const input = screen.getByLabelText('Password', { selector: 'input' })
    expect(input).toHaveAttribute('type', 'password')
    await userEvent.type(input, 'correct-horse')

    const show = screen.getByRole('button', { name: 'Show password' })
    expect(show).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(show)
    expect(input).toHaveAttribute('type', 'text')
    expect(input).toHaveValue('correct-horse')

    const hide = screen.getByRole('button', { name: 'Hide password' })
    expect(hide).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(hide)
    expect(input).toHaveAttribute('type', 'password')
  })

  it('is a plain button, so it never submits the form', () => {
    render(<Harness />)
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute('type', 'button')
  })
})
