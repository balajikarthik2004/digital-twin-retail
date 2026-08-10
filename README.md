# Digital Twin WMS — 3D Warehouse Management System

A browser-based digital twin of a retail distribution-centre pick module. It generates a
warehouse from a JSON config, builds a real navigation graph over it, routes live pick lists
with three selectable strategies, and animates picker agents walking those exact paths in 3D
while a dashboard reports throughput, SLA attainment, congestion and stock health.

The pathfinding and simulation are genuinely real — Dijkstra over a weighted aisle graph, a
2-opt-refined TSP tour, a time-stepped agent state machine. Nothing in the 3D view is a
canned animation.

**The pickers reason.** They choose which order to take next by weighing SLA pressure against
walking distance, batch nearby orders into one tour up to their carrying capacity, give up on
a blocked aisle and re-plan around it, handle short picks, and take breaks. Every one of those
decisions is written down in plain language in the **Picker reasoning** panel, with the numbers
behind it — so you can see *why* a picker did something, not just watch it move.

**You choose the embodiment.** Person with a hand tote, person with a pick cart, person with a
pallet truck, or an AMR — and the choice is physics, not a costume: each carries its own pace,
capacity and aisle footprint.

**Picking is only half the job.** A picked tote is not a shipment, so the twin models what
happens next: totes queue at induction, a manned bench cartonises the order, the parcel merges
onto an overhead takeaway conveyor, a sorter diverts it to the door its channel ships from, and
it stacks there until a trailer seals. The induction buffer is finite and the belt is a shared
resource, so an under-staffed pack wall pushes back on the pickers instead of hiding the problem
in an infinite queue — which is how downstream capacity really ends up setting throughput.

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

The app boots with a sample warehouse (**DC North**, 8 aisles, 2,560 storage locations) and a
pre-populated 12-order wave. Press **Run simulation** — or hit `Space` — and four pickers
start working the wave.

