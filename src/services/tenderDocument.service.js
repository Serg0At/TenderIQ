import tenders from '../repositories/tender.repo.js';
import { getStorage } from '../libs/storage/index.js';
import { listEntries, storageSource } from '../libs/adapters/archive/zip.js';
import { invitationManifest } from '../libs/adapters/source/armeps/invitation.files.js';
import { tenderDocumentManifestSchema } from '../validations/schemas/tenderDocument.schema.js';

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
}
