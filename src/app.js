import 'dotenv/config';
import bodyParser from 'body-parser';
import cors from 'cors';
import express from 'express';

import { ingestionQueue } from './queue.js';

class App {
    constructor() {
        this.app = express();

        this.app.use(cors());        
    }

    async init(server) {
        this._setCors();
        this._setRequestParser();
        // this._initializeApi();
    }

    _setCors() {
        this.app.use(
            cors({
                origin: "*",
                methods: ["GET", "PUT", "POST", "PATCH", "DELETE", "OPTIONS"],
                allowedHeaders: ["Authorization", "Content-Type", "Origin"],
                credentials: true,
                optionsSuccessStatus: 200,
                maxAge: -1,
            })
        );
    }

    _setRequestParser() {
        this.app.use(bodyParser.json());
        const options = { limit: "200mb", extended: false };
        this.app.use(bodyParser.urlencoded(options));
        this.app.use(express.json());
    }

    // _initializeApi() {
    //     this.app.use("/api/v1", Api);
    // }
  
}

export default new App();
