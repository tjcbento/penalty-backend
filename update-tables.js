import fetch from "node-fetch";
import { config } from "./config.js";

const client = await config.pool.connect();

function getResult(homeGoals, awayGoals) {
  if (homeGoals == null || awayGoals == null) return null;
  if (homeGoals > awayGoals) return "1";
  if (homeGoals === awayGoals) return "X";
  return "2";
}

function prepareUpsert(fixture) {
  const id_fixture = fixture.fixture.id;
  const season = fixture.league.season;
  const matchday = fixture.league.round.split(" - ")[1];
  const home_team = fixture.teams.home.id;
  const away_team = fixture.teams.away.id;
  const result = "1"; // Placeholder
  const status = "FT"; // Placeholder
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
    const url = `${config.API_URL}/fixtures?league=${config.LEAGUE_ID}&season=${config.SEASON}`;
    const response = await fetch(url, {
      headers: { "X-APISPORTS-KEY": config.API_KEY },
    });

    if (!response.ok)
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    const data = await response.json();
    if (!data.response) throw new Error("No response data found");

    let insertedCount = 0;
    for (const fixture of data.response) {
      if (!fixture.league.round.includes(config.ROUNDS_IMPORT)) continue;
      const { sql, values } = prepareUpsert(fixture);
      await client.query(sql, values);
      insertedCount++;
    }
    console.log(`Upserted ${insertedCount} regular season fixtures.`);
  } catch (err) {
    console.error("Error updating matches:", err);
  }
}

async function updateOdds() {
  try {
    const url = `${config.API_URL}/odds?league=${config.LEAGUE_ID}&season=${config.SEASON}&bookmaker=8&bet=1`;
    const response = await fetch(url, {
      headers: { "X-APISPORTS-KEY": config.API_KEY },
    });

    if (!response.ok)
      throw new Error(`API error: ${response.status} ${response.statusText}`);

    const data = await response.json();
    if (!Array.isArray(data.response))
      throw new Error("Invalid or missing response data");

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

      const matchRes = await client.query(
        `SELECT matchday FROM matches WHERE id_fixture = $1`,
        [fixtureId]
      );

      if (matchRes.rows.length === 0) continue;

      const matchday = matchRes.rows[0].matchday;

      const multiplierRes = await client.query(
        `SELECT multiplier FROM multipliers WHERE matchday = $1`,
        [matchday]
      );

      const multiplier = multiplierRes.rows[0]?.multiplier;
      if (multiplier == null) continue;

      const adjustedOdds = {
        odds_1: oddsMap.odds_1 * multiplier,
        odds_x: oddsMap.odds_x * multiplier,
        odds_2: oddsMap.odds_2 * multiplier,
      };

      await client.query(
        `UPDATE matches 
           SET odds_1 = $1, odds_x = $2, odds_2 = $3 
           WHERE id_fixture = $4`,
        [
          adjustedOdds.odds_1,
          adjustedOdds.odds_x,
          adjustedOdds.odds_2,
          fixtureId,
        ]
      );
    }

    console.log(`Updated odds for ${data.response.length} fixtures.`);
  } catch (err) {
    console.error("Error updating odds:", err);
  }
}