| Script | Does |
|---|---|
| `npm run dev` | Dev server with HMR |
| `npm run build` | Typecheck, then production build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm test` | 79 unit tests (pathfinding, generation, conveyor geometry, simulation, decisions, pack-out, comparison) |
| `npm run typecheck` | `tsc --noEmit` |

### Try this first (90-second tour)

1. **Run simulation** at `20×`. Watch pickers walk their routes; the bright section of each
   trail is distance already covered, the dim section is what remains.
2. **Read the Picker reasoning panel** (right side) while it runs. You'll see entries like
   *"Took SO-004110 (standard, due in 119m, 34 m away) — 9 m closer than SO-004107"* and
   *"Batched SO-004107 (+6 lines) — stops 2 m off my tour · load 16/20"*. Click the small
   numbered chips to follow a different picker's thinking.
3. **Change the picker type** (left panel) to **Pallet truck**, then **AMR robot**. The mesh
   changes, and so do pace and capacity — the AMR clears the same wave measurably faster.
4. **Compare strategies** (right panel). Same wave, all three strategies, side by side —
   TSP 2-opt comes in roughly 10% shorter than the S-shape baseline.
5. **Top-down** view. Plan view is where pick paths actually read; you can see the S-shape
   sweep whole aisles while TSP cuts across.
6. **Click any bin** — SKU, velocity tier, live on-hand vs opening stock, replen flag. **Click
   any picker** — its batch, load against capacity, and its last decision.
7. Turn off **Batch picking** or **Smart dispatch** under *Operating behaviour* and re-run. Both
   cost you distance when disabled, which is the point of having them as switches.
8. **Pack line** view (or `4`). Watch a bench close a carton, the parcel climb its spur onto the
   overhead conveyor, run the length of the pack wall and divert down a chute to its door. Click
   a parcel mid-flight to see where it is going and why.
9. Drag **Packers on shift** down to 1 and re-run. The flow strip backs up at *Pack*, the
   induction buffer fills, pickers start showing **Held at pack**, and the wave takes longer even
   though picking never got slower — the bottleneck moved downstream, which is the whole point of
   modelling the stage.

Batching only fires when orders are actually queueing — with a fast fleet and a slow arrival
rate the counter stays at 0 because there was never anything to combine. Raise **Arrival rate**
or drop **Pickers on the floor** to see it work.

### Keyboard

`Space` run/pause · `1`–`5` camera presets (overview, top-down, aisle, pack line, dock) ·
`[` `]` toggle panels · `m` plan view · `t` light/dark theme · `Esc` close inspector

In dev builds only, `window.__digitalTwinWMS` exposes `{ scene, store }` for poking at the twin
from the console — e.g. `__digitalTwinWMS.store.getState().metrics`.

### Hand control

The **Hand control** pill (top-right of the 3D view) steers the camera from a webcam instead of
the mouse/keyboard — useful for a hands-off walkthrough on a demo floor. It is strictly additive:
mouse drag/scroll/pan and WASD keep working exactly as before, whether this is on or off; the
toggle only ever adds a second source of input alongside them. Three gestures, one hand shape
each, and only one is ever live at once:

| Gesture | Does |
| --- | --- |
| 🤏 Pinch one hand | **Pan** — move front/back, left/right. Release the pinch and it stops dead. |
| ✊ Close it into a fist | **Rotate** — a fixed, slow 360° spin. Not proportional to anything (position, speed) on purpose, so it can't feel like it's "getting away from you." Open the hand and it stops immediately. |
| 🤏🤏 Pinch with both hands | **Zoom** — spread apart to zoom in, bring them back together to zoom out, like a two-finger pinch-zoom. Bounded by the same `OrbitControls` limits a mouse wheel is held to. |

Deliberately **hand-agnostic**: it's the *shape* a hand makes that decides what happens, never
which physical hand (left/right) is making it. An earlier version keyed navigation off MediaPipe's
own left/right classification, which assumes the frame handed to the model is itself mirrored
(selfie-style); ours isn't (only the `<video>` preview is, in CSS), so trusting it needed an
inversion that was easy to get backwards — and getting it backwards silently swapped which hand
drove what, which read exactly like "the camera is moving on its own." Reading shape instead of
identity sidesteps the question entirely. Landmarks are smoothed frame to frame and every gesture
reads through a hysteresis threshold, so a hand held nearly still, or caught exactly at a shape's
edge, cannot flicker between two readings.

Hand tracking is MediaPipe's `HandLandmarker`, run entirely in the browser (WASM/GPU, up to two
hands, no frames ever leave the machine) — see [src/scene/handControl/](src/scene/handControl/),
split into a camera/model wrapper (`HandTracker`), pure gesture-shape detection
(`GestureDetector`), per-gesture controllers (`NavigationController`, `ZoomController`) and the
priority state machine that arbitrates between them (`HandControlManager`). Rotate/zoom feed the
exact same `MoveAxes` and rotate/zoom channels the on-screen pad already used
(`WarehouseScene.setPadAxes`/`setHandRotateZoom`) — nothing about the existing camera code changed
to add any of this. The runtime and model asset are vendored into `public/vision/` and
`public/models/hand_landmarker.task` rather than fetched from a CDN, so the feature works offline
once installed; both are lazy-loaded only when the pill is switched on, so they cost nothing on
first paint or in the main bundle.

---

## Architecture

```
src/
├── pathfinding/       Pure TS. Graph, Dijkstra, routing strategies. No Three.js, no React.
│   ├── graph.ts          NavGraphBuilder, Dijkstra + ShortestPathOracle (memoised)
│   ├── route.ts          buildRoute(): visiting order -> walkable polyline + arc lengths
│   └── strategies/       serpentine · nearestNeighbour · tspTwoOpt · index.ts (registry)
├── warehouse/         Procedural model: racks, bins, SKU catalogue, nav graph
│   ├── generate.ts       WarehouseConfig -> WarehouseModel (geometry + graph + slotting)
│   └── conveyor.ts       Bench -> takeaway -> sorter -> dock loop + arc sampling
├── simulation/        Engine, order generation/import, strategy comparison
│   ├── engine.ts         Agent state machine, decisions, congestion, stock, metrics
│   ├── packLine.ts       Pack benches, cartonisation, belt merges, trailer dispatch
│   ├── pickerProfiles.ts The four embodiments and their physics
│   ├── orderGenerator.ts Poisson arrivals, velocity-weighted demand, JSON importer
│   ├── sla.ts            Due-time windows by priority
│   └── compare.ts        Route one wave through every strategy
├── scene/             Three.js only. Knows nothing about React or the store.
│   ├── WarehouseScene.ts Renderer, camera, picking, trails, agent sync
│   ├── buildWarehouse.ts Slab, racking, dock kit + 2,560-instance bin InstancedMesh
│   │                     (each location drawn at the height of what is in it)
│   ├── shell.ts          Walls, roof steel, high-bay lighting, painted floor markings
│   ├── packLineMesh.ts   Animated belts, packers, andon beacons, instanced parcels
│   └── ribbon.ts         Thick floor path lines (LineBasicMaterial.linewidth is a no-op)
├── store/             Zustand — the only thing both React and the scene talk to
├── ui/                React overlay: panels, charts, inspector, plan view
│   ├── PickFlowPanel.tsx The tour as the operator sees it: instruction, list, time split
│   ├── components/       Primitives + the 16px icon set the chrome is drawn with
│   └── theme.ts          Theme mode + the validated chart & picker palettes
└── data/              layouts.json · sampleOrders.json · DataSource boundary
```

### The one architectural decision worth knowing

**React never gates the animation.** One `requestAnimationFrame` loop lives in
[SceneView.tsx](src/ui/SceneView.tsx): it advances the engine, hands live agent state
straight to the Three.js scene, and renders. Metrics are published into Zustand at only
**8 Hz**, so a heavy dashboard re-render can never stutter the 3D view. The inspector
popover follows a moving picker by writing a CSS transform inside its own frame callback —
no React state per frame either.

Measured per-frame cost of our own JS (renderer excluded, so software rasterisation can't mask
it): **1.1 ms at 4 pickers, 3.8 ms at 24** — against a 16.7 ms budget at 60 fps. Simulation
integration is a rounding error (≈0.1 ms); nearly all of it is the scene's agent sync. Two things
keep that flat: a picker's **planned** path ribbon is rebuilt only when the route changes, not
every frame, and route bin tints are gated behind a cheap state signature. Both were found by
measuring — before the fix, 4 pickers alone cost 2.2 ms.

---

## How the routing works

Every strategy sees the same graph and answers one question: **in what order should these
stops be visited?** Turning an order into a walkable path is done once, generically, by
`buildRoute()`.

### The navigation graph

Nodes sit at every rack bay (aisle centreline), every aisle × cross-aisle intersection, along
the front apron lane, and at each dock, pack station and the outbound staging point. Edges are
weighted by true walking distance. Because there are no edges through racking, getting from
aisle 3 to aisle 4 costs a full trip to a cross aisle — which is exactly what makes routing
strategy matter.

Both shelf sides and all levels of one bay share a single nav node, i.e. routing is at
**bay-level granularity**, matching how real pick paths are computed. Two lines in the same bay
are picked back to back with no extra walking, and `buildRoute` keeps both as distinct stops.

Distances come from `ShortestPathOracle`, which runs one Dijkstra per distinct source and
caches it. A pick list touches a few dozen of ~350 nodes, so this is both simpler and faster
than a full all-pairs matrix, and it stays cheap as the warehouse grows.

### The three strategies

| Strategy | Method | Result on the sample wave |
|---|---|---|
| **S-Shape (serpentine)** | Sweep aisles in ascending order, alternating direction end to end. Skip empty aisles. | 2,470 m — baseline |
| **Nearest Neighbour** | Greedily hop to the closest remaining pick by *graph* distance. | 2,270 m (−8%) |
| **TSP Heuristic (NN + 2-opt)** | NN tour, then repeatedly reverse contiguous runs while that shortens the walk. | **2,214 m (−10%)** |

2-opt runs on an *open* tour (fixed start and end), so only two boundary edges change per
candidate reversal — cheap enough to converge in milliseconds for 5–40 stops, and it lands
within a few percent of optimal without an exact solver. It is also guaranteed never to
return a longer tour than the greedy tour it started from (asserted in the tests).

### Adding a fourth strategy

Implement one interface and register it. **No rendering, simulation or UI code changes.**

```ts
// src/pathfinding/strategies/largestGap.ts
import type { RoutingStrategy } from '../types'

