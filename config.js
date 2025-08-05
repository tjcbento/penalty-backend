import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: "./config/.env" });
const ENV = (process.env.ENVIRONMENT || "development").toLowerCase();
console.log("Starting up in %s mode", ENV);

const configs = {
  production: {
    API_URL: process.env.API_URL_PRODUCTION,
    API_KEY: process.env.API_KEY_PRODUCTION,
    LEAGUE_ID: process.env.LEAGUE_ID_PRODUCTION,
    SEASON: process.env.SEASON_PRODUCTION,
    ROUNDS_IMPORT: process.env.ROUNDS_IMPORT_PRODUCTION,

    PG_HOST: process.env.PG_HOST_PRODUCTION,
    PG_PORT: Number(process.env.PG_PORT_PRODUCTION),
    PG_USER: process.env.PG_USER_PRODUCTION,
    PG_PASSWORD: process.env.PG_PASSWORD_PRODUCTION,
    PG_DATABASE: process.env.PG_DATABASE_PRODUCTION,

    JWT_SECRET: process.env.JWT_SECRET_PRODUCTION,
    SECRET_MODE: process.env.SECRET_MODE_PRODUCTION,

    VITE_BACKEND_URL: process.env.VITE_BACKEND_URL_PRODUCTION,
  },

  staging: {
    API_URL: process.env.API_URL_STAGING,
    API_KEY: process.env.API_KEY_STAGING,
    LEAGUE_ID: process.env.LEAGUE_ID_STAGING,
    SEASON: process.env.SEASON_STAGING,
    ROUNDS_IMPORT: process.env.ROUNDS_IMPORT_STAGING,

    PG_HOST: process.env.PG_HOST_STAGING,
    PG_PORT: Number(process.env.PG_PORT_STAGING),
    PG_USER: process.env.PG_USER_STAGING,
    PG_PASSWORD: process.env.PG_PASSWORD_STAGING,
    PG_DATABASE: process.env.PG_DATABASE_STAGING,

    JWT_SECRET: process.env.JWT_SECRET_STAGING,
    SECRET_MODE: process.env.SECRET_MODE_STAGING,

    VITE_BACKEND_URL: process.env.VITE_BACKEND_URL_STAGING,
  },

  development: {
    API_URL: process.env.API_URL_DEVELOPMENT,
    API_KEY: process.env.API_KEY_DEVELOPMENT,
    LEAGUE_ID: process.env.LEAGUE_ID_DEVELOPMENT,
    SEASON: process.env.SEASON_DEVELOPMENT,
    ROUNDS_IMPORT: process.env.ROUNDS_IMPORT_DEVELOPMENT,

    PG_HOST: process.env.PG_HOST_DEVELOPMENT,
    PG_PORT: Number(process.env.PG_PORT_DEVELOPMENT),
    PG_USER: process.env.PG_USER_DEVELOPMENT,
    PG_PASSWORD: process.env.PG_PASSWORD_DEVELOPMENT,
    PG_DATABASE: process.env.PG_DATABASE_DEVELOPMENT,

    JWT_SECRET: process.env.JWT_SECRET_DEVELOPMENT,
    SECRET_MODE: process.env.SECRET_MODE_DEVELOPMENT,

    TELEGRAM_BOT_TOKEN:process.env.TELEGRAM_BOT_TOKEN,

    VITE_BACKEND_URL: process.env.VITE_BACKEND_URL_DEVELOPMENT,
  },
};

const selectedConfig = configs[ENV];

const pool = new pg.Pool({
  user: selectedConfig.PG_USER,
  password: selectedConfig.PG_PASSWORD,
  host: selectedConfig.PG_HOST,
  port: selectedConfig.PG_PORT,
  database: selectedConfig.PG_DATABASE,
});

export const config = {
  ENV,
  ...selectedConfig,
  PORT: Number(process.env.PORT) || 3000,
  pool,
};
