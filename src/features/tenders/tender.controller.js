import TenderService from './tender.service.js';
import { pipeline } from 'stream';
import { ok, paginated } from '../../utils/respond.js';
import { contentDisposition, contentTypeOf } from '../../utils/download.js';
import { logger } from '../../utils/logger.js';

export default class TenderController {
  static async list(req, res) {
    const { rows, cursor, hasMore } = await TenderService.search(req.query);
    return paginated(res, rows, { cursor, hasMore });
  }

  static async relevant(req, res) {
    const { rows, meta } = await TenderService.relevant(req.user.organizationId, req.query);
    return ok(res, rows, meta);
  }

  static async detail(req, res) {
    return ok(res, await TenderService.detail(req.params.id));
  }

  /**
   * A file, not an envelope: this is the one response under /tenders whose
   * body is bytes. Every refusal happens inside the service, before a header
   * is sent, so those still answer in the `{ error }` shape. Past this point a
   * failure can only cut the body short; the declared Content-Length is what
   * lets the client notice.
   */
  static async documentFile(req, res) {
    const { id, documentId, index } = req.params;
    const file = await TenderService.documentFile(id, documentId, index);

    res.set({
      'Content-Type': contentTypeOf(file.ext),
      'Content-Length': String(file.size),
      'Content-Disposition': contentDisposition(file.name),
      // The archive at a content-hash key never changes, but the file is
      // behind authentication: private, so no shared cache keeps a copy.
      'Cache-Control': 'private, max-age=3600',
    });
    pipeline(file.stream, res, (error) => {
      if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        logger.error(`[tender-docs] ${documentId}#${index} failed mid-stream: ${error.message}`);
      }
    });
  }
}
