// middleware/authenticate.js
import jwt from "jsonwebtoken";
import { config } from "./config.js";

const JWT_SECRET = config.JWT_SECRET;

export function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "Missing authorization header" });
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ error: "Invalid authorization header" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // Attach user info to request object
    next(); // Continue to the next middleware/route
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// Add utility to generate token
export function generateToken(userPayload) {
  return jwt.sign(userPayload, JWT_SECRET);
}
