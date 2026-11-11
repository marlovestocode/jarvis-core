// Helpers for skill group files.
// own(tool, aliases, extra): the tool, plus the wrong names the model has used for it
// (and optional extra fields such as { untrusted: true }).
function own(tool, aliases = [], extra = {}) {
  return { ...tool, ...extra, aliases };
}

module.exports = { own };
