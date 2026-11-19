import { describe, expect, it } from 'vitest'
import { leadStatusLabel } from './leadStatus'

describe('leadStatusLabel', () => {
  it('formats a single-word status', () => {
    expect(leadStatusLabel('QUALIFIED')).toBe('Qualified')
  })

  it('formats a multi-word status', () => {
    expect(leadStatusLabel('IN_PROGRESS')).toBe('In Progress')
  })
})
