import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ScrollToTop } from './ScrollToTop'

function Back() {
  const navigate = useNavigate()
  return <button onClick={() => navigate(-1)}>Back</button>
}

beforeEach(() => {
  window.scrollTo = vi.fn() as typeof window.scrollTo
})

describe('scroll position between screens', () => {
  it('opens a new screen at its top, and leaves Back alone', async () => {
    render(
      <MemoryRouter initialEntries={['/profile']}>
        <ScrollToTop />
        <Routes>
          <Route path="/profile" element={<Link to="/connections/gmail">Gmail</Link>} />
          <Route path="/connections/gmail" element={<Back />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(window.scrollTo).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('link', { name: 'Gmail' }))
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0)
    vi.mocked(window.scrollTo).mockClear()
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('link', { name: 'Gmail' })).toBeInTheDocument()
    expect(window.scrollTo).not.toHaveBeenCalled()
  })
})
