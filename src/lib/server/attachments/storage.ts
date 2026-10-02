import { mkdir, open, realpath, unlink, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { AttachmentError } from './validation.ts';
export interface AttachmentStorage {
	put(key: string, bytes: Uint8Array): Promise<void>;
	read(key: string): Promise<Uint8Array>;
	removeFailedUpload(key: string): Promise<void>;
}
/** Explicit private DEV volume; no I/O at import. Never use a directory served by a web server. */
export function localAttachmentStorage(
	root: string,
	repository = process.cwd()
): AttachmentStorage {
	const absolute = path.resolve(root);
	const relative = path.relative(path.resolve(repository), absolute);
	if (
		!path.isAbsolute(root) ||
		!relative ||
		(!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
	)
		throw new AttachmentError(503, 'STORAGE_NOT_CONFIGURED');
	async function filename(key: string) {
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key))
			throw new AttachmentError(400, 'INVALID_STORAGE_KEY');
		await mkdir(absolute, { recursive: true, mode: 0o700 });
		if ((await lstat(absolute)).isSymbolicLink() || (await realpath(absolute)) !== absolute)
			throw new AttachmentError(503, 'UNSAFE_STORAGE_ROOT');
		return path.join(absolute, key);
	}
	return {
		async put(key, bytes) {
			const f = await open(
				await filename(key),
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600
			);
			try {
				await f.writeFile(bytes);
				await f.sync();
			} finally {
				await f.close();
			}
		},
		async read(key) {
			const name = await filename(key);
			if ((await lstat(name)).isSymbolicLink())
				throw new AttachmentError(503, 'UNSAFE_STORAGE_FILE');
			const f = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const stat = await f.stat();
				if (!stat.isFile() || stat.size > 5242880)
					throw new AttachmentError(503, 'INVALID_STORAGE_FILE');
				return await f.readFile();
			} finally {
				await f.close();
			}
		},
		async removeFailedUpload(key) {
			await unlink(await filename(key)).catch((e) => {
				if (e.code !== 'ENOENT') throw e;
			});
		}
	};
}
