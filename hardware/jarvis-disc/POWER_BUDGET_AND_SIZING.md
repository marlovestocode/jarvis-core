# Jarvis Disc Mk I: power budget and supply sizing

**Status: supply architecture intentionally unselected pending measurements. No current rating or fuse value is approved.**

## 1. Known load envelope

The device currently lists 70 main addressable LEDs and 17 seam LEDs. At a conservative theoretical upper bound of 60 mA per pixel at full-white, 87 pixels represent:

- 5.22 A at 5 V
- 26.1 W at 5 V

This is a pixel-only theoretical bound. It is not a measured operating current, does not include the controller, amplifier, microphones, conversion losses, or startup/transient behavior, and must not be used as the final supply rating.

The former 5 V / 3 A supply and 3 A fuse assumptions are not approved. Do not increase fuse size without coordinating the connector, cable, PCB copper, wiring, converter, and fault protection.

## 2. Measurement plan

Measure at the regulated 5 V distribution input with the complete system assembled or with a representative harness and final intended firmware.

Record both steady-state current and transient peak for:

| Test | Required condition |
|---|---|
| Idle | Wi-Fi connected, LEDs off, audio idle |
| Network activity | Wi-Fi transmit/receive and normal endpoint traffic |
| LED animation | Actual maximum intended brightness and worst-case animation |
| LED full-white | Only if firmware allows it; document the enforced brightness/current cap |
| Audio playback | Maximum intended output, representative speech and sustained test tone |
| Microphone capture | Both microphones active and streaming |
| Combined worst case | LED animation, audio playback, microphone capture, and network activity together |
| Startup | Cold boot and simultaneous LED initialization |
| Fault/recovery | Brownout, reconnect, and repeated startup behavior |

Use an appropriately rated inline power analyzer or calibrated shunt/current probe. Capture fast transients with an oscilloscope/current probe where necessary; a slow USB meter may miss peaks. Repeat tests and record instrument accuracy, sampling bandwidth, supply voltage, firmware commit, ambient temperature, and test duration.

Do not sum independently observed component peaks unless they are proven to occur simultaneously. The decisive system value is the measured complete-device load under the intended worst-case combined condition.

## 3. Sizing calculation

Use `tools/power-budget.js` with a completed copy of `tools/power-budget-template.json`.

The calculator reports:

- measured 5 V steady-state output power;
- steady-state output current with the configured design headroom;
- measured system transient peak current and power;
- estimated PD input power/current using the entered converter efficiency and negotiated PD voltage.

The template's headroom percentage is an engineering input, not a substitute for transient capture or thermal validation. Enter converter efficiency from the selected converter's datasheet at the actual operating point, then confirm it experimentally.

Choose a PD sink profile and DC/DC stage only after the measured values are available. Verify the PD source, cable, sink/controller, converter continuous and peak ratings, protection, connectors, wire gauge, PCB copper, capacitors, and ground distribution as one system. Validate thermal behavior at the actual load. Fuse selection must protect the weakest downstream conductor/component and coordinate with inrush and normal operating current; never size it from the supply rating alone.

## 4. Distribution and measurement requirements

- Keep high-current LED and amplifier return currents out of sensitive microphone/controller return paths through deliberate power/ground layout.
- Add test points at USB-C/PD input, regulated 5 V distribution, controller 3V3, amplifier supply, and LED supply.
- Record voltage at the load during combined peak operation, not only at the converter output.
- Check connector and cable voltage drop, ground bounce, LED data integrity, ESP32 resets, audio artifacts, and amplifier clipping.
- Confirm the selected protection device interrupts faults safely without nuisance trips during startup.
- Verify USB-C PD negotiation and behavior with the intended source and cable. Do not assume a generic USB-C port supplies a chosen PD voltage/current.

## 5. Release gate

The power design is accepted only when the complete-device steady and transient measurements are recorded, the PD profile and converter are selected from those measurements, all downstream ratings are checked, voltage remains within each component's specified range during combined peaks, and the extended thermal test passes.

**Until then, the supply, converter, fuse, connector, wire, and PCB current ratings remain TBD.**
