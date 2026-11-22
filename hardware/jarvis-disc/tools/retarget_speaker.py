# One-off: updates the drawing scripts for the Adafruit 3351 speaker (taller neck, 36.8 mm total).
import os
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

def edit(path, pairs):
    s = open(path, encoding='utf8').read()
    for old, new in pairs:
        assert old in s, (path, old[:90])
        s = s.replace(old, new)
    open(path, 'w', encoding='utf8').write(s)

edit('tools/make-technical.js', [
    ("const X = x => cx + x * S, Z = z => yb - z * S;",
     "const X = x => cx + x * S, Z = z => yb - (z >= 21 ? z + 1.5 : z) * S, Zr = z => yb - z * S;   // above z 21 the neck is 1.5 taller"),
    ("  const sym = (x0, z0, x1, z1, fill, o = {}) =>",
     "  const rectR = (x0, z0, x1, z1, fill, o = {}) => `<rect x=\"${f(X(x0))}\" y=\"${f(Zr(z1))}\" width=\"${f((x1 - x0) * S)}\" height=\"${f((z1 - z0) * S)}\" fill=\"${fill}\" stroke=\"${o.stroke || '#06080b'}\" stroke-width=\"${o.sw || 1}\"/>\\n`;\n  const sym = (x0, z0, x1, z1, fill, o = {}) =>"),
    ("poly([[23, 3], [50, 3], [52, 5], [52, 15], [46, 15], [46, 21], [43.6, 21], [43.6, 13], [49.6, 13], [49.6, 5], [23, 5]]",
     "poly([[31.5, 3], [50, 3], [52, 5], [52, 15], [46, 15], [46, 21], [43.6, 21], [43.6, 13], [49.6, 13], [49.6, 5], [31.5, 5]]"),
    ("sym(34, 5, 42, 21,", "sym(22.9, 5, 30.9, 21,"),
    ("rect(-28.5, 5, 28.5, 6.5, '#8591a0') + rect(-25, 6.5, 25, 9, '#5d6877') + rect(-17, 9, 17, 11, '#5d6877') + rect(-12, 11, 12, 15, '#3a4452')",
     "rectR(-35, 5, 35, 22, '#6b7380')"),
    ("b += rect(-22, 5.2, 22, 7.2, '#c9c2a8', { sw: 0.6 });",
     "for (let gx = -29; gx <= 29; gx += 4) b += rectR(gx - 0.8, 5.3, gx + 0.8, 8.5, '#2a3038', { sw: 0.4 });"),
    ("rect(-48, 5, -31, 7.2, '#2b6a4a') + rect(-45, 7.2, -35, 9.6, '#1c1f24') + rect(31, 5, 48, 7.2, '#2b6a4a') + rect(34, 7.2, 42, 9, '#1c1f24')",
     "sym(36.5, 5, 48.5, 9, '#17261e', { stroke: '#46525f', dash: '3 3' })"),
    ("vdim(15, 21, X(-69.5) - 130, '6 light band')", "vdim(15, 21, X(-69.5) - 130, '7.5 light band')"),
    ("vdim(0, 35.3, X(-69.5) - 250, '35.3 overall')", "vdim(0, 35.3, X(-69.5) - 250, '36.8 overall')"),
    ("['6', 'Mic board', '4 mic ports up to the window (blue dashes)']", "['6', 'Mic modules', '2 x INMP441, ports up to the window (blue dashes)']"),
    ("['11', 'Speaker', 'About 57 mm full-range driver, faces down, max 10 mm deep']", "['11', 'Speaker', 'Adafruit 3351: 3 W, 4 ohm, 70 x 30 x 17, faces down']"),
    ("['12', 'Controller + amp', 'ESP32-S3 board and I2S amplifier']", "['12', 'Controller + amp', 'XIAO ESP32-S3 + Adafruit 3006 amp, in front of / behind the speaker']"),
    ("[6, 'Mic board', 41, 3, '#2b6a4a']", "[6, 'Mic modules', 41, 3, '#2b6a4a']"),
    ("'Frosted sleeve (stl/02) over a 5-6 mm LED strip'", "'Frosted sleeve (stl/02) over a 5 mm LED strip, 7.5 tall'"),
    ("'Printed (stl/01): speaker shelf, board bay, USB-C slot'", "'Printed (stl/01): speaker opening, board bay, USB-C slot'"),
    ("'6 x M2, hold the LED PCB'", "'6 x M2, hold the LED PCB'"),
    ("'3 x posts join body to plinth (ghosted, off the cut plane)'", "'3 x posts join body to plinth (ghosted, off the cut plane)'"),
    ("'Speaker', ['about 57 mm, 4 ohm, 3 W', 'down-firing']", "'Speaker: Adafruit 3351', ['4 ohm, 3 W, 70 x 30 x 17 mm', 'enclosed, faces down']"),
    ("'MAX98357A amp'", "'Adafruit 3006: MAX98357A amp'"),
    ("box(1700, 360, 230, 110,", "box(1700, 360, 260, 110,"),
])
edit('tools/make-drawings.js', [
    ("const Y = z => yb - z * s * zc;", "const Y = z => yb - (z >= 21 ? z + 1.5 : z) * s * zc;   // the neck is 1.5 taller above z 21"),
    ("Ø139 × 35.3 mm", "Ø139 × 36.8 mm"),
])
print('ok')
