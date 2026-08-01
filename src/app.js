import 'dotenv/config'
import cors from 'cors'
import express from 'express'

class App {
    constructor() {
        this.app = express();
        this.app.use(helmet());
        this.app.use(cors());        
    }
}