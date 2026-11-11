// Migrations in order; each { version, name, up(raw) }. PRAGMA user_version tracks the last one applied.
module.exports = [
  require('./001-schema'),
];
