# Skill groups: manual checklist

Everything here needs a person at the real PC. Nothing below was run by the implementation work: the code
is covered by fake-host tests only, and the PowerShell host was only checked to compile and answer the
read-only commands (`ping`, `monitors`, `foreground`, `windows`). Start JARVIS normally (`npm start`), voice on.

## Windows
- [ ] "Snap Chrome to the left half" / "right half" → the window fills exactly that half of its monitor; the reply says it snapped only after.
- [ ] Each layout by voice: top left, top right, bottom left, bottom right, maximize, minimize, restore, center.
- [ ] "Maximize this window" with no name → the window that was in front (not JARVIS's own chat window) is maximized.
- [ ] With two monitors: "move Chrome to monitor 2", "move Chrome to the next monitor" (wraps to 1), "monitor 3" → answers that it does not exist and lists the monitors.
- [ ] Virtual desktops: "switch to the next desktop" / "previous desktop" → Windows really changes desktop and the reply says so only after. With a single desktop the reply must say it stayed (or that desktops are unavailable), never "Switched".
- [ ] "Switch to desktop 2" and "move Notepad to desktop 2" → both answer that this is not possible here (the PC host does not read the desktop list from the registry); nothing moves. Decide later whether to allow a read-only registry read for this.
- [ ] Hung app: freeze a test app on purpose (for example a PowerShell window running `Add-Type -A System.Windows.Forms; $f=New-Object Windows.Forms.Form; $f.Show(); Start-Sleep 600`), then "the test app is not responding, end it" → asks → "yes" → only that process ends. A healthy app named the same way → refused ("Windows does not report ... as not responding").
- [ ] "End explorer" while it is frozen (or not) → refused as protected.
