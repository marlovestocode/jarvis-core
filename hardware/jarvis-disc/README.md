# Jarvis Disc, Mk I

A small desk voice node for jarvis-core: a 139 mm disc, 53.3 mm tall, that listens, sends your request to the main server, plays the reply from its own speaker, and animates its lights from the audio it is playing.

**Status: v0.1 fit-check design. Nothing here has been printed or built yet.** Third-party part sizes (speaker, boards, LED PCB) are placeholders until you pick real parts; see "Check before you order".

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
| `tools/` | Scripts that regenerate the CSV, laser file, drawings and check the STLs. |

Export a part yourself, for example: `openscad -D 'part="body"' -o stl/03_upper_body.stl jarvis_disc.scad` (parts: `plinth`, `sleeve`, `body`, `baffle`, `bezel`, `assembly`).

## Printed parts

| File | Material | Notes |
|---|---|---|
| `01_plinth` | Black PETG or ASA, 0.2 mm layers, 4 walls, 20% infill | Print upright. Speaker shelf, board bay, USB-C slot (rear), mute button hole, 3 posts for M3. |
| `02_diffuser_sleeve` | Natural or white translucent PETG, 3 walls | Print upright. It is the lit band between plinth and body. |
| `03_upper_body` | Black PETG or ASA, 4 walls, 20% infill | Print upright, no supports. Decorative grille, engraved JARVIS / NODE 001 / MK I, 6 PCB posts. |
| `04_led_baffle` | Black PETG, 0.12 mm layers | Print flat. A hole over every LED stops light bleeding between pixels. |
| `05_bezel` | Printed upside down as exported, or CNC aluminium | Gold look: sand, prime, gold metallic paint, or anodise a CNC ring. |

For a smoother finish than FDM can give, order the plinth, body and bezel in SLA resin or MJF nylon (dyed black) and finish with matt paint. All five STL files are watertight (checked with `tools/stl-check.js`).

## Parts you buy (prices are rough guesses, get real quotes)

| Qty | Part | Notes |
|---|---|---|
| 1 | Seeed XIAO ESP32-S3 | Controller. Pin plan is in the wiring diagram. |
| 1 | MAX98357A I2S amplifier breakout | Drives the speaker. |
| 2 | INMP441 I2S microphone breakout | Budget option. For talking over Jarvis, use a ReSpeaker XVF3800 4-mic array instead (echo cancellation). |
| 1 | BLAM Audio FRS 2N50 full-range driver, 50 mm, 4 ohm, 25 W nominal | Mounted face down on a 0.5 mm foam gasket, back into the sealed plinth (about 0.2 L). 32 mm deep by my reading of the datasheet drawing: confirm it before ordering. Maker: blam-audio.com. See `drawings/jarvis-disc-speaker.*`. |
| 1 | LED PCB, 70 addressable LEDs (SK6812 mini-E or similar) | Custom board: positions are in `led_layout.csv`. A PCB maker can fabricate and assemble a small run. |
| 1 | 5-6 mm wide LED strip, 17 pixels | Wraps the plinth neck. |
| 1 | 2 mm smoked acrylic, 124 mm disc | From `laser/top_window.svg` at any laser-cutting service. |
| 1 | 1 mm opal acrylic or frosted film, 123.6 mm disc | The diffuser. |
| 1 | 74AHCT125, 330 ohm resistor, 1000 uF capacitor, 3 A resettable fuse, USB-C breakout (5.1k resistors) | Power and LED data. |
| 1 | Momentary push button, 6 mm | Mic mute. |
| 4 | Rubber feet, 10 mm, 3 mm tall | |
| about 12 | M2 and M3 screws, M3 heat-set inserts, standoffs | Plinth posts take M3; PCB posts take M2. |

A ballpark for the whole build is roughly 130 to 250 USD depending on the PCB run and whether the bezel is CNC. That is a guess, not a quote.

## Assembly order

1. Test the electronics on a breadboard first (controller, mic, amp, LED PCB): wake word, a spoken reply, lights.
2. Fit the speaker and boards into the plinth. Route the USB-C and the mute button.
3. Wrap the LED strip around the plinth neck and slide the frosted sleeve over it.
4. Bolt the body to the plinth through the three posts (M3).
5. In the body: mic board on its standoffs, then the LED PCB on the six posts, then the baffle, diffuser and smoked acrylic.
6. Glue the bezel on over the acrylic edge. Fill the engraving with paint.

## Things to check before you order

- **Speaker and boards.** All sizes here are placeholders. Measure the parts you buy and change the variables at the top of `jarvis_disc.scad`.
- **Mic ports.** The 4 ports are at radius 44.5 mm, at 45, 135, 225 and 315 degrees. Your mic board must put its mics under them, or move the ports.
- **Engraving.** Letters are bold, 0.6 mm deep. Thin fonts fail on FDM.
- **Top etching.** The laser file is drawn from above; if your shop engraves the underside, mirror it. Convert the ROOM NAME text to outlines.
- **Fonts and the bezel.** CNC shops may want a proper solid or a drawing of the profile; the STL works for printing only. Ask and I can export the profile.

## Honest trade-offs in this version

- **The stack is tight.** Mic board parts sit about 0.5 mm under the LED PCB, and the speaker can be at most 10 mm deep. Check real part heights before ordering.
- **Music works, bass is limited.** The sealed plinth (about 0.2 L) rolls off near 230 Hz with no boom: a clean desk speaker, not a bass speaker. The plinth must be airtight (cable hole, USB-C slot, mute hole, body joint). `jarvis_disc.scad` has the taller plinth (`lift = 16.5`, 53.3 mm overall) but the STL files are not re-exported yet.
- **The side grille is decorative.** Sound leaves from the speaker firing down, through the 4 mm gap under the feet. Expect modest bass. If you want a louder grille, a later version can use two small side-firing drivers.
- **Visible LED dots.** Under smoked acrylic the LEDs show as points. The diffuser sheet softens them at some cost in brightness.
- **The lit blade under MK I** is a plain engraved detail, not a light.

## How it talks to the server

The box is a thin client. On wake it streams microphone audio to jarvis-core over a WebSocket, receives state messages and speech audio back, plays the audio itself, and drives the lights from the samples it is playing (small delay so light and sound line up). Details are in the design conversation; the server needs a "reply target" field so the answer goes to the box instead of the PC speaker.
