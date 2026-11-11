// 001: every table of core spec §4.1.
module.exports = {
  version: 1,
  name: 'schema',
  up(raw) {
    raw.exec(`
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);

      CREATE TABLE source(
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('user','tool','import','wiki','web','model')),
        trust INTEGER NOT NULL,
        ref TEXT, title TEXT, at INTEGER NOT NULL);

      CREATE TABLE node(
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL, key TEXT, text TEXT NOT NULL, data TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','pending','archived')),
        importance REAL NOT NULL DEFAULT 0.5,
        confidence INTEGER NOT NULL DEFAULT 0,
        uses INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL, updated INTEGER NOT NULL, last_used INTEGER,
        UNIQUE(kind, key));
      CREATE INDEX node_kind_status_used ON node(kind, status, last_used);

      CREATE TABLE provenance(
        node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
        source_id INTEGER NOT NULL REFERENCES source(id),
        at INTEGER NOT NULL, quote TEXT,
        PRIMARY KEY(node_id, source_id));

      CREATE TABLE edge(
        src INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
        dst INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
        type TEXT NOT NULL, weight REAL NOT NULL,
        uses INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, last_used INTEGER NOT NULL,
        PRIMARY KEY(src, dst, type)) WITHOUT ROWID;
      CREATE INDEX edge_dst ON edge(dst, type);

      CREATE TABLE vec(
        node_id INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
        dim INTEGER NOT NULL, scale REAL NOT NULL, v BLOB NOT NULL,
        model TEXT);   -- embed model that made it; a different current model = stale (spec §6.2)

      CREATE TABLE event(
        id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL,
        node_id INTEGER REFERENCES node(id) ON DELETE SET NULL,
        payload TEXT);
      CREATE INDEX event_kind_at ON event(kind, at);
      CREATE INDEX event_node_at ON event(node_id, at);

      CREATE VIRTUAL TABLE node_fts USING fts5(text, tokenize='porter unicode61 remove_diacritics 2', content='node', content_rowid='id');
      CREATE TRIGGER node_ai AFTER INSERT ON node BEGIN
        INSERT INTO node_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER node_ad AFTER DELETE ON node BEGIN
        INSERT INTO node_fts(node_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER node_au AFTER UPDATE OF text ON node BEGIN
        INSERT INTO node_fts(node_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO node_fts(rowid, text) VALUES (new.id, new.text);
      END;
    `);
  },
};
