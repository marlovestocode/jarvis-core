// Framework migrations, in order; each { version, name, up(raw) }. PRAGMA user_version holds the last one applied
// (the same mechanism as src/core/cortex/migrations). Features pass their own list to openStockmanDb: see db/index.js.
module.exports = [
  require('./001-framework'),
];
