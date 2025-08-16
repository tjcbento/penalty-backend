import fetch from "node-fetch";
import { config } from "./config.js";
import crypto from "crypto";
import nodemailer from "nodemailer";

const client = await config.pool.connect();

function getResult(homeGoals, awayGoals) {
  if (homeGoals == null || awayGoals == null) return null;
  if (homeGoals > awayGoals) return "1";
  if (homeGoals === awayGoals) return "X";
  return "2";
}

async function sendEmail(toEmail, subject, htmlBody) {
  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false, // use TLS
      auth: {
        user: config.FROM_EMAIL,
        pass: config.EMAIL_PASSWORD,
      },
    });

    const mailOptions = {
      from: `"${config.EMAIL_FROM_NAME}" <${config.FROM_EMAIL}>`,
      to: toEmail,
      subject: subject,
      html: htmlBody,
    };

    await transporter.sendMail(mailOptions);
    console.log(`Email sent to ${toEmail}`);
  } catch (err) {
    console.error(`Failed to send email to ${toEmail}:`, err);
  }
}

async function sendTelegramMessage(telegramChatId, body) {
  const url = `${config.TELEGRAM_API_URL || "https://api.telegram.org/bot"}${
    config.TELEGRAM_BOT_TOKEN
  }/sendMessage`;

  const params = new URLSearchParams({
    chat_id: telegramChatId,
    text: body,
    parse_mode: "HTML",
    disable_web_page_preview: "true",
  });

  // Optional: Slow down to avoid rate limiting
  await new Promise((res) => setTimeout(res, 500)); // 0.5s delay

  const res = await fetch(`${url}?${params.toString()}`);
  if (!res.ok) {
    console.error("Failed to send message to Telegram:", await res.text());
  }
}

