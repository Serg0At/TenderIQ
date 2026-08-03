import { Queue } from "bullmq";
import connectionOptions from './libs/redis.js'

export const ingestionQueue = new Queue("ingestion", {
    connection: {
        host: connectionOptions.host,
        port: connectionOptions.port
    }
});