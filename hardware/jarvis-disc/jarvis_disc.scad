// Jarvis Disc, Mk I: parametric enclosure. All units are millimetres.
// Front of the device is +Y. Table is z = 0. Base design height 36.8 + lift = 53.3, diameter 139.
// lift: the plinth is taller by this much so the 30.8 mm deep Dayton CE52N-4 fits (sealed chamber, about 0.2 L).
//
// Render one printable part (print orientation) from the command line:
//   openscad -D 'part="plinth"' -o stl/01_plinth.stl jarvis_disc.scad
// part = "plinth" | "sleeve" | "body" | "baffle" | "bezel" | "assembly"
//
// Chosen parts (sizes from the sellers' listings, see README):
//   speaker  Dayton Audio CE52N-4, 2 inch full range, 4 ohm: frame 52, depth 30.8, nominal baffle cutout 47.5. Retention is not yet validated.
//   amp      Adafruit I2S 3W Class D Amp Breakout MAX98357A, product 3006: 19.4 x 17.8 x 3.0
//   mics     2 x INMP441 breakout, about 14 x 14 x 3 (third-party listing, check yours)
// Still a custom/placeholder size: the LED PCB (positions in led_layout.csv).

part = "assembly";
lift = 16.5;   // extra plinth height, see header
$fn = 120;

// ---- Z stack (table = 0) -------------------------------------------------
foot_h     = 3;      // adhesive rubber feet under the plinth
plinth_top = 15;     // top of the plinth shoulder (light band starts here)
neck_top   = 22.5;   // top of the neck; body starts here (band is 7.5 tall)
body_bot   = 22.5;
floor_top  = 24.5;   // inside floor of the body (2 mm)
pcb_bot    = 28.9;   // LED PCB underside (1.6 mm board); mic modules sit under it
pcb_top    = 30.5;
baf_top    = 32.5;   // baffle 2 mm
dif_top    = 33.5;   // diffuser sheet 1 mm
acr_top    = 35.5;   // smoked acrylic 2 mm
top_z      = 36.8;   // top of the bezel

// ---- speaker: Dayton Audio CE52N-4, mounted face down --------------------------
spk_l = 52; spk_w = 52; spk_d = 30.8;     // CE52N-4 frame diameter and depth
cut_l = 46;  cut_w = 46;                  // sound opening in the plinth floor (round)
plpost_r = 38;                            // M3 post circle

// ---- radii ----------------------------------------------------------------
plinth_r   = 52;
neck_r     = 46;     // LED strip wraps this, LEDs facing outward
neck_in_r  = 43.6;
body_r     = 69.5;
cav_r      = 62.2;   // stack (acrylic, diffuser, baffle, PCB) is 124 mm dia

// ---- LED layout (matches the 3D concept): rings of 12 / 24 / 36 ---------
ring_r = [17, 35, 54];
ring_n = [12, 24, 36];
mic_r  = 44.5;       // mic port ring (between ring 2 and ring 3)
post_r = 59;         // LED PCB posts
body_posts = [0, 135, 225];   // M3 posts plinth -> body, angles from the front (clear of the speaker)
pad_angles = [45, 315, 180];  // board standoff pads at r = 34, 4 mm tall so the boards clear the driver flange

function pol(r, a) = [r * sin(a), r * cos(a)];   // a = 0 is the front (+Y)

module leds2d(d) {
  for (k = [0 : 2]) for (i = [0 : ring_n[k] - 1]) {
    a = i * 360 / ring_n[k];
    // outer ring skips the pixels beside the front notch
    skip = (k == 2) && (min(a, 360 - a) < 11.5);
    if (!skip) translate(pol(ring_r[k], a)) circle(d = d, $fn = 24);
  }
  translate(pol(59.5, 0)) circle(d = d, $fn = 24);   // front marker LED
}

module slot2d(l, w) {
  hull() { translate([-(l - w) / 2, 0]) circle(d = w, $fn = 40); translate([(l - w) / 2, 0]) circle(d = w, $fn = 40); }
}

// ---- 1. plinth --------------------------------------------------------------
module plinth() {
  difference() {
    union() {
      rotate_extrude()
        polygon([[0,3],[50,3],[52,5],[52,15+lift],[46,15+lift],[46,22.5+lift],[43.6,22.5+lift],[43.6,13+lift],[49.6,13+lift],[49.6,5],[0,5]]);
      // three posts that carry the body (M3 heat-set or self-tap)
      for (a = body_posts) translate([pol(plpost_r, a)[0], pol(plpost_r, a)[1], 5]) cylinder(d = 8, h = 17.5 + lift, $fn = 40);
      // standoff pads for the controller and amp boards (M2 holes)
      for (a = pad_angles) translate([pol(34, a)[0], pol(34, a)[1], 5]) cylinder(d = 6, h = 4, $fn = 30);
    }
    // sound opening for the down-firing speaker (it rests on the floor, glued on a foam gasket)
    translate([0, 0, 2]) linear_extrude(4) slot2d(cut_l, cut_w);
    // post screw holes
    for (a = body_posts) translate([pol(plpost_r, a)[0], pol(plpost_r, a)[1], 9]) cylinder(d = 2.9, h = 14 + lift, $fn = 24);
    // board pad screw holes
    for (a = pad_angles) translate([pol(34, a)[0], pol(34, a)[1], 5.5]) cylinder(d = 1.8, h = 3.5, $fn = 20);
    // USB-C slot, rear (-Y)
    translate([-6, -plinth_r - 1, 6.5]) cube([12, 6, 5]);
    // mic-mute button hole, rear left
    translate([pol(plinth_r - 2, 215)[0], pol(plinth_r - 2, 215)[1], 9]) rotate([0, 0, -215]) rotate([-90, 0, 0]) cylinder(d = 6.2, h = 6, $fn = 30);
    // foot recesses underneath
    for (a = [45, 135, 225, 315]) translate([pol(40, a)[0], pol(40, a)[1], 2.9]) cylinder(d = 10.4, h = 0.9, $fn = 40);
  }
}

