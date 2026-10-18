import tenders from '../repositories/tender.repo.js';
import { getStorage } from '../libs/storage/index.js';
import { ZipError, listEntries, openEntry, storageSource } from '../libs/adapters/archive/zip.js';
import { invitationManifest } from '../libs/adapters/source/armeps/invitation.files.js';
import { tenderDocumentManifestSchema } from '../validations/schemas/tenderDocument.schema.js';
import { ApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * The files inside a tender's stored invitation archive: listing them once,
 * and serving one of them.
 *
 * Every file is served from OUR copy of the archive. Fetching from the source
 * on a user's click was considered and rejected: it would make a customer's
 * download a request against a site we crawl politely at 20/min, it would
 * fail exactly when the source is down or has re-issued the archive, and the
 * file served might not be the one the tender page was built from.
 *
 * A file is streamed straight out of the stored ZIP with ranged reads rather
 * than extracted to its own object at ingest. Extraction makes downloads a
 * presigned URL like the vault's, but it roughly doubles tender-docs storage
 * (2.4 GB of archives on 2026-10-18), and the archive must be kept whole
 * anyway — raw payloads are kept forever. Ranged reads cost two small storage
 * requests and stream the one entry with flat memory.
 */

/**
 * Largest single file served. Not a memory bound — the file is streamed — but
 * a work bound: the archive is capped at 60 MB on download, and the largest
 * real entry (2026-10-18) is 56 MB uncompressed, so anything far past that is
 * an entry whose header cannot be believed.
 */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;

/**
 * Where a document stands, as the tender page shows it.
 *
 *   stored      — we hold the archive and know what is in it.
 *   unlisted    — we hold the archive but its file list was never taken (the
 *                 manifest backfill has not reached it, or it could not be
 *                 read). Downloads need the list, so none are offered yet.
 *   not_stored  — the tender names an archive we do not hold: not fetched yet,
 *                 or refused (tender 48175's is over the 60 MB cap).
 *
 * `files` is null in the last two, never []: an empty list reads as "this
 * tender has no files", which is false in both.
 */
export const AVAILABILITY = { STORED: 'stored', UNLISTED: 'unlisted', NOT_STORED: 'not_stored' };

const presentFile = (file) => ({
  index: file.index,
  name: file.name,
  path: file.path,
  ext: file.ext,
  sizeBytes: file.size,
  language: file.language,
});

const asDependencyFailure = (error, action) => {
  logger.error(`[tender-docs] storage ${action} failed: ${error.message}`);
  return new ApiError('DEPENDENCY_UNAVAILABLE', { message: 'Document storage is temporarily unavailable.' });
};

export default class TenderDocumentService {
  /**
   * The validated file list of an archive, from any zip source — the buffer
   * the worker just downloaded, or ranged reads of a stored object.
   */
  static async manifestOf(source) {
    const manifest = invitationManifest(await listEntries(source));
    const { value, error } = tenderDocumentManifestSchema.validate(manifest, { abortEarly: false });
    if (error) throw new Error(`archive manifest failed validation: ${error.message}`);
    return value;
  }

  /**
   * List one already-stored archive and record it. Reads only the ZIP's tail
   * and central directory — tens of kilobytes, however large the archive —
   * and never touches the source.
   *
   * @returns {{ listed: number }|{ skipped: string }}
   */
  static async backfillManifest(row) {
    const storage = await getStorage();
    const object = await storage.head(row.storage_key);
    if (!object) return { skipped: 'object_missing' };

    const manifest = await TenderDocumentService.manifestOf(storageSource(storage, row.storage_key, object.size));
    await tenders.setDocumentManifest(row.id, manifest);
    return { listed: manifest.length };
  }

  /**
   * A tender's documents as the detail page shows them.
   *
   * A tender that names an invitation archive we never stored still gets an
   * entry — `not_stored`, with no id — so the page can say "not available"
   * instead of showing nothing, which reads as "this tender has no documents".
   */
  static present(tender) {
    const rows = tender.documents ?? [];
    const documents = rows.map((d) => {
      const listed = Array.isArray(d.manifest);
      return {
        id: d.id,
        kind: d.kind,
        url: d.url,
        parsed: d.parsed,
        availability: listed ? AVAILABILITY.STORED : AVAILABILITY.UNLISTED,
        files: listed ? d.manifest.map(presentFile) : null,
      };
    });

    if (!rows.length && tender.invitation_url) {
      documents.push({
        id: null,
        kind: 'invitation',
        url: tender.invitation_url,
        parsed: false,
        availability: AVAILABILITY.NOT_STORED,
        files: null,
      });
    }
    return documents;
  }

  /**
   * One file out of a stored archive, ready to stream.
   *
   * Everything that can refuse does so before the stream opens, so the caller
   * can still answer with a proper error envelope; after that, failure can
   * only be a truncated body.
   *
   * @returns {{ name, ext, size, stream }}
   */
  static async openFile(tenderId, documentId, index) {
    const document = await tenders.findDocument(tenderId, documentId);
    if (!document) throw ApiError.notFound('Document');

    const file = Array.isArray(document.manifest) ? document.manifest.find((f) => f.index === index) : null;
    if (!file) throw ApiError.notFound('File');

    const storage = await getStorage();
    let object;
    try {
      object = await storage.head(document.storage_key);
    } catch (error) {
      throw asDependencyFailure(error, 'head');
    }
    if (!object) {
      // A row whose object is gone is our fault, not the client's.
      throw asDependencyFailure(new Error(`no object at ${document.storage_key}`), 'head');
    }

    let stream;
    try {
      stream = await openEntry(storageSource(storage, document.storage_key, object.size), file, {
        maxBytes: MAX_FILE_BYTES,
      });
    } catch (error) {
      if (error instanceof ZipError) {
        logger.warn(`[tender-docs] ${document.id}#${index} refused: ${error.message}`);
        throw ApiError.conflict(
          error.reason === 'too_large'
            ? 'This file is too large to download here.'
            : 'This file cannot be extracted from the stored archive.',
          { reason: error.reason }
        );
      }
      throw asDependencyFailure(error, 'read');
    }

    return { name: file.name, ext: file.ext, size: file.size, stream };
  }
}
