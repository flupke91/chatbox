import { describe, expect, it } from 'vitest'
import { resolveTimelineFactor } from '../engine'

describe('resolveTimelineFactor', () => {
  it('does nothing when no chapter ceiling is active', () => {
    expect(resolveTimelineFactor(undefined, undefined)).toEqual({ multiplier: 1, priorityBonus: 0 })
    expect(resolveTimelineFactor(120, undefined)).toEqual({ multiplier: 1, priorityBonus: 0 })
  })

  it('keeps a chapter-less card but ranks it below placed cards', () => {
    const factor = resolveTimelineFactor(undefined, 100)
    expect(factor.multiplier).toBeLessThan(1)
    expect(factor.multiplier).toBeGreaterThan(0)
    expect(factor.multiplier).toBeLessThan(resolveTimelineFactor(99, 100).multiplier)
  })

  it('suppresses a card past the ceiling without dropping it', () => {
    const future = resolveTimelineFactor(101, 100)
    expect(future.multiplier).toBeGreaterThan(0)
    expect(future.multiplier).toBeLessThan(resolveTimelineFactor(undefined, 100).multiplier)
  })

  it('rewards the chapter the player is currently in', () => {
    expect(resolveTimelineFactor(100, 100)).toEqual({ multiplier: 1, priorityBonus: 0.1 })
  })
})
