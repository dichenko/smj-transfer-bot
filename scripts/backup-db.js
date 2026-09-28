import { backup, DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const sourcePath = process.env.DATABASE_PATH ?? './data/bridge.sqlite';
const destination = process.argv[2] ?? join(dirname(sourcePath), 'backups',
  `bridge-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
if (!existsSync(sourcePath)) throw new Error(`Database does not exist: ${sourcePath}`);
if (resolve(destination) === resolve(sourcePath) || existsSync(destination))
  throw new Error(`Backup destination already exists: ${destination}`);
mkdirSync(dirname(destination), { recursive: true });
const source = new DatabaseSync(sourcePath);
try {
  await backup(source, destination);
} finally { source.close(); }
const copy = new DatabaseSync(destination);
try {
  const result = copy.prepare('PRAGMA integrity_check').get();
  if (Object.values(result)[0] !== 'ok') throw new Error(`Backup integrity check failed: ${JSON.stringify(result)}`);
} finally { copy.close(); }
console.log(`SQLite backup verified: ${destination}`);
