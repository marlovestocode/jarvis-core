# Jarvis Disc Mk I: thermal and acoustic validation protocol

**Status: pending physical prototype. No thermal, SPL, frequency-response, distortion, or acoustic performance claims are verified.**

## 1. Thermal validation

### Instrumentation and setup

Use calibrated thermocouples or contact probes at minimum on:

- USB-C/PD input connector and cable termination;
- DC/DC converter package and nearby PCB;
- LED PCB at the highest-density/highest-dissipation area;
- MAX98357A amplifier package and nearby PCB;
- XIAO ESP32-S3 module;
- enclosure interior air near the warmest electronics;
- exterior enclosure surface at the warmest expected touch point.

Record ambient temperature, enclosure orientation, supply voltage, firmware commit, LED brightness cap, audio level, network activity, instrument accuracy, and probe attachment method. IR readings on reflective metal or glossy plastic require emissivity correction and should not replace contact measurements for release evidence.

### Test sequence

1. Record ambient and all component temperatures after at least 10 minutes powered off.
2. Run idle/network-connected operation until temperatures stabilize.
3. Run maximum intended LED animation and maximum intended audio output separately.
4. Run the combined worst-case operating condition identified by the power test.
5. Continue the combined test until temperatures stabilize or the planned soak duration is reached. Record temperatures at fixed intervals.
6. Repeat at the highest specified ambient operating temperature.
7. Repeat after enclosure assembly; an open-bench result does not validate the enclosed device.
8. Inspect for discoloration, deformation, adhesive/gasket softening, connector heating, resets, thermal throttling, and intermittent behavior.

### Thermal pass criteria

For every component, connector, wire, PCB, adhesive, and enclosure material:

- measured temperature remains below its manufacturer's rated limit with the required design derating;
- enclosure touch temperature meets the product's chosen safety/comfort requirement;
- no thermal shutdown, brownout, instability, deformation, odor, or damage occurs;
- temperatures reach a stable plateau during the defined soak test.

Set the exact limits from the selected parts' datasheets and material ratings before testing. Do not invent a universal acceptable temperature.

## 2. Acoustic validation

### Mechanical checks

Before high-level playback, inspect driver seating, gasket continuity, wire routing, terminal clearance, retainer security, and enclosure sealing. Confirm the cone and surround move freely and do not contact the retainer or opening.

### Measurement setup

Use a calibrated measurement microphone/SPL meter and a repeatable fixture. Record microphone model/calibration, distance, axis, room/environment, test signal, amplifier gain, supply voltage, and firmware DSP settings. Use the same setup for every revision.

### Test sequence

1. Low-level polarity and channel check.
2. Low-level logarithmic sweep across the intended passband; inspect for rattles, rubbing, leaks, and resonances.
3. Measure frequency response at a fixed distance and axis.
4. Measure SPL at the intended maximum user volume and record the amplifier input/output conditions.
5. Measure distortion at several levels across the intended passband. Do not exceed the driver's rated excursion or power limits.
6. Run speech and representative music playback; inspect for enclosure buzz, port/leak noise, harshness, clipping, and audible artifacts.
7. Test microphone capture while the speaker plays. Measure echo pickup and confirm the chosen echo-cancellation/noise-processing path behaves as intended.
8. Repeat with the enclosure closed and all production-intent seals, feet, and panels installed.

The driver has a published Xmax of 0.85 mm in the current design notes. Use a conservative high-pass filter and controlled level during early testing; verify actual excursion and distortion rather than assuming firmware settings guarantee safety.

### Acoustic pass criteria

Set the product targets before testing: minimum/maximum SPL at the listening position, usable frequency range, allowable response variation, distortion ceiling, and acceptable echo performance. A revision passes only if it meets those recorded targets without rub, buzz, air leaks, rattles, clipping, or mechanical interference at the intended maximum level.

## 3. Evidence package

For each run, preserve raw measurement files, plots, instrument calibration details, test environment, component/firmware/CAD revisions, photographs of probe placement, and a concise pass/fail record. Link the evidence from `MANUFACTURING_READINESS.md`.

**A successful CAD build or open-bench test does not establish enclosed-device thermal or acoustic performance.**
