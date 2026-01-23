
const { Database } = require('bun:sqlite');
const db = new Database(':memory:');

// Create tables
db.exec(`
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  subject TEXT,
  status TEXT DEFAULT 'pending',
  domain TEXT,
  assigned_to TEXT,
  consensus_status TEXT DEFAULT 'pending'
);

CREATE TABLE arms (
  id TEXT PRIMARY KEY,
  name TEXT,
  domain TEXT,
  status TEXT DEFAULT 'idle'
);

CREATE TABLE task_arm_consensus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  arm_id TEXT,
  role TEXT,
  status TEXT DEFAULT 'pending'
);

CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Insert config
db.run('INSERT INTO config (key, value) VALUES (?, ?)', ['max_arms_per_task', '3']);

// Insert test data
db.run('INSERT INTO tasks (id, subject, domain) VALUES (?, ?, ?)', ['test-task', 'Test Task', 'backend']);
db.run('INSERT INTO arms (id, name, domain, status) VALUES (?, ?, ?, ?)', ['arm1', 'Arm 1', 'backend', 'idle']);
db.run('INSERT INTO arms (id, name, domain, status) VALUES (?, ?, ?, ?)', ['arm2', 'Arm 2', 'general', 'idle']);
db.run('INSERT INTO arms (id, name, domain, status) VALUES (?, ?, ?, ?)', ['arm3', 'Arm 3', 'frontend', 'idle']);

console.log('Test data inserted successfully');
