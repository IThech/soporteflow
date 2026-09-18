import fs from 'node:fs';
import path from 'node:path';

export async function applyMigrations(database, directory) {
	const journal = JSON.parse(fs.readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8'));
	if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
		throw new Error('Empty or invalid migration journal');
	}
	const tags = new Set();
	for (const [index, entry] of journal.entries.entries()) {
		if (
			entry.idx !== index ||
			typeof entry.tag !== 'string' ||
			!/^[a-zA-Z0-9_-]+$/.test(entry.tag) ||
			tags.has(entry.tag)
		) {
			throw new Error('Invalid migration order or duplicate entry');
		}
		tags.add(entry.tag);
	}
	const files = new Set(fs.readdirSync(directory).filter((file) => file.endsWith('.sql')));
	// Validate the whole manifest before executing any SQL.
	const migrations = journal.entries.map(({ tag }) => {
		const filename = tag + '.sql';
		if (!files.delete(filename)) throw new Error('Missing migration: ' + filename);
		const sql = fs.readFileSync(path.join(directory, filename), 'utf8');
		if (!sql.trim()) throw new Error('Empty migration: ' + filename);
		return { filename, sql };
	});
	if (files.size) throw new Error('Unregistered migrations: ' + [...files].join(', '));
	for (const { filename, sql } of migrations) {
		try {
			for (const statement of sql.split('--> statement-breakpoint')) {
				if (statement.trim()) await database.exec(statement);
			}
		} catch (cause) {
			throw new Error('Migration failed: ' + filename, { cause });
		}
	}
	return migrations.map(({ filename }) => filename);
}
