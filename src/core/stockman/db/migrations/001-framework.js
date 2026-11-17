// 001: the only tables the framework itself needs. Feature tables (bars, trades, ...) are NOT here: each feature adds its own migration.
//   meta          : key/value facts about this database (when it was made, which framework build wrote it). Small, rarely written.
//   engine_event  : append-only log of what the framework did and what failed (vault note 07 names this table). One place to look
//                   when something is wrong, and what later stages read for data_quality. Times are ms since the epoch (the cortex convention).
// Changing a shipped migration is forbidden: add a new one with the next version number.
module.exports = {
  version: 1,
  name: 'framework',
  up(raw) {
    raw.exec(`
      CREATE TABLE meta(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated INTEGER NOT NULL);

      CREATE TABLE engine_event(
        id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        level TEXT NOT NULL CHECK(level IN ('debug','info','warn','error')),
        source TEXT NOT NULL,
        message TEXT NOT NULL,
        data TEXT);
      CREATE INDEX engine_event_at ON engine_event(at);
      CREATE INDEX engine_event_source_at ON engine_event(source, at);
    `);
  },
};
