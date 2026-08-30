import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import Api from './features/index.js';
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
        origin: process.env.CORS_ORIGIN?.split(',') ?? '*',
        methods: ['GET', 'PUT', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Authorization', 'Content-Type', 'Origin'],
        credentials: true,
        optionsSuccessStatus: 200,
      })
    );
    this.app.use(rateLimit({ requests: 300, perMs: 60_000 }));
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
