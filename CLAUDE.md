# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Digital Twin WMS — a browser-based 3D digital twin of a retail distribution-centre pick
module. It generates a warehouse from JSON config, builds a real navigation graph, routes
live pick lists with three selectable strategies, animates picker agents walking those exact
paths in Three.js, and models the downstream pack/conveyor/dispatch stages — all client-side,
no backend. See [README.md](README.md) for the full domain writeup (routing math, simulation
model, picker embodiments, theming rules); this file focuses on commands and architecture.

## Commands

```bash
npm install
npm run dev          # Vite dev server, http://localhost:5173
npm run build         # tsc --noEmit, then production build to dist/
npm run preview        # serve the production build
npm run typecheck       # tsc --noEmit only
npm test              # vitest run — full suite, single run
npm run test:watch      # vitest, watch mode
```

Run a single test file or filter by name (Vitest, not Jest):

```bash
npx vitest run src/pathfinding/pathfinding.test.ts
npx vitest run -t "name substring"
```

Test files live next to what they test (`*.test.ts`), not in a separate `tests/` tree —
`src/pathfinding/pathfinding.test.ts`, `src/warehouse/conveyor.test.ts`,
`src/simulation/simulation.test.ts`, `src/inbound/putaway.test.ts`, `src/inbound/walker.test.ts`,
`src/scene/bins.test.ts`, `src/scene/shell.test.ts`, `src/store/persist.test.ts`,
`src/simulation/dockActivity.test.ts`.

There is no lint script configured; `tsc --noEmit` (strict mode) is the enforced check, and
`npm run build` fails the build on type errors.

## Architecture

### Layer boundaries (the thing to preserve when editing)

```
pathfinding/  Pure TS. Graph, Dijkstra, routing strategies. No Three.js, no React.
warehouse/    Procedural model: racks, bins, SKU catalogue, nav graph, conveyor geometry.
simulation/   Outbound engine: agent state machine, pack line, order generation, SLA, compare.
inbound/      Goods-in engine: receiving, putaway planning/scoring, walk directions.
scene/        Three.js only. Knows nothing about React or the store.
store/        Zustand — the only thing both React and the scene talk to.
ui/           React overlay: panels, charts, inspector, plan view.
data/         layouts.json, sampleOrders.json, realCatalog.json, realReceipts.json,
              and the DataSource boundary (src/data/index.ts).
```

Each layer only depends on the ones above it in that list. `pathfinding/` and `warehouse/`
have zero browser or framework dependencies, so they're portable to a Node service if routing
ever needs to move server-side. `scene/` never imports from `ui/` or reads the store directly —
`SceneView.tsx` is the only bridge, pulling state out of Zustand and pushing it into the scene
each frame.

### The one decision worth knowing before touching SceneView or the store

**React never gates the animation.** A single `requestAnimationFrame` loop in
[src/ui/SceneView.tsx](src/ui/SceneView.tsx) advances the simulation engine, hands live agent
state straight to the Three.js scene, and renders — bypassing React entirely for anything
per-frame. Metrics are published into Zustand at only **8 Hz**, so a heavy dashboard re-render
can never stutter the 3D view. If you're adding something that needs to move every frame
(a new mesh, a new indicator), wire it through the scene classes directly; don't route it
through store state that React components subscribe to.

### Two parallel domain engines: outbound and inbound

- **Outbound** (`simulation/`): `engine.ts` runs the picker agent state machine
  (`idle → traveling → picking → returning → unloading → awaitPack → idle`, plus `blocked`/
  `break`) in fixed 0.1s slices. `packLine.ts` models cartonisation, belt merges and trailer
  dispatch downstream of picking. `compare.ts` routes one wave through every registered
  strategy for the comparison view.
- **Inbound** (`inbound/`): mirrors the same "plan a walk over the nav graph" pattern but for
  goods-in. `receipts.ts` owns the receiving lifecycle (`expected → received → stored`);
  `freeSpace.ts` finds candidate locations; `putaway.ts` scores and ranks them (`PutawayCandidate`
  with distance, fit, plain-language `reasons`); `plan.ts` turns a chosen candidate into a
  `PutawayPlan` with a `Route` and step-by-step `directions.ts`; `walker.ts` animates the clerk
  along it. Both engines log into a single unified `Movement` history (`kind: 'inbound' |
  'outbound'`) surfaced by `HistoryPanel.tsx`.
- Both engines run on the **same navigation graph** (`pathfinding/graph.ts`) and the same
  `WarehouseModel` — there's one source of truth for "how do I get from A to B," not two.

### Adding a routing strategy

Implement the `RoutingStrategy` interface in a new file under `pathfinding/strategies/` and add
it to the `ROUTING_STRATEGIES` array in `pathfinding/strategies/index.ts`. It then appears
automatically in the strategy selector, the comparison chart, and the compare table — no
rendering, simulation, or UI changes needed, since all three read from that registry.

### Swapping in real data

All layout, catalogue, order and receipt access goes through the `DataSource` interface in
[src/data/index.ts](src/data/index.ts) (`localSource` is the only implementation today, reading
the bundled JSON files). Add another implementation and point `activeSource` at it — nothing
else in the app changes.

`scripts/*.py` are one-time, offline data-prep scripts (never run by the app) that convert the
raw WMS Excel exports at the repo root (`Inbound Dataset.xlsx`, `Outbound Dataset.xlsx`) into
the bundled `src/data/*.json` files, plus a JSON+CSV mirror in `real-data-export/` for
eyeballing. Re-run them only when the source Excel exports change.

### App shell / sections

`ui/App.tsx` renders a fixed `TopBar`, a collapsible left rail switching between four sections
via `SectionNav` (`ops` → `ControlPanel`, `inbound` → `InboundPanel`, `outbound` →
`OutboundPanel`, `history` → `HistoryPanel`), the `SceneView` centre viewport, and a right
`MetricsPanel`. `AppSection` in `store/useAppStore.ts` is the source of truth for which panel
shows.

### Hand control subsystem

[src/scene/handControl/](src/scene/handControl/) is a self-contained, additive camera-input
path (MediaPipe `HandLandmarker`, fully local, lazy-loaded only when toggled on): `HandTracker`
wraps the camera/model, `GestureDetector` classifies hand shape (pure function, no state),
`NavigationController`/`ZoomController`/`PinchRotateController` turn a classified gesture into the
same `MoveAxes`/rotate/zoom channels the on-screen pad already drives, and `HandControlManager` is
the priority state machine arbitrating between the four gestures (pinch-hold rotate → zoom → pan →
fist rotate — one channel live per frame, guaranteed; `handControl.test.ts` covers the collisions).
None of the existing mouse/keyboard camera code was changed to add this — treat it as a second
input source feeding the same API surface.

## Stack

Three.js · React 19 · TypeScript (strict) · Zustand 5 · Tailwind CSS 3 · Recharts 3 · Vite ·
Vitest. No backend — see [README.md](README.md) for exact pinned versions.
