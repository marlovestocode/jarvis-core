# Jarvis Disc Mk I manufacturing readiness

**Status: NOT APPROVED FOR PRODUCTION**

This checklist is the release gate for the Mk I hardware. A checked item requires recorded evidence, not an assumption from CAD.

## A. Speaker and enclosure

- [ ] Obtain and archive the current Dayton Audio CE52N-4 manufacturer drawing/specification.
- [ ] Measure one physical driver: flange OD, flange thickness, body depth, terminal position, and any actual fixing features.
- [ ] Confirm the 47.5 mm nominal baffle cutout against the actual driver. The SCAD currently uses a 48.0 mm provisional opening for 0.5 mm diametral clearance; this is not a validated fit.
- [ ] Design and document a positive speaker-retention method. The present CAD does not establish a verified mounting-hole pattern or complete retention system.
- [ ] Confirm speaker terminals and wires clear the plinth, boards, posts, and enclosure walls.
- [ ] Confirm gasket compression, sealing land width, and serviceability.
- [ ] Confirm internal chamber volume from the final assembled geometry, including actual component displacement and leaks.

## B. Physical microphone privacy

- [ ] Select a latching, mechanically stable mute switch.
- [ ] Review `MICROPHONE_MUTE_AND_POWER.md` and capture a schematic for a mechanically latching 4PDT mute that opens mic 3V3, BCLK, WS, and SD, plus a separate auxiliary state contact.
- [ ] Select an exact break-before-make switch and auxiliary contact; record manufacturer part numbers, pinout, contact ratings, and mounting dimensions.
- [ ] Prevent signal-line back-powering of an unpowered microphone. Validate the isolation topology against the selected microphone modules.
- [ ] Route a separate hardware mute-state signal to the XIAO ESP32-S3. Firmware must only read the state; it must not be able to defeat the isolation.
- [ ] Make the mute indicator reflect the physical switch state.
- [ ] Test mute during boot, firmware crash, Wi-Fi loss, OTA update, and server disconnection.
- [ ] Verify with a logic analyzer / oscilloscope and server-side capture that no microphone samples are transmitted while physically muted.

**Do not treat the current GPIO-to-ground mute circuit as a privacy mute.** It is only a software input and does not interrupt microphone operation.

## C. Power and thermal validation

- [ ] Replace the assumed 5 V / 3 A supply and 3 A fuse with a measured, documented power architecture; see `MICROPHONE_MUTE_AND_POWER.md`.
- [ ] Build a complete load budget for 70 main LEDs, 17 seam LEDs, XIAO, microphones, amplifier, and all conversion/level-shifting circuitry.
- [ ] Measure steady-state and transient current at maximum intended LED brightness and audio output.
- [ ] Verify supply, connector, fuse, PCB traces, wire gauge, and ground return for measured loads.
- [ ] Confirm USB-C source negotiation/current capability matches the actual design. Do not assume a generic 5 V / 3 A source is sufficient.
- [ ] Measure regulator, amplifier, LED, and enclosure temperatures during an extended worst-case test.
- [ ] Confirm brownout behavior and safe recovery after power interruption.

## D. CAD and fabrication files

- [ ] Install/use a pinned OpenSCAD version and render all five printable parts from the current SCAD source.
- [ ] Review render warnings and verify the generated STLs correspond to the current source revision.
- [ ] Run the STL checker and a second independent mesh/manifold check.
- [ ] Confirm part dimensions, print orientation, wall thickness, inserts, clearances, and assembly tolerances.
- [ ] Regenerate laser and drawing assets from their source scripts after all geometry and wiring are final.
- [ ] Verify the LED PCB layout against the actual PCB design, connector location, mic ports, and mounting holes.
- [ ] Archive source revision, tool versions, exported files, and checksums together.

## E. Prototype validation

- [ ] Print one complete enclosure and physically fit every purchased component.
- [ ] Confirm top window, diffuser, bezel, sleeve, plinth, and body fit without forced assembly.
- [ ] Test speaker response, vibration, rattles, leakage, and distortion at intended volume.
- [ ] Test microphone pickup, playback echo, and full-duplex behavior.
- [ ] Test all LED states and synchronization during audio playback.
- [ ] Complete the physical mute tests in section B.
- [ ] Complete power and thermal tests in section C.
- [ ] Run an extended soak test and document failures and corrective revisions.

## F. Release package

- [ ] Final BOM with exact manufacturer part numbers, quantities, supplier links, and approved alternates.
- [ ] Final wiring schematic and connector/pin table.
- [ ] Final CAD source, verified STLs, laser files, PCB manufacturing files, and drawings.
- [ ] Assembly instructions with photographs and torque/adhesive/sealing notes.
- [ ] Firmware flashing, provisioning, identity registration, and OTA procedure.
- [ ] Per-unit QA checklist and serial-number record.
- [ ] Release tag and archived checksums.

## Release decision

The Disc remains **prototype-only** until sections A through E have evidence recorded and section F is complete. The 48.0 mm speaker opening is provisional, the retention method is unresolved, and the proposed 4PDT microphone isolation topology still needs exact component selection, schematic capture, and bench validation. The power architecture is not selected.
