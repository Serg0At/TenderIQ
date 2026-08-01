import 'dotenv/config';

const config = {
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,

  PSQL: {
    PORT: process.env.PSQL_PORT,
    HOST: process.env.PSQL_HOST,
    USER: process.env.PSQL_USER,
    DATABASE: process.env.PSQL_DATABASE,
    PASSWORD: process.env.PSQL_PASSWORD,
  },

  AUTH: {
    JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
    REFRESH_TOKEN_ACTIVE_TIME: process.env.REFRESH_TOKEN_ACTIVE_TIME || '20d',
    ACCESS_TOKEN_ACTIVE_TIME: process.env.ACCESS_TOKEN_ACTIVE_TIME || '15m',
  },

  GOOGLE_OAUTH: {
    CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    CALLBACK_URL: process.env.CALLBACK_URL,
  },
};

export default config;
