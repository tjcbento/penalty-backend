import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: "./config/.env" });
const ENV = (process.env.ENVIRONMENT || "development").toLowerCase();
console.log("Starting up in %s mode", ENV);

const configs = {
  production: {
    API_URL: process.env.API_FOOTBALL_URL_PRODUCTION,
    API_KEY: process.env.API_FOOTBALL_KEY_PRODUCTION,

    PG_HOST: process.env.PG_HOST_PRODUCTION,
    PG_PORT: Number(process.env.PG_PORT_PRODUCTION),
    PG_USER: process.env.PG_USER_PRODUCTION,
    PG_PASSWORD: process.env.PG_PASSWORD_PRODUCTION,
    PG_DATABASE: process.env.PG_DATABASE_PRODUCTION,

    JWT_SECRET: process.env.JWT_SECRET_PRODUCTION,
  },

  staging: {
    API_URL: process.env.API_FOOTBALL_URL_STAGING,
    API_KEY: process.env.API_FOOTBALL_KEY_STAGING,

    PG_HOST: process.env.PG_HOST_STAGING,
    PG_PORT: Number(process.env.PG_PORT_STAGING),
    PG_USER: process.env.PG_USER_STAGING,
    PG_PASSWORD: process.env.PG_PASSWORD_STAGING,
    PG_DATABASE: process.env.PG_DATABASE_STAGING,

    JWT_SECRET: process.env.JWT_SECRET_STAGING,
  },

  development: {
    API_URL: process.env.API_FOOTBALL_URL_DEVELOPMENT,
    API_KEY: process.env.API_FOOTBALL_KEY_DEVELOPMENT,

    PG_HOST: process.env.PG_HOST_DEVELOPMENT,
    PG_PORT: Number(process.env.PG_PORT_DEVELOPMENT),
    PG_USER: process.env.PG_USER_DEVELOPMENT,
    PG_PASSWORD: process.env.PG_PASSWORD_DEVELOPMENT,
    PG_DATABASE: process.env.PG_DATABASE_DEVELOPMENT,

    JWT_SECRET: process.env.JWT_SECRET_DEVELOPMENT,
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