export const largestGap: RoutingStrategy = {
  id: 'largest-gap',
  name: 'Largest Gap',
  blurb: 'Enter each aisle from both ends, skipping the largest internal gap.',
  sequence(ctx, stops, start, end) {
    // ctx.distance(a, b) · ctx.path(a, b) · ctx.node(id).aisle / .pos
    return reorder(stops)
  },
}
```

```ts
// src/pathfinding/strategies/index.ts
export const ROUTING_STRATEGIES = [serpentine, nearestNeighbour, tspTwoOpt, largestGap]
```

It immediately appears in the strategy selector, the comparison chart and the table, because
all three read from the registry.

---

## Swapping in real data

### Warehouse layout

Layouts are plain JSON in [src/data/layouts.json](src/data/layouts.json). Everything
downstream — rack geometry, bin codes, the SKU catalogue, the navigation graph, camera
framing, the plan view — is derived from these numbers, so there is nothing to hardcode per
facility. All dimensions are metres.

```json
{
  "id": "dc-north",
  "name": "DC North · Ambient Pick Module A",
  "aisles": 8,            "aisleWidth": 3.0,
  "rackDepth": 1.2,       "bayWidth": 2.4,
  "baysPerBlock": 10,     "blocks": 2,
  "levels": 4,            "levelHeight": 1.15,
  "slotsPerBay": 2,       "crossAisleWidth": 3.2,
  "apronDepth": 13,       "dockDoors": 4,
  "packStations": 3,      "pickerSpeed": 1.3,
  "pickTimeSec": 12,      "perUnitTimeSec": 2.5,
  "seed": 20260803
}
```

`blocks` inserts cross aisles: `blocks + 1` of them, so `blocks: 3` gives a front, two mid
and a back cross aisle. Three presets ship (compact backroom, the default module, a 12-aisle
regional hub) and are switchable from the top bar.

Slotting is generated, not random: fast movers are concentrated near the front cross aisle and
in the golden zone (level 2 of 4), which is why routing quality shows up in the numbers. The
`seed` makes it fully deterministic — the same config always builds the same warehouse.

### Orders

Three ways in, all going through the same code path:

1. **Paste JSON** — left panel → *Import real data* → textarea → *Load orders*.
2. **Upload a `.json` file** — same panel.
3. **Replace [src/data/sampleOrders.json](src/data/sampleOrders.json)** to change what loads
   on boot.

```json
[
  {
    "ref": "SO-004101",
    "channel": "Ecommerce",
    "priority": "express",
    "releasedAt": 0,
    "lines": [
      { "location": "A04-R10-4B", "qty": 2 },
      { "sku": "SKU-001200", "qty": 1 }
    ]
  }
]
```

Only `lines` is required. A location resolves against an operator location code
(`A04-R10-4B` = aisle 04, right side, bay 10, level 4, slot B), a bin id, or a SKU id —
whichever your WMS emits. `releasedAt` is seconds into the shift. Unresolvable lines are
reported as warnings rather than failing the import.

### A real backend

All layout and order access goes through the `DataSource` interface in
[src/data/index.ts](src/data/index.ts). Swap the implementation and nothing else changes:

```ts
export const httpSource: DataSource = {
  id: 'wms',
  label: 'WMS API',
  listLayouts:     async () => (await fetch('/api/layouts')).json(),
  defaultLayoutId: async () => 'dc-north',
  loadOrders:      async (model) =>
    importOrders(model, await (await fetch('/api/waves/current')).json()).orders,
}
```

Then point `activeSource` at it. The `pathfinding/` folder has no browser dependencies at
all, so the same routing code can be lifted into a Node service if routing should move
server-side.

---

## Picker embodiments

Switchable at any time from the left panel, including mid-run. Factors multiply the operator-set
base values, so the walking-speed and handling-time sliders stay useful as tuning knobs.

| Embodiment | Pace | Capacity | Handling | Pack-out | Aisle footprint |
|---|---|---|---|---|---|
| **Person (hand tote)** | ×1.08 | 10 lines | ×0.95 | ×0.7 | ×0.6 |
| **Person + pick cart** | ×1.00 | 24 lines | ×1.00 | ×1.0 | ×1.0 |
| **Person + pallet truck** | ×0.82 | 48 lines | ×1.20 | ×1.4 | ×1.7 |
| **AMR (robot carrier)** | ×1.35 | 20 lines | ×1.05 | ×0.45 | ×0.9 |

There is no free lunch in the table: the pallet truck's 48-line capacity buys fewer trips to
pack but a slower pace and a footprint that triggers congestion at nearly twice the distance.
Humans walk with a real gait — legs and arms driven by *distance actually covered*, so a picker
yielding to another slows to a stop rather than skating along the floor. The AMR has no legs, a
spinning lidar, and is exempt from fatigue.

## Simulation model

Agents run a state machine — `idle → traveling → picking → returning → unloading → awaitPack →
idle`, plus `blocked` and `break` — integrated in fixed 0.1 s slices (the pack line and conveyor
step on the same slices), so `20×` time scale stays stable and
identical to `1×` (asserted in the tests). Position is sampled by arc length along the route
polyline and smoothed toward the mesh, so agents interpolate rather than teleport between nodes.

### The decisions a picker makes

Each is a switch under *Operating behaviour*, so you can price what it is worth. All of them
write to the reasoning trace.

- **Smart dispatch** — score each queued order by SLA pressure and by true graph distance from
  where the picker is standing, then take the best. Already-late orders get a large bonus. Off,
  it degrades to FIFO with express jumping the queue.
- **Batch picking** — after choosing a seed order, keep absorbing queued orders whose nearest
  stop is within 26 m of the tour, up to 4 orders and the embodiment's line capacity. One route
  is planned across the whole batch and all of it is packed together.
- **Congestion re-routing** — after 4 s stuck behind another picker, defer the picks in the
  blocked aisle, work the rest of the tour, and come back. This costs distance, which is
  exactly why the dashboard reports **planned vs actual** on completed tours.
- **Stock depletion** — on-hand falls as picks happen. A location with less than the line calls
  for produces a **short pick**; dropping to its replen point raises a **replen alert**. Levels
  are restored on reset so successive runs stay comparable.
- **Rest breaks & fatigue** — a 5 min break every 55 min of productive work, taken after
  finishing the current tour, plus up to 12% pace decay across a stint.

### Pack-out & dispatch

The stage after picking, with its own controls under *Pack-out & conveyor* and its own cards in
the dashboard (a five-stage flow strip: **Queued › Picking › Pack › Belt › Shipped**).

- **Induction** — a picker's tour ends by handing its totes to a shared induction buffer. If the
  buffer is full the picker *holds at the bench* (phase `awaitPack`), which is counted and shown.
  This is the back-pressure that makes a pack bottleneck visible in picker utilisation.
- **Benches** — the layout's pack stations, of which you staff as many as you like. Each has its
  own pace (±7%), pulls express totes first, and carries an andon beacon in 3D: green packing,
  amber starved, red held by the conveyor, dim when closed.
- **Cartonisation** — `packSetupSec × (1 + 0.55 × extra cartons) + packPerLineSec × lines +
  packPerUnitSec × units`, divided by the bench's pace. Cartons are `ceil(units ÷ unitsPerCarton)`,
  and a bigger consignment is a visibly bigger box on the belt.
- **The conveyor** — one unidirectional loop derived from the facility positions: a takeaway spur
  rises from each bench to an overhead trunk, the trunk runs the length of the pack wall, crosses
  over and declines into a low sorter that passes every door. That geometry is why a parcel from
  any bench can reach any door without ever running backwards. Parcels hold at a merge point when
  there is no 1.15 m gap on the trunk, which is counted as a merge block.
- **Sortation** — each sales channel ships from its own door, so `Wholesale` and `Ecommerce`
  parcels visibly divert to different chutes. Switch sortation off and parcels are hand-trucked
  across the apron instead: no belt, no merge contention, different transit time.
- **Dispatch** — parcels stack on the outbound pad until a trailer seals (16 parcels, or a
  240 s dwell), and part-full trailers ship when the wave drains.
- **The SLA clock now runs to the dock.** An order completes when its parcel is staged for
  loading, so `duration` is the whole lifecycle and the completion record breaks it into pick,
  pack and belt seconds. Picking faster no longer helps if packing cannot absorb it.

Click any parcel in the 3D view — or in the **Parcels in the facility** list — to inspect its
channel, cartons, weight, bench → door route and belt progress.

### Other mechanics

- **SLA** — express orders are due 30 min after release, standard 120 min. The dashboard tracks
  on-time rate and late count; imported orders may supply an explicit `dueAt`.
- **Pick time** — `(pickTimeSec + perUnitTimeSec × qty) × handlingFactor` per line, plus
  `unloadTimeSec × unloadFactor` to drop the totes at the bench. Each picker is assigned a pack
  station round-robin; packing itself is a separate stage (above).
- **Order arrivals** — exponential inter-arrival times (Poisson), so waves release in
  realistic bursts rather than a uniform drip.
- **Demand** — weighted 60/30/10 across fast/medium/slow movers, matching real pick profiles.
- **Congestion** — pickers within `congestionRadius × footprint` yield by index (deterministic,
  so runs are reproducible); the yielding picker's ring turns red and the event is counted.

### What the comparison view does and doesn't measure

Comparison mode is **analytical, not a replay**: the same pick lists are routed from the same
start node with the same handling times, so the only variable is visiting order. That isolates
routing quality from dispatch luck and congestion noise. Walk and total times are therefore
modelled from distance and handling — **congestion waiting is excluded by design**, and the
panel says so. Live congestion is measured separately in the running simulation.

---

## Notes and known limits

Deliberate prototype scope:

- **Congestion is proximity-based**, not a true reservation/deadlock model. It surfaces
  contention convincingly but will not prove out a 40-picker floor.
- **Single-block routing only.** With multiple cross aisles, the classic mid-point and
  largest-gap heuristics would beat plain serpentine; the registry is set up so they can be
  added as a fourth and fifth strategy.
- **Up to 24 pickers.** There are eight validated identity colours, so past the eighth the
  palette cycles and the P-number carries identity — every picker wears it as a 3D sprite and on
  its dashboard chip. Beyond roughly 12 on the 8-aisle module you are mostly measuring gridlock,
  which is a legitimate thing to show but not a throughput result.
- **Bay-level routing.** Slot-level pick points would add a metre or two of realism per stop
  and roughly 4× the graph.
- **Batch metrics are apportioned.** Orders sharing a tour finish together, so each is credited
  its line-share of the tour's actual distance and the full tour duration. Per-order distance is
  an allocation, not a measurement.
- **One parcel per order.** Multi-carton orders are modelled as one parcel carrying `n` cartons
  (bigger box, longer pack cycle) rather than `n` items sorted independently. Splitting them would
  need per-carton identity through the sorter and a consolidation step at the door.
- **Merge contention only at the spurs.** Everything on the trunk moves at one belt speed, so
  parcels cannot overtake and gaps are preserved by construction; the only place a parcel can be
  held is joining the trunk. There is no accumulation-lane or chute-full model.
- **Trailer loading is bookkeeping.** A door seals at 16 parcels or a 240 s dwell and the stack
  clears. There is no dock scheduling, trailer capacity by volume, or carrier cut-off time.
- **Re-routing snaps forward** to the next graph node (≤ one bay pitch) when it re-plans. That
  short walk is credited to the picker's distance so the books balance, but the mesh visibly
  catches up.
- **No replenishment tasks.** Locations raise a replen alert but nothing refills them, so a very
  long run drives fast movers towards zero and short-pick rates upward. Reset restores stock.
- **Uniform fleet.** All pickers share one embodiment; a mixed fleet (two humans and an AMR)
  would need per-agent profiles rather than a single setting.
- The bundled `sampleOrders.json` is written against `dc-north` location codes. Switching
  layouts generates fresh demand instead, since those codes will not resolve elsewhere.

## Theming

**Light is the default** — a bright, high-key facility view with an operations-console shell.
Dark ships too; toggle in the top bar or press `t` (the choice persists, and first load follows
the OS preference).

Both modes are *selected*, not flipped. Every palette was re-validated against the surface it
actually renders on, and the exact validator commands are recorded next to each palette:

| Palette | Where | Recorded in |
|---|---|---|
| Chart series / ordinal bars | Card surface | [src/ui/theme.ts](src/ui/theme.ts) |
| SKU velocity tiers | Card surface **and** the 3D floor | [src/scene/theme.ts](src/scene/theme.ts) |
| Picker identity | Card surface | [src/ui/theme.ts](src/ui/theme.ts) |

Two findings worth keeping:

- **Velocity tiers are not a literal hot/warm/cold ramp.** Red/yellow/blue was the first choice
  and it validates in light, but on a dark surface the lightness band is narrow and red↔yellow
  collapse to ΔE ≈ 3 under deuteranopia — lightness separation is what rescues that pair and
  there is no room for it. The tiers therefore use the one trio documented as clearing every
  all-pairs gate in *both* modes.
- **Picker colours are rotated away from the tier hues** (they open on violet / magenta /
  yellow / green), because a picker's floor trail runs right past the bins it is walking to. With
  1–5 pickers nothing is shared. The 4th picker's green does sit near the medium-mover green —
  the weakest pair in the set, tolerable because trails are thin floor ribbons under elevated
  boxes and every picker carries its `P1`/`P2` label in 3D.

Design tokens are one `--ink-N` ramp that runs **background → foreground** (950 page plane →
100 primary text), so it inverts per mode and every component is written once against ramp
position rather than absolute lightness. Details in the header of
[src/index.css](src/index.css).

## Stack

Three.js r185 · React 19 · TypeScript (strict) · Zustand 5 · Tailwind CSS 3 · Recharts 3 ·
Vite · Vitest. No backend.
