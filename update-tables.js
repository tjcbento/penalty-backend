import fetch from "node-fetch";
import pkg from "pg";
import dotenv from "dotenv";

dotenv.config();

const isDev = process.env.NODE_ENV === "dev";

const PG_USER = isDev ? process.env.PG_USER_DEV : process.env.PG_USER;
const PG_PASSWORD = isDev
  ? process.env.PG_PASSWORD_DEV
  : process.env.PG_PASSWORD;
const PG_HOST = isDev ? process.env.PG_HOST_DEV : process.env.PG_HOST;
const PG_PORT = isDev ? process.env.PG_PORT_DEV : process.env.PG_PORT;
const PG_DATABASE = isDev
  ? process.env.PG_DATABASE_DEV
  : process.env.PG_DATABASE;

const API_KEY = process.env.API_KEY;
const API_URL = process.env.API_URL;
const LEAGUE_ID = process.env.LEAGUE_ID;
const SEASON = isDev ? process.env.SEASON_DEV : process.env.SEASON;
const ROUNDS_IMPORT = process.env.ROUNDS_IMPORT;

const { Pool } = pkg;

const pool = new Pool({
  user: PG_USER,
  host: PG_HOST,
  database: PG_DATABASE,
  password: PG_PASSWORD,
  port: Number(PG_PORT),
});

function getResult(homeGoals, awayGoals) {
  if (homeGoals == null || awayGoals == null) {
    return null;
  }
  if (homeGoals > awayGoals) return "1";
  if (homeGoals === awayGoals) return "x";
  return "2";
}

function prepareUpsert(fixture) {
  const id_fixture = fixture.fixture.id;
  const season = fixture.league.season;
  const matchday = fixture.league.round.split(" - ")[1];
  const home_team = fixture.teams.home.id;
  const away_team = fixture.teams.away.id;
  const result = getResult(
    fixture.score.fulltime.home,
    fixture.score.fulltime.away
  );
  const status = fixture.fixture.status.short;
  const date = fixture.fixture.date;

  const sql = `
    INSERT INTO matches 
      (id_fixture, season, matchday, home_team, away_team, result, status, date)
    VALUES 
      ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (id_fixture) DO UPDATE SET
      season = EXCLUDED.season,
      matchday = EXCLUDED.matchday,
      home_team = EXCLUDED.home_team,
      away_team = EXCLUDED.away_team,
      result = EXCLUDED.result,
      status = EXCLUDED.status,
      date = EXCLUDED.date;
  `;

  const values = [
    id_fixture,
    season,
    matchday,
    home_team,
    away_team,
    result,
    status,
    date,
  ];

  return { sql, values };
}

async function updateMatches() {
  try {
    const url = `${API_URL}/fixtures?league=${LEAGUE_ID}&season=${SEASON}`;
    const response = await fetch(url, {
      headers: {
        "X-APISPORTS-KEY": API_KEY,
      },
    });

    if (!response.ok)
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    const data = await response.json();
    if (!data.response) throw new Error("No response data found");

    const client = await pool.connect();

    try {
      let insertedCount = 0;
      for (const fixture of data.response) {
        if (!fixture.league.round.includes(ROUNDS_IMPORT)) continue;
        const { sql, values } = prepareUpsert(fixture);
        await client.query(sql, values);
        insertedCount++;
      }
      console.log(`Upserted ${insertedCount} regular season fixtures.`);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Error updating matches:", err);
  }
}

async function updateOdds() {
  try {
    const url = `${API_URL}/odds?league=${LEAGUE_ID}&season=${SEASON}&bookmaker=8&bet=1`;
    const response = await fetch(url, {
      headers: {
        "X-APISPORTS-KEY": API_KEY,
      },
    });

    if (!response.ok)
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    const data = await response.json();
    if (!Array.isArray(data.response))
      throw new Error("Invalid or missing response data");

    const client = await pool.connect();

    try {
      for (const item of data.response) {
        const fixtureId = item.fixture.id;
        const values = item.bookmakers?.[0]?.bets?.[0]?.values;

        if (!values || values.length !== 3) continue;

        const oddsMap = {};
        for (const val of values) {
          if (val.value === "Home") oddsMap["odds_1"] = parseFloat(val.odd);
          if (val.value === "Draw") oddsMap["odds_x"] = parseFloat(val.odd);
          if (val.value === "Away") oddsMap["odds_2"] = parseFloat(val.odd);
        }

        if (!oddsMap.odds_1 || !oddsMap.odds_x || !oddsMap.odds_2) continue;

        await client.query(
          `UPDATE matches 
           SET odds_1 = $1, odds_x = $2, odds_2 = $3 
           WHERE id_fixture = $4`,
          [oddsMap.odds_1, oddsMap.odds_x, oddsMap.odds_2, fixtureId]
        );
      }

      console.log(`Updated odds for ${data.response.length} fixtures.`);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Error updating odds:", err);
  }
}

async function upsertTeams() {
  try {
    const url = `${API_URL}/teams?league=${LEAGUE_ID}&season=${SEASON}`;
    const response = await fetch(url, {
      headers: {
        "X-APISPORTS-KEY": API_KEY,
      },
    });

    if (!response.ok)
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    const data = await response.json();
    if (!data.response) throw new Error("No response data found");

    for (const item of data.response) {
      const { id, name, logo } = item.team;

      await pool.query(
        `INSERT INTO teams (id, name, logo) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             logo = EXCLUDED.logo;`,
        [id, name, logo]
      );
    }

    console.log(`Upserted ${data.response.length} teams successfully.`);
  } catch (error) {
    console.error("Error upserting teams:", error);
  }
}

async function updateScoresTable() {
  const secretModeValue = Number(process.env.SECRET_MODE);
  const seasonValue =
    process.env.NODE_ENV === "production"
      ? process.env.SEASON
      : process.env.SEASON_DEV;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE TABLE scores");

    const { rows: volumeRows } = await client.query(
      `
        SELECT COALESCE(SUM(mult.multiplier), 0) AS total_volume
        FROM matches AS m
        INNER JOIN multipliers AS mult ON m.matchday = mult.matchday
        WHERE m.status = 'FT' AND m.matchday < $1 AND m.season = $2
        `,
      [secretModeValue, seasonValue]
    );
    const totalVolume = parseFloat(volumeRows[0].total_volume);

    await client.query(
      `
        INSERT INTO scores (username, score, correct_predictions, final_balance)
        SELECT
          b.username,
          SUM(
            CASE WHEN b.prediction = m.result THEN
              COALESCE(m.odds_1, 0) * mult.multiplier
            ELSE 0
            END
          ) AS score,
          COUNT(CASE WHEN b.prediction = m.result THEN 1 END) AS correct_predictions,
          SUM(
            CASE WHEN b.prediction = m.result THEN
              COALESCE(m.odds_1, 0) * mult.multiplier
            ELSE 0
            END
          ) - $3 AS final_balance
        FROM bets AS b
        INNER JOIN matches AS m ON b.id_fixture = m.id_fixture
        INNER JOIN multipliers AS mult ON m.matchday = mult.matchday
        WHERE m.status = 'FT' AND m.matchday < $1 AND m.season = $2
        GROUP BY b.username
        `,
      [secretModeValue, seasonValue, totalVolume]
    );

    await client.query("COMMIT");
    console.log("Scores calculated successfully.");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error calculating scores:", error);
  } finally {
    client.release();
  }
}

async function main() {
  try {
    await updateMatches();
    await upsertTeams();
    await updateOdds();
    await updateScoresTable();
  } catch (err) {
    console.error("Error in main:", err);
  } finally {
    await pool.end();
  }
}

main();
