import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

process.env.TZ = process.env.TZ || "Europe/Sofia";
const PRODUCTION = process.env.NODE_ENV === "production";
const SESSION_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();

function digest(value) {
  return createHash("sha256").update(String(value ?? "")).digest();
}
export function sameSecret(a, b) {
  return timingSafeEqual(digest(a), digest(b));
}

export function hashPass(pass) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(String(pass), salt, 64).toString("hex");
}

export function verifyPass(pass, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash || hash.length !== 128) return false;
  try {
    return timingSafeEqual(Buffer.from(hash, "hex"), scryptSync(String(pass), salt, 64));
  } catch {
    return false;
  }
}

export function validPassword(pass) {
  const text = String(pass || "");
  if (text.length < 10 || text.length > 80) return "Паролата е от 10 до 80 знака.";
  if (text === "stef88") return "Избери друга парола, не демото.";
  return "";
}

export function validUser(user) {
  const text = String(user || "").trim();
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(text)) return "Потребителят е 3–40 знака: букви, цифри, точка или тире.";
  return "";
}

export const intakeUser = process.env.INTAKE_USER || process.env.SCM_USER || (PRODUCTION ? "" : "intake");
export const intakePass = process.env.INTAKE_PASS || process.env.SCM_PASS || (PRODUCTION ? "" : "stef88");
export const siteName = String(process.env.SITE_NAME || "Tokyo sushi").trim();
export const sitePlace = String(process.env.SITE_PLACE || "").trim();

export function configProblems() {
  if (!PRODUCTION || process.env.INTAKE_TEST || process.env.SCM_TEST) return [];
  const out = [];
  if (!intakeUser || !intakePass) out.push("INTAKE_USER и INTAKE_PASS са задължителни / are required");
  if (intakePass === "stef88" || intakePass.length < 10) out.push("INTAKE_PASS трябва да е поне 10 знака и различна от демо паролата / must be 10+ chars and not the demo password");
  return out;
}

export function startSession() {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_MS);
  return token;
}
export function endSession(header) {
  const token = bearer(header);
  if (token) sessions.delete(token);
}
function bearer(header) {
  const m = /^Bearer\s+([A-Za-z0-9._-]{8,200})$/.exec(String(header || ""));
  return m ? m[1] : "";
}

export function sessionOk(header) {
  const token = bearer(header);
  if (!token) return false;
  const until = sessions.get(token);
  if (until && until > Date.now()) return true;
  if (until) sessions.delete(token);
  return false;
}

export function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  return (req, res, next) => {
    if (process.env.INTAKE_TEST || process.env.SCM_TEST) return next();
    const now = Date.now();
    const key = req.ip || "?";
    const row = hits.get(key);
    if (!row || row.reset < now) {
      hits.set(key, { n: 1, reset: now + windowMs });
      return next();
    }
    row.n += 1;
    if (row.n > max) {
      res.setHeader("Retry-After", String(Math.ceil((row.reset - now) / 1000)));
      return res.status(429).json({ error: message || "Твърде много опити. Опитай след малко." });
    }
    next();
  };
}

export function securityHeaders(_req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join("; "));
  if (PRODUCTION) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}

export { PRODUCTION };
