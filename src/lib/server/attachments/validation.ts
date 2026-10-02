import { attachmentFileError } from '../../attachments.ts';
export class AttachmentError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string) {
		super(code);
		this.status = status;
		this.code = code;
	}
}
/** Checks format framing, not malware safety. Downloads are never rendered inline. */
export function validateAttachment(
	file: { name: string; type: string; size: number },
	bytes: Uint8Array
): void {
	if (file.size > 5242880 || bytes.length > 5242880)
		throw new AttachmentError(413, 'PAYLOAD_TOO_LARGE');
	if (attachmentFileError(file) || bytes.length !== file.size)
		throw new AttachmentError(400, 'INVALID_FILE');
	const b = Buffer.from(bytes);
	let valid = false;
	if (file.type === 'application/pdf') {
		valid =
			/^(%PDF-1\.[0-7]|%PDF-2\.0)/.test(b.subarray(0, 8).toString('ascii')) &&
			/%%EOF\s*$/.test(b.subarray(-1024).toString('ascii')) &&
			(b.includes(Buffer.from('trailer')) || /\/Type\s*\/XRef/.test(b.toString('ascii')));
	} else if (file.type === 'image/png') {
		valid =
			b.length >= 45 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		let p = 8;
		let image = false;
		let end = false;
		while (valid && p + 12 <= b.length) {
			const size = b.readUInt32BE(p);
			const kind = b.subarray(p + 4, p + 8).toString('ascii');
			if (size > b.length - p - 12 || (p === 8 && (kind !== 'IHDR' || size !== 13))) {
				valid = false;
				break;
			}
			if (p === 8 && (!b.readUInt32BE(p + 8) || !b.readUInt32BE(p + 12))) valid = false;
			if (kind === 'IDAT' && size > 0) image = true;
			p += 12 + size;
			if (kind === 'IEND') {
				end = size === 0 && p === b.length;
				break;
			}
		}
		valid = valid && image && end;
	} else if (file.type === 'image/jpeg') {
		valid = b.length > 16 && b[0] === 255 && b[1] === 216 && b.at(-2) === 255 && b.at(-1) === 217;
		let p = 2;
		let frame = false;
		let scan = false;
		while (valid && p + 4 < b.length) {
			if (b[p++] !== 255) {
				valid = false;
				break;
			}
			while (b[p] === 255) p++;
			const marker = b[p++];
			if (p + 2 > b.length) {
				valid = false;
				break;
			}
			if (marker === 218) {
				const scanSize = b.readUInt16BE(p);
				scan = scanSize >= 6 && p + scanSize < b.length - 2;
				break;
			}
			const size = b.readUInt16BE(p);
			if (size < 2 || p + size > b.length) {
				valid = false;
				break;
			}
			if (
				[192, 193, 194].includes(marker) &&
				size >= 8 &&
				b.readUInt16BE(p + 3) &&
				b.readUInt16BE(p + 5)
			)
				frame = true;
			p += size;
		}
		valid = valid && frame && scan;
	} else if (file.type === 'image/webp') {
		valid =
			b.length >= 26 &&
			b.subarray(0, 4).toString() === 'RIFF' &&
			b.readUInt32LE(4) + 8 === b.length &&
			b.subarray(8, 12).toString() === 'WEBP';
		let p = 12;
		let image = false;
		while (valid && p + 8 <= b.length) {
			const kind = b.subarray(p, p + 4).toString();
			const size = b.readUInt32LE(p + 4);
			if (size > b.length - p - 8) {
				valid = false;
				break;
			}
			if (kind === 'VP8 ' && size >= 10)
				image = b.subarray(p + 11, p + 14).equals(Buffer.from([157, 1, 42]));
			if (kind === 'VP8L' && size >= 5) image = b[p + 8] === 47;
			p += 8 + size + (size % 2);
		}
		valid = valid && image && p === b.length;
	}
	if (!valid) throw new AttachmentError(400, 'INVALID_FILE_CONTENT');
}
