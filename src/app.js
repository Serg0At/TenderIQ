import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import Api from './features/index.js';
import config from './configs/variables.config.js';
import { rateLimit } from './middlewares/rateLimit.js';
import { notFoundHandler, errorHandler } from './middlewares/error.js';

class App {
  constructor() {
    this.app = express();
  }

  init() {
    this._setSecurity();
    this._setRequestParser();
    this._initializeApi();
    // Registered last, and in this order: Express selects an error handler by
    // its arity, so anything mounted after it would never see an error.
    this._setErrorHandling();
    return this.app;
  }

  _setSecurity() {
    this.app.use(helmet());
    this.app.use(
      cors({
        origin: this._corsOrigin,
        methods: ['GET', 'PUT', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Authorization', 'Content-Type', 'Origin'],
        credentials: true,
        optionsSuccessStatus: 200,
      })
    );
    this.app.use(rateLimit({ requests: 300, perMs: 60_000 }));
  }

  /**
   * Decides one request's origin against `CORS.ORIGINS`.
   *
   * A callback rather than the array `cors` would accept directly, for two
   * reasons: the comparison has to normalise the header the same way the
   * allowlist was normalised at boot, and an empty allowlist has to mean
   * something other than "allow everything" — see the CORS block in
   * variables.config.js.
   *
   * A rejected origin answers `false`, not an Error. An Error would travel to
   * `errorHandler` and be logged as an INTERNAL_ERROR with a 500, when a
   * cross-origin request from a site we do not list is a routine browser probe
   * whose correct answer is simply the absence of the header.
   */
  _corsOrigin(origin, callback) {
    // No Origin header: same-origin, curl, or another server. CORS does not
    // apply, and refusing here would break every non-browser client.
    if (!origin) return callback(null, true);

    const allowed = config.CORS.ORIGINS;
    if (!allowed.length) return callback(null, config.NODE_ENV !== 'production');

    return callback(null, allowed.includes(origin.toLowerCase().replace(/\/+$/, '')));
  }

  _setRequestParser() {
    this.app.set('query parser', 'extended');
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  }

  _initializeApi() {
    this.app.use('/api/v1', Api);
  }

  _setErrorHandling() {
    this.app.use(notFoundHandler);
    this.app.use(errorHandler);
  }
}

export default new App();
