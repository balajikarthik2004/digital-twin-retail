import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { generateWarehouse } from '../warehouse/generate'
import type { WarehouseConfig } from '../warehouse/types'
import { buildShell } from './shell'

/**
 * Two deliberately different buildings: nothing in the shell may be hardcoded to
 * one layout's dimensions, so both have to come out proportioned and enclosed.
 */
const SMALL: WarehouseConfig = {
  id: 'test-small',
  name: 'Small module',
  aisles: 3,
  aisleWidth: 3,
  rackDepth: 1.2,
  bayWidth: 2.7,
  baysPerBlock: 4,
  blocks: 2,
  levels: 3,
  levelHeight: 1.6,
  slotsPerBay: 3,
  crossAisleWidth: 3,
  apronDepth: 12,
  dockDoors: 2,
  packStations: 2,
  pickerSpeed: 1.25,
  pickTimeSec: 12,
  perUnitTimeSec: 2,
  seed: 7,
}

const TALL: WarehouseConfig = { ...SMALL, id: 'test-tall', levels: 6, levelHeight: 2.1, aisles: 6 }

describe('buildShell', () => {
  it('encloses the footprint and clears the racking', () => {
    for (const config of [SMALL, TALL]) {
      const model = generateWarehouse(config)
      const shell = buildShell(model, 'light')

      const rackHeight = 0.16 + config.levels * config.levelHeight
      expect(shell.roofHeight).toBeGreaterThan(rackHeight)

      // Walls must sit outside the footprint on every side, never through it.
      const box = new THREE.Box3().setFromObject(shell.group)
      expect(box.min.x).toBeLessThanOrEqual(model.bounds.minX)
      expect(box.max.x).toBeGreaterThanOrEqual(model.bounds.maxX)
      expect(box.min.z).toBeLessThanOrEqual(model.bounds.minZ)
      expect(box.max.z).toBeGreaterThanOrEqual(model.bounds.maxZ)
      expect(box.max.y).toBeCloseTo(shell.roofHeight, 1)

      shell.dispose()
    }
  })

  it('keeps the roof separable so an overhead camera can drop it', () => {
    const shell = buildShell(generateWarehouse(SMALL), 'dark')
    expect(shell.roof.parent).toBe(shell.group)
    expect(shell.roof.children.length).toBeGreaterThan(0)

    // Everything in the roof group has to be up at the deck, otherwise hiding it
    // would take part of the floor with it.
    const box = new THREE.Box3().setFromObject(shell.roof)
    expect(box.min.y).toBeGreaterThan(shell.roofHeight * 0.5)
    shell.dispose()
  })

  it('paints floor markings flat on the slab, under the route ribbons', () => {
    const shell = buildShell(generateWarehouse(SMALL), 'light')
    const marks = shell.group.children.filter(
      (child) => child instanceof THREE.Mesh && child.position.y > 0 && child.position.y < 0.05,
    )
    expect(marks.length).toBe(1)
    // Ribbons are laid at 0.03 and up; the paint has to stay below them.
    expect(marks[0].position.y).toBeLessThan(0.03)
    shell.dispose()
  })
})