function prepareUpsert(fixture) {
  const id_fixture = fixture.fixture.id;
  const season = fixture.league.season;
  const matchday = fixture.league.round.split(" - ")[1];
  const home_team = fixture.teams.home.id;
  const away_team = fixture.teams.away.id;
  const result = getResult(fixture.goals.home, fixture.goals.away);
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
    const today = new Date();

    for (let i = 0; i < 10; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);

      // Format YYYY-MM-DD
      const formattedDate = date.toISOString().split("T")[0];

      const url = `${config.API_URL}/odds?date=${formattedDate}&bookmaker=8&bet=1`;
      const response = await fetch(url, {
        headers: { "X-APISPORTS-KEY": config.API_KEY },
      });

      if (!response.ok)
        throw new Error(
          `API error (${formattedDate}): ${response.status} ${response.statusText}`
        );

      const data = await response.json();
      if (!Array.isArray(data.response)) {
        console.warn(`No valid response for ${formattedDate}`);
        continue;
      }

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

      console.log(
        `Updated odds for ${data.response.length} fixtures on ${formattedDate}.`
      );
    }
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
      SELECT DISTINCT UNNEST(league) AS league FROM users
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
          AND $2 = ANY(users.league)
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
      SELECT DISTINCT UNNEST(league) AS league FROM users
    `);
    const leagues = leaguesRes.rows.map((row) => row.league);

    const rowsToInsert = [];

    for (const league of leagues) {
      const usersRes = await client.query(
        `SELECT username FROM users WHERE $1 = ANY(league)`,
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

async function generateNotificationTokens() {
  try {
    const now = new Date();
    const currentHour = now.getHours();

    if (currentHour >= 12) return;

    await client.query(`TRUNCATE TABLE notification_tokens`);

    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];

    const matchesRes = await client.query(
      `SELECT id_fixture, odds_1, odds_x, odds_2, date, home_team, away_team 
       FROM matches 
       WHERE date::date = $1`,
      [todayStr]
    );

    const matches = matchesRes.rows;
    if (matches.length === 0) {
      console.log("No matches scheduled for today.");
      return;
    }

    const fixtureIds = matches.map((m) => m.id_fixture);

    const matchDetailsMap = {};
    for (const m of matches) {
      matchDetailsMap[m.id_fixture] = {
        date: m.date,
        home_team_id: m.home_team,
        away_team_id: m.away_team,
        odds_1: m.odds_1,
        odds_x: m.odds_x,
        odds_2: m.odds_2,
      };
    }

    const teamIds = Array.from(
      new Set(matches.flatMap((m) => [m.home_team, m.away_team]))
    );
    const teamsRes = await client.query(
      `SELECT id, name FROM teams WHERE id = ANY($1)`,
      [teamIds]
    );
    const teamNameMap = Object.fromEntries(
      teamsRes.rows.map((row) => [row.id, row.name])
    );

    const usersRes = await client.query(`
      SELECT username, name, notification, telegram_id, email
      FROM users
    `);
    const users = usersRes.rows;
    if (users.length === 0) {
      console.log("No users to notify.");
      return;
    }

    const betsRes = await client.query(
      `SELECT username, id_fixture, bet FROM bets WHERE id_fixture = ANY($1)`,
      [fixtureIds]
    );
    const betsToday = betsRes.rows;

    const tokens = [];
    const insertParams = [];
    const insertPlaceholders = [];
    let paramIndex = 1;

    for (const match of matches) {
      for (const user of users) {
        for (const bet of ["1", "X", "2"]) {
          const token = crypto.randomBytes(20).toString("hex").slice(0, 20);
          tokens.push({
            token,
            username: user.username,
            id_fixture: match.id_fixture,
            bet,
            notification: user.notification,
            telegram_id: user.telegram_id,
            email: user.email,
            name: user.name,
            odds_1: match.odds_1,
            odds_x: match.odds_x,
            odds_2: match.odds_2,
          });
          insertPlaceholders.push(
            `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
          );
          insertParams.push(token, user.username, match.id_fixture, bet);
        }
      }
    }

    const insertQuery = `
      INSERT INTO notification_tokens (token, username, id_fixture, bet)
      VALUES ${insertPlaceholders.join(", ")}
    `;
    await client.query(insertQuery, insertParams);
    console.log(`Inserted ${tokens.length} notification tokens.`);

    const userGroups = {};

    for (const token of tokens) {
      if (!userGroups[token.username]) {
        userGroups[token.username] = {
          name: token.name,
          telegram_id: token.telegram_id,
          email: token.email,
          notification: token.notification, // ✅ FIXED HERE
          matches: {},
        };
      }
      if (!userGroups[token.username].matches[token.id_fixture]) {
        userGroups[token.username].matches[token.id_fixture] = {
          bets: {},
          odds: {
            1: token.odds_1,
            X: token.odds_x,
            2: token.odds_2,
          },
        };
      }
      userGroups[token.username].matches[token.id_fixture].bets[token.bet] =
        token.token;
    }

    for (const [username, userData] of Object.entries(userGroups)) {
      const notifications = userData.notification || [];

      if (!notifications.length) continue;

      const { name, telegram_id, email, matches } = userData;

      let message = `Olá ${name},\nEstas são as tuas apostas do dia:\n`;

      for (const [id_fixture, matchData] of Object.entries(matches)) {
        const match = matchDetailsMap[id_fixture];
        const userBet = betsToday.find(
          (b) => b.username === username && b.id_fixture == id_fixture
        )?.bet;

        const homeTeam = teamNameMap[match.home_team_id];
        const awayTeam = teamNameMap[match.away_team_id];
        const time = new Date(match.date).toLocaleTimeString("pt-PT", {
          hour: "2-digit",
          minute: "2-digit",
        });

        const line = ["1", "X", "2"].map((betKey) => {
          const oddsRaw = matchData.odds[betKey];
          const odds = typeof oddsRaw === "number" ? oddsRaw : Number(oddsRaw);
          const oddsDisplay =
            typeof odds === "number" && !isNaN(odds) ? odds.toFixed(2) : "???";

          const token = matchData.bets[betKey];
          const url = `https://api.penalty.bet/submitnotificationbet?token=${token}`;

          if (userBet === betKey) {
            return `[<a href="${url}">${oddsDisplay}</a>]`;
          } else {
            return `<a href="${url}">${oddsDisplay}</a>`;
          }
        });

        message += `\n${homeTeam} - ${awayTeam} : ${time}\n|  ${line.join(
          "  |  "
        )}  |\n`;
      }

      message += `\nNão te esqueças que podes apostar ao carregar em cima dos links desta mensagem.\nBoa sorte!\nThe Penalty Team`;

      if (notifications.includes("telegram") && telegram_id) {
        await sendTelegramMessage(telegram_id, message);
      }

      if (notifications.includes("email") && email) {
        const transporter = nodemailer.createTransport({
          host: "smtp.gmail.com",
          port: 587,
          secure: false,
          auth: {
            user: config.FROM_EMAIL,
            pass: config.EMAIL_PASSWORD,
          },
        });

        const mailOptions = {
          from: `"${config.EMAIL_FROM_NAME}" <${config.FROM_EMAIL}>`,
          to: email,
          subject: "Penalty - Apostas do dia",
          html: message.replace(/\n/g, "<br>"),
        };

        try {
          await transporter.sendMail(mailOptions);
          console.log(`Email sent to ${email} (${username})`);
        } catch (emailErr) {
          console.error(`Failed to send email to ${email}:`, emailErr);
        }
      }
    }
  } catch (err) {
    console.error("Error generating notification tokens:", err);
  }
}

async function main() {
  try {
    await updateMatches();
    await upsertTeams();
    await updateOdds();
    await populateFairplay();
    await buildScores(config.SECRET_MODE, config.SEASON);
    await generateNotificationTokens();
  } catch (err) {
    console.error("Error in main:", err);
  } finally {
    client.release();
    await config.pool.end();
  }
}

main();
