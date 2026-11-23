# Jarvis Disc, Mk I

A small desk voice node for jarvis-core: a 139 mm disc, 53.3 mm tall, that listens, sends your request to the main server, plays the reply from its own speaker, and animates its lights from the audio it is playing.

**Status: CAD prototype, not manufacturing-ready.** The Dayton Audio CE52N-4 is selected, but the enclosure has not been physically fit-checked. The 48 mm CAD opening is provisional and is not a confirmed fit. Board dimensions and the custom LED PCB remain provisional. Do not order a production run from this revision.

## What is in this folder

| Path | What it is |
|---|---|
| `jarvis_disc.scad` | Parametric CAD source (OpenSCAD 2021.01 or newer). Edit the variables at the top, re-export. |
| `stl/01_plinth.stl` ... `05_bezel.stl` | The five printable parts, already in print orientation. |
| `laser/top_window.svg` | Smoked acrylic top, 2 mm: red = cut, blue = engrave. |
| `led_layout.csv` | X/Y of all 70 LEDs, the 6 mounting holes and the 4 mic ports, for the LED PCB. |
| `drawings/jarvis-disc-illustration.*` | The 2D illustration (SVG + PNG). |
| `drawings/jarvis-disc-technical.*` | Section, exploded view, LED map, parts list (SVG + PNG). |
| `drawings/jarvis-disc-wiring.*` | Wiring diagram (SVG + PNG). |
| `drawings/jarvis-disc-speaker.*` | Speaker placement, sealed chamber volume and expected response (SVG + PNG). |
| `tools/` | Scripts that regenerate source-derived assets and validate exported STL meshes. |

Export a part yourself, for example: `openscad -D 'part="body"' -o build/stl/03_upper_body.stl jarvis_disc.scad` (parts: `plinth`, `sleeve`, `body`, `baffle`, `bezel`, `assembly`). The CAD validation workflow exports all five printable parts into a generated artifact; it does not silently replace the committed STL files.

## Printed parts

| File | Material | Notes |
|---|---|---|
| `01_plinth` | Black PETG or ASA, 0.2 mm layers, 4 walls, 20% infill | Print upright. Speaker shelf, board bay, USB-C slot (rear), mute button hole, 3 posts for M3. |
| `02_diffuser_sleeve` | Natural or white translucent PETG, 3 walls | Print upright. It is the lit band between plinth and body. |
| `03_upper_body` | Black PETG or ASA, 4 walls, 20% infill | Print upright, no supports. Decorative grille, engraved JARVIS / NODE 001 / MK I, 6 PCB posts. |
| `04_led_baffle` | Black PETG, 0.12 mm layers | Print flat. A hole over every LED stops light bleeding between pixels. |
| `05_bezel` | Printed upside down as exported, or CNC aluminium | Gold look: sand, prime, gold metallic paint, or anodise a CNC ring. |

For a smoother finish than FDM can give, order the plinth, body and bezel in SLA resin or MJF nylon (dyed black) and finish with matt paint. **STL status:** the committed exports predate the latest speaker/enclosure revision. They are not approved for printing. Regenerate them from the current SCAD source and run `python tools/validate-meshes.py build/stl/*.stl` before use. The GitHub Actions workflow `.github/workflows/jarvis-disc-cad.yml` builds all five parts, validates the meshes, renders drawing previews, and uploads a ZIP artifact on a matching pull request or manual dispatch.

## Parts you buy (prices are rough guesses, get real quotes)

| Qty | Part | Notes |
|---|---|---|
| 1 | Seeed XIAO ESP32-S3 | Controller. Pin plan is in the wiring diagram. |
| 1 | MAX98357A I2S amplifier breakout | Drives the speaker. |
| 2 | INMP441 I2S microphone breakout | Budget option. For talking over Jarvis, use a ReSpeaker XVF3800 4-mic array instead (echo cancellation). |
| 1 | Dayton Audio CE52N-4 full-range driver, 2 inch, 4 ohm, 5 W RMS (about US$8) | Mounted face down on a sealed 0.5 mm foam gasket, back into the plinth. Manufacturer data: 52 mm outside diameter, 47.5 mm baffle cutout, 30.8 mm depth. The manufacturer drawing does not define a conventional mounting-hole pattern; a separate mechanical clamp/retainer must be designed around measurements from the actual driver before printing. See `drawings/jarvis-disc-speaker.*`. |
| 1 | LED PCB, 70 addressable LEDs (SK6812 mini-E or similar) | Custom board: positions are in `led_layout.csv`. A PCB maker can fabricate and assemble a small run. |
| 1 | 5-6 mm wide LED strip, 17 pixels | Wraps the plinth neck. |
| 1 | 2 mm smoked acrylic, 124 mm disc | From `laser/top_window.svg` at any laser-cutting service. |
| 1 | 1 mm opal acrylic or frosted film, 123.6 mm disc | The diffuser. |
| 1 | 74AHCT125, 330 ohm resistor, 1000 uF capacitor, USB-C PD input and regulated 5 V power stage sized from measured load | Power and LED data. The previous 5 V / 3 A supply and 3 A fuse assumption is not approved for the full 87-pixel build. |
| 1 | Latching 4PDT microphone mute switch plus auxiliary state contact | Proposed topology opens mic 3V3, BCLK, WS and SD. Exact switch part number and schematic remain to be selected and validated. See `MICROPHONE_MUTE_AND_POWER.md`. |
| 4 | Rubber feet, 10 mm, 3 mm tall | |
| about 12 | M2 and M3 screws, M3 heat-set inserts, standoffs | Plinth posts take M3; PCB posts take M2. |

