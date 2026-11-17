# Mr. Adam — FRC robot CAD

A browser CAD tool built to make FRC robot design feel obvious: Onshape's layout, Blender's viewport,
a built-in FRC parts library, and wiring that routes itself.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

It opens with a sample swerve drivebase so there is something to poke at. Your design autosaves in the
browser; **Export / Import** saves it as a `.json` file.

## What it does

| | |
|---|---|
| **Extrusions** | Press `T`, click, drag, click. Length snaps to ½" and the hole pattern grows with it. Drag the orange arrows on a selected tube to resize. Profiles: 2×1, 1×1, 2×2, ½" hex shaft; holes on ½" pitch, 1" pitch, or none. |
| **Plates** | Press `P`, pick the Top / Front / Right plane or any flat face, sketch rectangles, lines, circles and holes, click a dimension to type a value, then ✓ to extrude. Depth, material (aluminum / polycarbonate) and side are in the Extrude panel; double-click a plate to edit its sketch. Holes of neighbouring parts show as white dots you can snap to. |
| **Parts library** | Swerve module, wheels, Kraken / Falcon / NEO / NEO 550 / CIM, SPARK MAX, Talon SRX, roboRIO, PDH, battery, breaker, radio, RSL, CANcoder, Pigeon, Limelight, gears, sprockets, pulleys, bearings, gearbox, pneumatics, gussets. Click or drag a tile into the view; `S` opens a quick-add palette at the cursor. |
| **Assembly** | Drag a part and it snaps hole-to-hole or onto a face and mates itself. Moving a part carries everything mounted on it. The Mate tool (`M`) joins two connectors by hand; mates can be fastened, revolute or slider. |
| **Wiring** | **Auto-wire** builds the harness (battery → breaker → PDH, a PDH channel per device, motor leads to controllers, one CAN daisy chain, Ethernet, RSL) and routes every cable along the structure by the shortest path without crossing another cable. Click a wire and drag a handle to pin it somewhere else; everything stays crossing-free. The Wire tool (`W`) connects two ports by hand. |
| **BOM** | Part counts, weight, and cable lengths per type. |

## Controls

| Key | Action |
|---|---|
| MMB drag / Shift+MMB / wheel | Orbit / pan / zoom (Alt+LMB and right-drag also orbit) |
| `1` `3` `7` (Shift = opposite), `5` | Front / right / top view, perspective ↔ ortho |
| `F`, `Home` | Frame selection / everything |
| `G`, `R` | Grab / rotate; then `X` `Y` `Z` to lock an axis, type a number, Enter |
| `Shift+D`, `X` / `Del` | Duplicate, delete |
| `Ctrl+Z`, `Ctrl+Shift+Z` | Undo, redo |

## How the wire router works

The robot volume is voxelised into ½" cells (`src/wiring/router.js`). Parts mark cells solid; each wire is
routed with A* over the grid and claims the cells it uses, so two wires can never occupy the same space.
Cells touching a part are cheaper than open air, which makes cables hug tubes and plates. If a wire is
forced to cross, it is ripped up along with the wires it hit and they are re-routed in a different order.

Units are inches throughout. Parts are simplified procedural models, not vendor CAD.
