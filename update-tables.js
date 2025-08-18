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

async function updateMatches() {
  try {
    const res = await client.query("SELECT id, season FROM championships");

    for (const championship of res.rows) {
      const url = `${config.API_URL}/fixtures?league=${championship.id}&season=${championship.season}`;
      const response = await fetch(url, {
        headers: { "X-APISPORTS-KEY": config.API_KEY },
      });

      const data = await response.json();

      const fixturesToInsert = data.response
        .filter((fixture) => fixture.league.round.includes("Regular Season"))
        .map((fixture) => [
          fixture.fixture.id,
          fixture.league.season,
          fixture.league.round.split(" - ")[1],
          fixture.teams.home.name,
          fixture.teams.away.name,
          getResult(fixture.goals.home, fixture.goals.away),
          fixture.fixture.status.short,
          fixture.fixture.date,
          championship.id,
        ]);

      if (fixturesToInsert.length === 0) continue;

      // Build batch insert query placeholders
      const valuesPlaceholders = fixturesToInsert
        .map(
          (_, i) =>
            `($${i * 9 + 1}, $${i * 9 + 2}, $${i * 9 + 3}, $${i * 9 + 4}, $${
              i * 9 + 5
            }, $${i * 9 + 6}, $${i * 9 + 7}, $${i * 9 + 8}, $${i * 9 + 9})`
        )
        .join(", ");

      const flatValues = fixturesToInsert.flat();

      const sql = `
        INSERT INTO matches
          (id_fixture, season, matchday, home_team, away_team, result, status, date, championship)
        VALUES ${valuesPlaceholders}
        ON CONFLICT (id_fixture) DO UPDATE SET
          season = EXCLUDED.season,
          matchday = EXCLUDED.matchday,
          home_team = EXCLUDED.home_team,
          away_team = EXCLUDED.away_team,
          result = EXCLUDED.result,
          status = EXCLUDED.status,
          date = EXCLUDED.date,
          championship = EXCLUDED.championship;
      `;

      await client.query(sql, flatValues);

      console.log(
        `Upserted ${fixturesToInsert.length} fixtures for league ${championship.id}, season ${championship.season}.`
      );
    }
  } catch (err) {
    console.error("Error updating matches:", err);
  }
}

async function updateOdds() {
  try {
    const today = new Date();

    const res = await client.query("SELECT id, season FROM championships");

    for (const championship of res.rows) {
      for (let i = 0; i < 3; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() + i);

        // Format YYYY-MM-DD
        const formattedDate = date.toISOString().split("T")[0];

        const url = `${config.API_URL}/odds?league=${championship.id}&season=${championship.season}&bookmaker=8&bet=1&date=${formattedDate}`;
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

          const rangeRes = await client.query(
            `
            SELECT 
              MAX(matchday)/3 AS first_boundary, 
              MAX(matchday)*2/3 AS second_boundary 
            FROM public.matches 
            WHERE championship = $1
              AND season = $2
            `,
            [championship.id, championship.season]
          );

          const { first_boundary, second_boundary } = rangeRes.rows[0];

          // Get the matchday for the specific fixture
          const matchRes = await client.query(
            `SELECT matchday FROM matches WHERE id_fixture = $1`,
            [fixtureId]
          );

          const matchday = matchRes.rows[0]?.matchday;

          let multiplier = 1.0;
          if (matchday <= first_boundary) {
            multiplier = 1.0;
          } else if (matchday <= second_boundary) {
            multiplier = 1.5;
          } else {
            multiplier = 2.0;
          }

          // Apply multiplier to odds
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
    }
  } catch (err) {
    console.error("Error updating odds:", err);
  }
}

