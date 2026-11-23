# Jarvis Disc Mk I: speaker fit and retention specification

**Status: design definition only. Physical driver measurements and enclosure fit checks are outstanding. Do not release the plinth for production.**

## 1. Current interface

Selected driver: Dayton Audio CE52N-4.

| Feature | Current reference | Status |
|---|---:|---|
| Frame outside diameter | 52.0 mm | Seller/manufacturer reference; measure actual unit |
| Nominal baffle cutout | 47.5 mm | Manufacturer reference; verify actual driver |
| CAD opening | 48.0 mm | Provisional |
| Overall depth | 30.8 mm | Manufacturer reference; measure actual unit |
| Gasket | 0.5 mm closed-cell foam | Placeholder, material and compression not selected |
| Retention | None validated | Open design item |

The current SCAD opening is a 48 mm round opening. It is not a retention feature. The current concept places the driver against a gasket, but adhesive-only retention is not accepted as the final mechanical design.

## 2. Required measurement record

Measure the actual driver with calipers before changing the CAD. Record at least:

| Measurement | Record |
|---|---|
| Maximum frame/flange outside diameter, including tabs | ____ mm |
| Minimum and maximum flange thickness | ____ mm |
| Basket/body maximum diameter below flange | ____ mm |
| Overall depth from mounting face to rear-most point | ____ mm |
| Terminal block position and maximum projection | ____ mm / clock angle |
| Lead exit direction and bend clearance | ____ |
| Any genuine manufacturer fixing features | ____ |
| Cone/surround clearance to the proposed retainer | ____ mm |
| Actual cutout required by the driver | ____ mm |
| Driver mass | ____ g |

Take a straight-on photograph of the front, rear, and side with a ruler/caliper visible. Do not infer mounting holes from the nominal frame diameter.

## 3. Retention architecture to develop

Preferred direction: a removable mechanical capture system that sandwiches the measured flange against a continuous gasket/sealing land.

- Keep the speaker face-down as currently intended.
- Provide a continuous, flat gasket land around the acoustic opening.
- Capture the flange with a removable retainer ring or three independent clamp shoes. The retainer must contact only the rigid flange, never the cone, surround, suspension, terminals, or flexible basket features.
- Use three or more mechanically retained fasteners into reinforced bosses or inserts. Final count, angular positions, thread, boss dimensions, and torque must be selected after measuring the driver and checking collisions with the controller, amplifier, wiring, and enclosure wall.
- Make the retainer removable without damaging the gasket or driver.
- Add positive wire strain relief. Keep terminals and wires clear of the moving cone and all enclosure edges.
- Do not use adhesive as the only means of preventing the driver from falling out.
- Do not set gasket compression from nominal thickness alone. Select it from the gasket manufacturer's compression-deflection data and verify the assembled compression.

A ring is preferred where the flange has a continuous, usable bearing surface. Use separate clamp shoes only if the measured flange geometry makes a ring impractical. Neither option is dimensioned in CAD yet because the actual flange geometry is unknown.

## 4. CAD release gates

Before modifying `jarvis_disc.scad`:

1. Record the measurement table above for the exact purchased driver.
2. Confirm the 48 mm opening against the manufacturer's cutout recommendation and physical fit. Check the cone and surround through the full excursion range.
3. Define the gasket material, thickness, width, compression range, and sealing-land dimensions.
4. Define retainer contact surfaces and ensure no contact with moving parts.
5. Locate fasteners from measured geometry; check all three-dimensional collisions and tool access.
6. Confirm terminal, wire, board, post, and wall clearances in the assembled CAD.
7. Print a plinth/retainer fit coupon before printing the complete enclosure.
8. Install the driver, remove it, and reinstall it repeatedly. Inspect the gasket and flange for damage.
9. Perform a low-level polarity/sweep test, then a progressively louder test while checking for buzz, rub, air leaks, and retainer vibration.

## 5. Acceptance record

Record the driver part/lot, measurement date, CAD commit, print material and settings, gasket part number, retainer revision, fastener specification, and test results. The fit is accepted only when the driver seats without force, the retainer holds it securely, the gasket seals continuously, terminals and wiring clear all parts, and no mechanical noise appears during the acoustic test.

**Do not mark speaker fit or retention verified until the physical driver and printed parts have passed these checks.**