A ballpark for the whole build is roughly 130 to 250 USD depending on the PCB run and whether the bezel is CNC. That is a guess, not a quote.

## Electrical design status

The speaker retention method is not yet designed or validated; use `SPEAKER_FIT_AND_RETENTION.md` before changing the plinth. The mute proposal is not a schematic and requires the exact switch and bench evidence in `MICROPHONE_MUTE_VALIDATION.md`. Power sizing is measurement-gated; use `POWER_BUDGET_AND_SIZING.md` and `tools/power-budget.js` with a completed `tools/power-budget-template.json`. Thermal and acoustic release tests are defined in `THERMAL_AND_ACOUSTIC_VALIDATION.md`.

The former 5 V / 3 A supply assumption is not approved: 87 addressable LEDs have a theoretical full-white upper bound of 5.22 A at 5 V before the rest of the system. The final power architecture must be selected from measured worst-case loads. The proposed physical mute topology and power design gates are documented in `MICROPHONE_MUTE_AND_POWER.md`.

## Assembly order

1. Test the electronics on a breadboard first (controller, mic, amp, LED PCB): wake word, a spoken reply, lights, and worst-case power draw.
2. Build and bench-verify the physical 4PDT mic isolation circuit before installing the microphones. Follow `MICROPHONE_MUTE_AND_POWER.md`; a GPIO-only mute is not acceptable.
3. Fit the physically measured speaker and validated retainer into the plinth. Route the USB-C and the mute switch.
4. Wrap the LED strip around the plinth neck and slide the frosted sleeve over it.
5. Bolt the body to the plinth through the three posts (M3).
6. In the body: mic board on its standoffs, then the LED PCB on the six posts, then the baffle, diffuser and smoked acrylic.
7. Glue the bezel on over the acrylic edge. Fill the engraving with paint.

## Things to check before you order

- **Speaker retention and fit.** The CE52N-4 dimensions are manufacturer-published, but the drawing does not provide a mounting-hole pattern. The current 48 mm CAD opening is provisional. Measure the actual driver and design a separate clamp/retainer, gasket, sealing land and terminal clearance before printing a final plinth. Measure every board and change the variables at the top of `jarvis_disc.scad`.
- **Mic ports.** The 4 ports are at radius 44.5 mm, at 45, 135, 225 and 315 degrees. Your mic board must put its mics under them, or move the ports.
- **Engraving.** Letters are bold, 0.6 mm deep. Thin fonts fail on FDM.
- **Top etching.** The laser file is drawn from above; if your shop engraves the underside, mirror it. Convert the ROOM NAME text to outlines.
- **Fonts and the bezel.** CNC shops may want a proper solid or a drawing of the profile; the STL works for printing only. Ask and I can export the profile.

## Honest trade-offs in this version

- **The stack is tight.** Mic board parts sit about 0.5 mm under the LED PCB. The selected CE52N-4 is 30.8 mm deep and the plinth was raised to accommodate it. Speaker retention is still unresolved; the proposed retainer is a removable mechanical capture system dimensioned only after measuring the actual flange. Check actual board and driver clearances before ordering.
- **Music works, bass is limited.** The sealed plinth volume and response are estimates, not measured results. The driver has 0.85 mm Xmax; apply appropriate high-pass protection and validate excursion at the intended maximum level. The plinth must be airtight (cable hole, USB-C slot, mute opening, body joint). `jarvis_disc.scad` has the taller plinth (`lift = 16.5`, 53.3 mm overall) and a provisional 48 mm speaker opening, but the committed STL files have not been re-exported.
- **The side grille is decorative.** Sound leaves from the speaker firing down, through the 4 mm gap under the feet. Expect modest bass. If you want a louder grille, a later version can use two small side-firing drivers.
- **Visible LED dots.** Under smoked acrylic the LEDs show as points. The diffuser sheet softens them at some cost in brightness.
- **The lit blade under MK I** is a plain engraved detail, not a light.

## How it talks to the server

The box is a thin client. On wake it streams microphone audio to jarvis-core over a WebSocket, receives state messages and speech audio back, plays the audio itself, and drives the lights from the samples it is playing (small delay so light and sound line up). Details are in the design conversation; the server needs a "reply target" field so the answer goes to the box instead of the PC speaker.
