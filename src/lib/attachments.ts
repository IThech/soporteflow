/** Shared technical limits; the server always validates the actual bytes independently. */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 5;
export const ATTACHMENT_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp';
export const ATTACHMENT_TYPES = {
	pdf: 'application/pdf',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp'
} as const;
export interface IncidentAttachment {
	id: string;
	originalName: string;
	mimeType: string;
	size: number;
	createdAt: string;
}
export function attachmentFileError(file: {
	name: string;
	size: number;
	type: string;
}): string | null {
	if (
		!file.name ||
		file.name.length > 180 ||
		/[\\/]/.test(file.name) ||
		Array.from(file.name).some(
			(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
		) ||
		file.name.includes('..')
	)
		return 'El nombre del archivo no es válido.';
	const extension = file.name.split('.').at(-1)?.toLowerCase();
	const mime = ATTACHMENT_TYPES[extension as keyof typeof ATTACHMENT_TYPES];
	if (!mime || file.type !== mime) return 'Solo se admiten PDF, JPG/JPEG, PNG y WebP.';
	if (file.size <= 0 || file.size > ATTACHMENT_MAX_BYTES)
		return 'El archivo debe ocupar entre 1 byte y 5 MB.';
	return null;
}