async function buildScores() {
  try {
    // 1️⃣ Truncate the leaderboard table first
    await client.query(`TRUNCATE TABLE scores`);

    // 2️⃣ Fetch all leagues along with their season
    const leaguesRes = await client.query(
      `
      SELECT l.id_league, l.championship, c.season
      FROM leagues l
      JOIN championships c ON c.id = l.championship
      `
    );

    for (const league of leaguesRes.rows) {
      const { id_league, championship, season } = league;

      // 3️⃣ Fetch all users in this league
      const usersRes = await client.query(
        `
        SELECT username
        FROM users
        WHERE $1 = ANY(league)
        `,
        [id_league]
      );
      const users = usersRes.rows;

      // 4️⃣ Calculate total betting volume for this league and season (restricted to fairplay, with 0.9 cutoff)
      const volumeRes = await client.query(
        `
        WITH boundaries AS (
          SELECT 
            MAX(matchday) / 3 AS first_boundary,
            MAX(matchday) * 2 / 3 AS second_boundary,
            MAX(matchday) * 0.9 AS secret_mode
          FROM matches m
          JOIN fairplay f ON f.id_fixture = m.id_fixture
          WHERE m.championship = $1 
            AND m.season = $2
            AND f.league = $3
        )
        SELECT COALESCE(SUM(
          CASE 
            WHEN m.matchday <= b.first_boundary THEN 1.0
            WHEN m.matchday <= b.second_boundary THEN 1.5
            ELSE 2.0
          END
        ), 0) AS total_volume
        FROM matches m
        JOIN fairplay f ON f.id_fixture = m.id_fixture
        CROSS JOIN boundaries b
        WHERE m.status = 'FT'
          AND m.championship = $1
          AND m.season = $2
          AND f.league = $3
          AND m.matchday < b.secret_mode
        `,
        [championship, season, id_league]
      );
      const totalVolume = volumeRes.rows[0].total_volume;

      // 5️⃣ Calculate scores and correct bets for each user (restricted to fairplay, with 0.9 cutoff)
      for (const user of users) {
        const { username } = user;

        const scoreRes = await client.query(
          `
          WITH boundaries AS (
            SELECT MAX(matchday) * 0.9 AS secret_mode
            FROM matches m
            JOIN fairplay f ON f.id_fixture = m.id_fixture
            WHERE m.championship = $2
              AND m.season = $3
              AND f.league = $4
          )
          SELECT 
            COALESCE(SUM(
              CASE
                WHEN b.bet = m.result THEN 
                  CASE m.result
                    WHEN '1' THEN m.odds_1
                    WHEN 'x' THEN m.odds_x
                    WHEN '2' THEN m.odds_2
                  END
                ELSE 0
              END
            ), 0) AS score,
            COALESCE(SUM(CASE WHEN b.bet = m.result THEN 1 ELSE 0 END), 0) AS correct_bets
          FROM bets b
          JOIN matches m ON b.id_fixture = m.id_fixture
          JOIN fairplay f ON f.id_fixture = m.id_fixture
          CROSS JOIN boundaries bnd
          WHERE b.username = $1
            AND m.status = 'FT'
            AND m.championship = $2
            AND m.season = $3
            AND f.league = $4
            AND m.matchday < bnd.secret_mode
          `,
          [username, championship, season, id_league]
        );

        const { score, correct_bets } = scoreRes.rows[0];
        const final_balance = score - totalVolume;

        // 6️⃣ Insert into scores table
        await client.query(
          `
          INSERT INTO scores (username, league, score, correct_bets, final_balance)
          VALUES ($1, $2, $3, $4, $5)
          `,
          [username, id_league, score, correct_bets, final_balance]
        );
      }

      console.log(`Leaderboard updated for league: ${championship}`);
    }
  } catch (err) {
    console.error("Error building scores:", err);
  }
}

async function populateFairplay() {
  try {
    await client.query(`TRUNCATE TABLE fairplay`);

    const leaguesRes = await client.query(
      `
      SELECT l.id_league, l.championship, c.season
      FROM leagues l
      JOIN championships c ON c.id = l.championship
      `
    );

    const rowsToInsert = [];

    for (const league of leaguesRes.rows) {
      const { id_league, championship, season } = league;

      // Get all users in this league
      const usersRes = await client.query(
        `SELECT username FROM users WHERE $1 = ANY(league)`,
        [id_league]
      );
      const usernames = usersRes.rows.map((row) => row.username);

      if (usernames.length === 0) continue;

      // Get matches where ALL users in this league have placed a bet
      const matchesRes = await client.query(
        `
        SELECT m.id_fixture
        FROM matches m
        JOIN bets b ON m.id_fixture = b.id_fixture
        WHERE m.season = $1
          AND m.championship = $2
          AND b.username = ANY($3)
        GROUP BY m.id_fixture
        HAVING COUNT(DISTINCT b.username) = $4
        `,
        [season, championship, usernames, usernames.length]
      );

      for (const row of matchesRes.rows) {
        rowsToInsert.push({ id_fixture: row.id_fixture, league: id_league });
      }
    }

    // Insert into fairplay
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
    //await updateMatches();
    //await updateOdds();
    await populateFairplay();
    await buildScores();
    //await generateNotificationTokens();
  } catch (err) {
    console.error("Error in main:", err);
  } finally {
    client.release();
    await config.pool.end();
  }
}

main();
