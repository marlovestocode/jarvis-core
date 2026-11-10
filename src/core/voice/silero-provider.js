// Loads Silero VAD lazily the first time it is wanted (config.vad === 'silero') and hands the shared
// model to every createModelVad. Missing model, missing runtime, a bad load or a run-time failure
// all log one warning and return null, so the VADs stay on the energy detector.
const { loadSilero } = require('./silero');

function createSileroProvider({ modelPath, isOn, loadOrt = () => require('onnxruntime-node'), exists = require('node:fs').existsSync, log }) {
  let model = null, loading = false, dead = false;

  function give(why) {
    if (dead) return;
    dead = true; model = null;
    log(`Silero VAD ${why}; using the energy VAD`);
  }

  function getModel() {
    if (dead || !isOn()) return null;
    if (model || loading) return model;
    loading = true;
    if (!exists(modelPath)) { give(`not installed (${modelPath})`); return null; }
    let ort;
    try { ort = loadOrt(); } catch (err) { give(`runtime onnxruntime-node failed to load: ${err.message}`); return null; }
    loadSilero({ modelPath, ort }).then(m => { if (!dead) { model = m; log('Silero VAD loaded'); } }, err => give(`failed to load: ${err.message}`)).finally(() => { loading = false; });
    return null;
  }

  return { getModel, onError: err => give(`failed while running: ${err.message}`) };
}

module.exports = { createSileroProvider };
