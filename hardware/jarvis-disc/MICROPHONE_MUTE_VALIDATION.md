# Jarvis Disc Mk I: physical microphone mute circuit validation

**Status: topology specified; exact switch, schematic, and bench evidence are still required. This is not a validated circuit.**

## 1. Safety invariant

The physical, mechanically latching switch is the privacy authority. Firmware, server commands, boot state, Wi-Fi, and OTA must never be able to reconnect the microphone path while MUTED.

The existing proposal is a break-before-make 4PDT switch plus an independent auxiliary dry contact. The four switched conductors are:

| Pole | UNMUTED path | MUTED state |
|---|---|---|
| 1 | 3V3 microphone supply to both INMP441 modules | Open |
| 2 | XIAO I2S BCLK to both modules | Open |
| 3 | XIAO I2S WS/LRCLK to both modules | Open |
| 4 | Both microphone SD outputs to XIAO I2S input | Open |

Place the switch between the controller and microphone modules. Preserve the opposite L/R channel straps required by the two selected microphone modules. Do not assume breakout-board labels, pin numbering, or signal behavior without checking the exact module revision.

## 2. Circuit capture requirements

The schematic must show all of the following before PCB layout:

- Exact switch manufacturer, part number, contact arrangement, break-before-make specification, terminal numbering, current/voltage ratings, panel cutout, actuator travel, and mechanical latching behavior.
- Separate nets for XIAO-side and microphone-side BCLK, WS, SD, and mic 3V3.
- Both microphone modules, their L/R straps, decoupling, and the actual breakout-board pinout.
- The auxiliary dry contact to D5 / GPIO6 as a read-only state input. It must not drive any of the four isolation poles.
- Hardware mute indication driven from the auxiliary contact, with a defined indication polarity. The indicator circuit must not back-power the microphone supply or signal pins.
- Grounding and test points on both sides of each switched signal and the microphone supply.
- Any pull resistors or series components with values justified against the exact microphone and ESP32 datasheets and measured bus timing.

Do not select a switch based only on the label “4PDT.” Verify that all four poles are independent, break-before-make, mechanically linked, and rated for the actual low-voltage signal and supply use. A switch with an auxiliary pole is acceptable if its auxiliary contact is electrically independent.

### Back-powering review

Opening microphone VDD alone is insufficient. The BCLK, WS, and SD conductors must also be isolated. With MUTED selected, measure every microphone-side signal and supply pin relative to microphone ground while the XIAO is powered. Any unexpected residual voltage requires investigation. Do not assume pull-down resistors eliminate all phantom-power paths.

The XIAO-side bus must remain in a defined idle state while disconnected. Choose pull resistor values only after reviewing input leakage, output drive, bus timing, and microphone requirements. Do not blindly add pull-downs to the microphone side or to the shared SD bus.

## 3. Bench test procedure

Use a current-limited supply for initial bring-up. Capture the exact switch part number, wiring revision, module revisions, firmware commit, and instrument details.

1. **Continuity, power removed:** In UNMUTED, verify each intended pole connects to the correct destination. In MUTED, verify each of the four paths is open. Confirm the auxiliary contact reports the physical position correctly.
2. **UNMUTED electrical test:** Power the system. Measure mic VDD at both modules and confirm BCLK, WS, and SD activity at the microphone-side test points.
3. **MUTED electrical test:** Move the physical switch to MUTED. Verify mic VDD is absent at both modules and all three signal paths are open. Measure residual voltage on all microphone-side pins.
4. **Controller fault tests:** Repeat while the XIAO is booting, held in reset, firmware-crashed, disconnected from Wi-Fi, disconnected from the server, and performing OTA. MUTED must remain electrically isolated in every case.
5. **Audio-path test:** While MUTED, inject a controlled acoustic signal near the microphones. Verify no microphone samples appear at the XIAO capture path or server ingress. Distinguish this from playback audio and other audio sources.
6. **Switch transition test:** Exercise the switch repeatedly while monitoring supply and signal pins. Confirm no transient state reconnects the microphones in the latched MUTED position.
7. **Indicator test:** Confirm the physical indicator always agrees with the switch and remains correct during controller reset and power loss. Verify it cannot energize microphone-side pins.
8. **Assembly test:** Repeat the full test with the switch installed in the enclosure and wiring routed as intended.

Use a multimeter for static continuity/voltage checks and an oscilloscope or logic analyzer for signal transitions. Preserve captures and test logs.

## 4. Pass criteria

- All four poles are open in MUTED and connect only to their intended paths in UNMUTED.
- No microphone-side supply or signal pin is unintentionally energized in MUTED.
- No captured microphone samples reach the controller or server while physically muted.
- Firmware and server actions cannot override the physical isolation.
- The mute indication reports the actual mechanical switch state independently of firmware.
- No contact intermittency or unintended reconnection occurs during transition or endurance testing.

## 5. Required evidence

Attach the reviewed schematic PDF/source, exact switch datasheet, pin-to-pin wiring table, bench photos, meter readings, scope/logic captures, server-ingress evidence, test firmware commit, and completed test log to the release record.

**Until all evidence exists, describe this as a proposed hardware mute topology, not a validated privacy circuit.**
