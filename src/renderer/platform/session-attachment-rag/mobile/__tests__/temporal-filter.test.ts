import { describe, expect, it } from 'vitest'
import { isStateVisibleAtChapter } from '../engine'

describe('isStateVisibleAtChapter', () => {
  it('keeps everything without a current chapter', () => {
    expect(isStateVisibleAtChapter('snapshot', 100, 200, undefined)).toBe(true)
    expect(isStateVisibleAtChapter('profile', 100, 200, undefined)).toBe(true)
  })

  it('keeps profiles regardless of range', () => {
    expect(isStateVisibleAtChapter('profile', 900, 1000, 50)).toBe(true)
    expect(isStateVisibleAtChapter('event', 900, 900, 50)).toBe(true)
  })

  it('drops future snapshots', () => {
    expect(isStateVisibleAtChapter('snapshot', 300, 400, 250)).toBe(false)
  })

  it('filters phase-bound item states like snapshots', () => {
    expect(isStateVisibleAtChapter('item_state', 100, 200, 50)).toBe(false)
    expect(isStateVisibleAtChapter('item_state', 100, 200, 250)).toBe(false)
    expect(isStateVisibleAtChapter('item_state', 100, 200, 150)).toBe(true)
  })

  it('drops expired snapshots', () => {
    expect(isStateVisibleAtChapter('snapshot', 100, 200, 250)).toBe(false)
  })

  it('keeps the snapshot inside its phase', () => {
    expect(isStateVisibleAtChapter('snapshot', 100, 200, 150)).toBe(true)
    expect(isStateVisibleAtChapter('snapshot', 100, 200, 100)).toBe(true)
    expect(isStateVisibleAtChapter('snapshot', 100, 200, 200)).toBe(true)
  })
})
