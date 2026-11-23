# Jarvis Disc Mk I: microphone mute and power design note

**Design status: engineering proposal, not a validated schematic.** Build and bench-test this circuit before committing it to a PCB or enclosure.

## 1. Required mute behavior

The physical switch is the privacy authority. Firmware, the server, network state, boot state, and OTA updates must not be able to reconnect the microphones while the switch is in MUTE.

For the current two-INMP441 topology, the microphone interface has four conductors that must be isolated:

| Pole | Connected in UNMUTED | Open in MUTED |
|---|---|---|
| 1 | Switched 3V3 microphone supply | Both microphone VDD pins disconnected |
| 2 | XIAO I2S BCLK to both microphones | BCLK disconnected at the microphone side |
| 3 | XIAO I2S WS/LRCLK to both microphones | WS disconnected at the microphone side |
| 4 | Both microphone SD outputs to XIAO I2S data input | SD bus disconnected from the XIAO |

Use a mechanically latching **4PDT** switch with break-before-make contacts. Place it between the XIAO and the microphone modules, not on the shared XIAO bus side. Both INMP441 modules share BCLK, WS, and SD; their L/R select pins remain strapped for opposite channels as required by the selected modules.

This arrangement opens microphone power and every digital signal conductor, preventing the ESP32 from phantom-powering an unpowered microphone through its I/O pins. Add weak pull-downs on the XIAO-side BCLK, WS, and SD nets so the disconnected bus has a defined idle state. Select resistor values after checking the INMP441 interface timing and the XIAO input requirements; do not place pull-downs on the microphone side that compromise the microphone outputs.

### Mute-state sensing and indication

Use a separate mechanically coupled auxiliary SPST contact (or a switch with an additional auxiliary pole) for state sensing. Wire it as a dry contact to ground with an ESP32 internal/external pull-up on D5 / GPIO6. The contact reports the physical position only; it does not control the four isolation poles.

Drive the mute indicator from this auxiliary contact using a hardware path, not only firmware, so the indicator still reports MUTE if the ESP32 crashes. Choose an indicator arrangement whose electrical state is unambiguous and document whether illumination means MUTED or LIVE. Verify the indicator cannot back-power the microphone rail.

Do not substitute a GPIO-only button, a MOSFET controlled only by firmware, or a software audio gate for the mechanical isolation.

### Verification procedure

1. With the switch in UNMUTED, confirm 3V3 reaches both microphone VDD pins and all three I2S conductors have continuity.
2. Switch to MUTED. Confirm microphone VDD is 0 V and BCLK, WS, and SD are physically open at the microphone side.
3. With MUTED selected, power-cycle the XIAO, hold it in reset, disconnect Wi-Fi, and simulate firmware crash conditions. Confirm the isolation remains open.
4. Measure the microphone-side supply and signal pins for residual voltage. Investigate any voltage that indicates back-powering.
5. Capture the XIAO I2S input and server audio stream. Confirm no microphone samples are received while muted.
6. Repeat after enclosure assembly and after mechanical switch endurance testing.

A schematic and PCB layout are not release-ready until the exact switch part number, contact arrangement, pin numbering, and physical wiring are recorded.

## 2. Power architecture: do not retain the assumed 5 V / 3 A design

The current BOM lists 70 main addressable LEDs plus 17 seam LEDs. At a conservative 60 mA per pixel full-white upper bound, 87 pixels could demand **5.22 A at 5 V (26.1 W)** before the controller, amplifier, microphones, and conversion losses. This is a theoretical pixel bound, not a measured operating load. A firmware brightness/current cap can reduce demand, but it is not a substitute for supply and wiring validation.

The existing 3 A resettable fuse and 5 V / 3 A supply assumption are not approved for the complete device. Do not simply increase the fuse rating without checking connector ratings, wire gauge, PCB copper, switch ratings, and fault protection.

Recommended design direction:

- Define a firmware LED current ceiling and a safe boot brightness before selecting the supply.
- Measure the complete assembly at maximum intended LED animation and audio output, including startup and transient peaks.
- Select a USB-C power-delivery input and regulated 5 V rail sized from those measurements with engineering headroom. If a higher-voltage PD input and buck converter are used, specify the negotiated PD profile, converter continuous/peak rating, thermal design, and protection.
- Keep the amplifier and LED return currents from flowing through sensitive microphone/controller ground paths. Use a deliberate ground and power distribution layout.
- Verify the USB-C receptacle, cable, PD sink/controller, fuse, buck converter, capacitors, PCB traces, and wire gauge as one system.
- Measure connector, converter, amplifier, LED PCB, and enclosure temperatures during a worst-case soak test.

Do not advertise a current limit, supply rating, or runtime until measurements from the assembled prototype are recorded.

## 3. Release status

The mechanical mute topology above is a concrete design proposal, but it still requires exact component selection, schematic capture, and bench verification. The power architecture remains unselected pending a measured load budget. Neither item is production-approved.
