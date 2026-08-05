import { describe, expect, it } from 'vitest'
import layoutsDoc from '../data/layouts.json'
import { conveyorPathLength, sampleConveyor } from './conveyor'
import { generateWarehouse } from './generate'
import type { WarehouseConfig } from './types'

const configs = (layoutsDoc as unknown as { layouts: WarehouseConfig[] }).layouts

describe('outbound conveyor network', () => {
  for (const config of configs) {
    describe(config.id, () => {
      const model = generateWarehouse(config)
      const net = model.conveyor

      it('fits the layout it was derived from', () => {
        expect(net.spurs).toHaveLength(config.packStations)
        expect(net.chutes).toHaveLength(config.dockDoors)
        expect(net.trunk.length).toBeGreaterThan(0)
        expect(net.highY).toBeGreaterThan(net.lowY)

        // The whole loop lives inside the building.
        const points = [
          ...net.trunk.polyline,
          ...net.spurs.flatMap((s) => s.polyline),
          ...net.chutes.flatMap((c) => c.polyline),
        ]
        for (const p of points) {
          expect(p.x).toBeGreaterThanOrEqual(model.bounds.minX)
          expect(p.x).toBeLessThanOrEqual(model.bounds.maxX)
          expect(p.z).toBeGreaterThanOrEqual(model.bounds.minZ)
          // Everything sits in front of the racking, never inside it.
          expect(p.z).toBeLessThan(model.crossZ[0])
        }
      })

      it('is one-way: every bench merges upstream of every door', () => {
        const lastMerge = Math.max(...net.spurs.map((s) => s.mergeArc))
        const firstDivert = Math.min(...net.chutes.map((c) => c.divertArc))
        expect(firstDivert).toBeGreaterThan(lastMerge)
        for (const chute of net.chutes) {
          expect(chute.divertArc).toBeLessThanOrEqual(net.trunk.length)
        }
      })

      it('routes every bench to every door with a positive, sampleable path', () => {
        net.spurs.forEach((spur, s) => {
          net.chutes.forEach((chute, c) => {
            const length = conveyorPathLength(net, s, c)
            expect(length).toBeGreaterThan(spur.length + chute.length)

            const start = sampleConveyor(net, s, c, 0)
            expect(start.leg).toBe('spur')
            expect(start.pos.x).toBeCloseTo(spur.polyline[0].x, 5)

            // Mid-path is on the shared trunk, which is where contention happens.
            const middle = sampleConveyor(net, s, c, spur.length + 0.5)
            expect(middle.leg).toBe('trunk')
            expect(middle.trunkArc).toBeGreaterThanOrEqual(spur.mergeArc)

            // The end of the path is the dock's staging pad.
            const end = sampleConveyor(net, s, c, length)
            expect(end.leg).toBe('chute')
            expect(end.pos.x).toBeCloseTo(chute.stagePos.x, 5)
            expect(Math.abs(end.pos.z - chute.stagePos.z)).toBeLessThan(0.5)
          })
        })
      })

      it('never teleports: sampling advances monotonically along the path', () => {
        const length = conveyorPathLength(net, 0, net.chutes.length - 1)
        const step = length / 40
        let previous = sampleConveyor(net, 0, net.chutes.length - 1, 0)
        for (let arc = step; arc <= length; arc += step) {
          const pose = sampleConveyor(net, 0, net.chutes.length - 1, arc)
          const moved = Math.hypot(
            pose.pos.x - previous.pos.x,
            pose.pos.y - previous.pos.y,
            pose.pos.z - previous.pos.z,
          )
          // Belt distance and world distance agree to within a corner's rounding.
          expect(moved).toBeLessThanOrEqual(step + 1e-6)
          previous = pose
        }
      })

      it('stands the trunk up on legs that clear the pack-out walkway', () => {
        expect(net.legs.length).toBeGreaterThan(1)
        const packXs = model.facilities.filter((f) => f.kind === 'pack').map((f) => f.pos.x)
        for (const leg of net.legs) {
          expect(leg.height).toBeGreaterThan(0)
          // No upright lands where a picker walks in to drop totes.
          for (const x of packXs) expect(Math.abs(leg.x - x)).toBeGreaterThan(0.9)
        }
      })
    })
  }
})
