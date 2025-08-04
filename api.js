import express from "express";
import cors from "cors";
import pg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { authenticateToken } from "./authenticate.js";

const pool = new pg.Pool({
  user: config.PG_USER,
  password: config.PG_PASSWORD,
  host: config.PG_HOST,
  port: config.PG_PORT,
  database: config.PG_DATABASE,
});

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = config.JWT_SECRET;

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Missing username or password" });

  try {
    const result = await pool.query(
      "SELECT username, password_hash FROM users WHERE username = $1",
      [username]
    );
    if (result.rows.length === 0)
      return res.status(401).json({ error: "Invalid credentials" });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "1h" });

    res.json({ token, username });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/scores", async (req, res) => {
  try {
    const league = req.query.league || "global";

    const query = `
      SELECT 
        s.username,
        u.name,
        s.score,
        s.correct_bets,
        s.final_balance
      FROM scores s
      JOIN users u ON s.username = u.username
      WHERE s.league = $1
      ORDER BY s.score DESC, s.correct_bets DESC
    `;

    const result = await pool.query(query, [league]);

    res.json(result.rows);
  } catch (err) {
    console.error("Scores endpoint error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/submitbet", authenticateToken, async (req, res) => {
  const { id_fixture, bet } = req.body;
  const username = req.user.username;

  if (!id_fixture || !bet) {
    return res.status(400).json({ error: "Missing id_fixture or bet" });
  }

  try {
    // 1. Check if the match exists and hasn't started yet
    const matchResult = await pool.query(
      "SELECT date FROM matches WHERE id_fixture = $1",
      [id_fixture]
    );

    if (matchResult.rows.length === 0) {
      return res.status(404).json({ error: "Match not found" });
    }

    const matchDate = new Date(matchResult.rows[0].date);
    const now = new Date();

    if (matchDate <= now) {
      return res
        .status(403)
        .json({ error: "Cannot bet on a match already underway" });
    }

    // 2. Upsert the bet
    await pool.query(
      `
      INSERT INTO bets (username, id_fixture, bet)
      VALUES ($1, $2, $3)
      ON CONFLICT (username, id_fixture) DO UPDATE
      SET bet = EXCLUDED.bet
      `,
      [username, id_fixture, bet]
    );

    res.json({ message: "Bet submitted successfully" });
  } catch (err) {
    console.error("Submit bet error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/nextmatches", authenticateToken, async (req, res) => {
  try {
    const username = req.user.username; // Comes from decoded token

    const query = `
      SELECT 
        m.id_fixture,
        m.date,
        ht.name AS home_team,
        at.name AS away_team,
        m.odds_1 * COALESCE(mp.multiplier, 1) AS odds_1,
        m.odds_x * COALESCE(mp.multiplier, 1) AS odds_x,
        m.odds_2 * COALESCE(mp.multiplier, 1) AS odds_2,
        b.bet
      FROM matches m
      JOIN teams ht ON m.home_team = ht.id
      JOIN teams at ON m.away_team = at.id
      LEFT JOIN multipliers mp ON m.matchday = mp.matchday
      LEFT JOIN bets b ON m.id_fixture = b.id_fixture AND b.username = $1
      WHERE m.date >= NOW()
        AND m.date < NOW() + INTERVAL '8 days'
      ORDER BY m.date ASC;
    `;

    const result = await pool.query(query, [username]);

    res.json(result.rows);
  } catch (err) {
    console.error("Next matches error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Register endpoint with leagues as text[]
app.post("/register", async (req, res) => {
  const { username, name, leagues, password } = req.body;
  if (!username || !password || !name)
    return res.status(400).json({ error: "Missing required fields" });

  const leaguesArray = leagues ? leagues.split(",").map((l) => l.trim()) : [];

  try {
    const password_hash = await bcrypt.hash(password, 10);

    await pool.query(
      `
      INSERT INTO users (username, name, leagues, password_hash)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (username) DO UPDATE
      SET name = EXCLUDED.name,
          leagues = EXCLUDED.leagues,
          password_hash = EXCLUDED.password_hash
    `,
      [username, name, leaguesArray, password_hash]
    );

    res.json({ message: "User registered/updated successfully" });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