async function upsertTeams() {
  try {
    const url = `${config.API_URL}/teams?league=${config.LEAGUE_ID}&season=${config.SEASON}`;
    const response = await fetch(url, {
      headers: { "X-APISPORTS-KEY": config.API_KEY },
    });

    if (!response.ok)
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    const data = await response.json();
    if (!data.response) throw new Error("No response data found");

    for (const item of data.response) {
      const { id, name, logo } = item.team;

      await client.query(
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

async function buildScores(secretModeValue, seasonValue) {
  try {
    await client.query(`TRUNCATE TABLE scores`);

    const leaguesRes = await client.query(`
      SELECT DISTINCT UNNEST(leagues) AS league FROM users
    `);
    const leagues = leaguesRes.rows.map((row) => row.league);

    for (const league of leagues) {
      const volumeRes = await client.query(
        `
        SELECT COALESCE(SUM(multipliers.multiplier), 0) AS volume
        FROM fairplay
        JOIN matches ON fairplay.id_fixture = matches.id_fixture
        JOIN multipliers ON multipliers.matchday = matches.matchday
        WHERE fairplay.league = $1
          AND matches.status = 'FT'
          AND matches.matchday < $2
          AND matches.season = $3
      `,
        [league, secretModeValue, seasonValue]
      );

      const bettingVolume = Number(volumeRes.rows[0].volume);

      await client.query(
        `
        INSERT INTO scores (username, league, score, correct_bets, final_balance)
        SELECT 
          bets.username,
          $2 AS league,
          SUM(
            CASE matches.result
              WHEN '1' THEN matches.odds_1
              WHEN 'x' THEN matches.odds_x
              WHEN '2' THEN matches.odds_2
            END
          ) AS score,
          COUNT(*) AS correct_bets,
          SUM(
            CASE matches.result
              WHEN '1' THEN matches.odds_1
              WHEN 'x' THEN matches.odds_x
              WHEN '2' THEN matches.odds_2
            END
          ) - $3 AS final_balance
        FROM bets
        JOIN matches ON bets.id_fixture = matches.id_fixture
        JOIN fairplay ON fairplay.id_fixture = matches.id_fixture
        JOIN users ON users.username = bets.username
        WHERE bets.bet = matches.result
          AND matches.matchday < $1
          AND fairplay.league = $2
          AND matches.season = $4
          AND $2 = ANY(users.leagues)
        GROUP BY bets.username;
        `,
        [secretModeValue, league, bettingVolume, seasonValue]
      );
    }
  } catch (err) {
    console.error("Error building scores:", err);
  }
}

async function populateFairplay() {
  try {
    await client.query(`TRUNCATE TABLE fairplay`);

    const leaguesRes = await client.query(`
      SELECT DISTINCT UNNEST(leagues) AS league FROM users
    `);
    const leagues = leaguesRes.rows.map((row) => row.league);

    const rowsToInsert = [];

    for (const league of leagues) {
      const usersRes = await client.query(
        `SELECT username FROM users WHERE $1 = ANY(leagues)`,
        [league]
      );
      const usernames = usersRes.rows.map((row) => row.username);

      if (usernames.length === 0) continue;

      const matchesRes = await client.query(
        `
        SELECT m.id_fixture
        FROM matches m
        JOIN bets b ON m.id_fixture = b.id_fixture
        WHERE m.season = $1
          AND b.username = ANY($2)
        GROUP BY m.id_fixture
        HAVING COUNT(DISTINCT b.username) = $3
      `,
        [config.SEASON, usernames, usernames.length]
      );

      for (const row of matchesRes.rows) {
        rowsToInsert.push({ id_fixture: row.id_fixture, league });
      }
    }

    if (rowsToInsert.length > 0) {
      const values = [];
      const params = [];

      rowsToInsert.forEach(({ id_fixture, league }, idx) => {
        values.push(`($${idx * 2 + 1}, $${idx * 2 + 2})`);
        params.push(id_fixture, league);
      });

      const insertQuery = `
        INSERT INTO fairplay (id_fixture, league)
        VALUES ${values.join(", ")}
      `;

      await client.query(insertQuery, params);
    }

    console.log(`Inserted ${rowsToInsert.length} rows into fairplay.`);
  } catch (err) {
    console.error("Error populating fairplay:", err);
  }
}

async function main() {
  try {
    await updateMatches();
    await upsertTeams();
    await updateOdds();
    await populateFairplay();
    await buildScores(config.secretModeValue, config.seasonValue);
  } catch (err) {
    console.error("Error in main:", err);
  } finally {
    client.release();
    await config.pool.end();
  }
}

main();