// ---- 2. diffuser sleeve (print in natural / white translucent PETG) ---------
module sleeve() {
  translate([0, 0, 15 + lift]) difference() {
    cylinder(r = 49.6, h = 7.5);
    translate([0, 0, -0.1]) cylinder(r = 48.2, h = 7.7);
  }
}

// ---- 3. upper body ------------------------------------------------------------
module slots() {
  // decorative grille, 1.6 wide x 2 deep, leaving the front nameplate smooth
  for (a = [0 : 3.6 : 359]) {
    off = (a > 180) ? a - 360 : a;
    if (!(off > -34 && off < 36)) {
      rotate([0, 0, -a]) translate([-0.8, body_r - 2, 25.5]) cube([1.6, 3, 5.5]);
    }
  }
}

module engrave(txt, sz, ph, zc, pitch, bold = true) {
  n = len(txt);
  for (i = [0 : n - 1]) {
    c = txt[i];
    if (c != " ") {
      // a is measured from the front toward +X (the viewer's left), so reading
      // left-to-right means a decreasing
      a = ph - (i - (n - 1) / 2) * (pitch / body_r * 180 / PI);
      rotate([0, 0, -a]) translate([0, body_r - 0.6, zc]) rotate([90, 0, 180])
        linear_extrude(2) text(c, size = sz, halign = "center", valign = "baseline", $fn = 16,
                               font = bold ? "Liberation Sans:style=Bold" : "Liberation Sans");
    }
  }
}

module body() {
  difference() {
    union() {
      rotate_extrude()
        polygon([[0,22.5],[67.5,22.5],[69.5,24.5],[69.5,31.9],[68.3,31.9],[68.3,32.5],[66.3,34.3],[64,35.5],[62.2,35.5],[62.2,24.5],[0,24.5]]);
      // LED PCB posts
      for (k = [0 : 5]) translate([pol(post_r, k * 60)[0], pol(post_r, k * 60)[1], floor_top - 0.1]) cylinder(d = 6, h = pcb_bot - floor_top + 0.1, $fn = 30);
    }
    // post screw holes (M2)
    for (k = [0 : 5]) translate([pol(post_r, k * 60)[0], pol(post_r, k * 60)[1], pcb_bot - 4]) cylinder(d = 1.8, h = 4.5, $fn = 20);
    // cable hole in the floor
    translate([0, 0, 21.5]) cylinder(d = 24, h = 6);
    // M3 clearance + countersink for the three plinth posts
    for (a = body_posts) translate([pol(plpost_r, a)[0], pol(plpost_r, a)[1], 21.5]) {
      cylinder(d = 3.4, h = 6, $fn = 24);
      translate([0, 0, 2.4]) cylinder(d1 = 3.4, d2 = 6.6, h = 1.8, $fn = 24);
    }
    slots();
    // nameplate engraving, 0.6 deep
    engrave("JARVIS", 3.8, 16, 27.8, 5.2);
    engrave("NODE 001", 1.8, 16, 25.6, 2.4, false);
    engrave("MK I", 3.8, -21, 27.8, 4.6);
  }
}

// ---- 4. LED baffle plate ----------------------------------------------------------
module baffle() {
  linear_extrude(2) difference() {
    circle(r = 61.8);
    leds2d(4.2);
    for (a = [45, 135, 225, 315]) translate(pol(mic_r, a)) circle(d = 2.2, $fn = 20);   // mic ports
    for (k = [0 : 5]) translate(pol(post_r, k * 60)) circle(d = 4.6, $fn = 24);          // PCB screw heads
  }
}

// ---- 5. gold bezel (print upside down, or CNC aluminium + gold anodise) ----------
module bezel() {
  rotate_extrude()
    polygon([[61.2,35.5],[64,35.5],[66.3,34.3],[68.3,32.5],[68.3,31.9],[69.5,31.9],[69.5,33.4],[67.1,35.2],[64.8,36.8],[61.2,36.8]]);
}

// ---- reference solids (not printed): shown only in the assembly preview ----------
module acrylic() { translate([0, 0, 33.5]) color([0.04, 0.05, 0.07, 0.6]) cylinder(r = 62, h = 2); }
module diffuser() { translate([0, 0, 32.5]) color([1, 1, 1, 0.5]) cylinder(r = 61.8, h = 1); }
module speaker() { color("#6b7380") translate([0, 0, 5.5]) cylinder(d = spk_l, h = spk_d); }

if (part == "plinth") translate([0, 0, -3]) plinth();
else if (part == "sleeve") translate([0, 0, -15 - lift]) sleeve();
else if (part == "body") translate([0, 0, -22.5]) body();
else if (part == "baffle") baffle();
else if (part == "bezel") translate([0, 0, 36.8]) rotate([180, 0, 0]) bezel();
else if (part == "speaker") speaker();
else {
  color("#222a33") plinth();
  color("#d8d8c8", 0.6) sleeve();
  translate([0, 0, lift]) {
    color("#161b22") body();
    color("#0a0a0a") translate([0, 0, 30.5]) baffle();
    diffuser();
    acrylic();
    color("#9a7b4a") bezel();
  }
}
