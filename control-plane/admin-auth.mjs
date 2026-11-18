import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { digest, insist, randomToken } from "./model.mjs";
import { transaction } from "./db.mjs";

const usernamePattern = /^[a-zA-Z0-9_.-]{3,64}$/;
const cookieName = "aborder_admin";
const sessionLifetime = 8 * 60 * 60;
const keyLength = 64;
const dummySalt = randomBytes(16);
const dummyHash = randomBytes(keyLength);

function passwordHash(password, salt) {
  return scryptSync(password, salt, keyLength);
}
export function configureAdmin(db, username, password) {
  insist(typeof username === "string" && usernamePattern.test(username)
    && typeof password === "string" && password.length >= 14 && password.length <= 1024, "invalid_admin_credentials");
  const salt = randomBytes(16);
  const hash = passwordHash(password, salt);
  transaction(db, () => {
    db.prepare(`INSERT INTO admin(username, password) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET password = excluded.password`)
      .run(username, `${salt.toString("hex")}:${hash.toString("hex")}`);
    db.prepare("DELETE FROM admin_session WHERE username = ?").run(username);
  });
}

export function login(db, body, now) {
  insist(typeof body.username === "string" && usernamePattern.test(body.username)
    && typeof body.password === "string" && body.password.length <= 1024, "invalid_credentials", 401);
  const admin = db.prepare("SELECT password FROM admin WHERE username = ?").get(body.username);
  const stored = admin?.password.split(":").map(value => Buffer.from(value, "hex"));
  const supplied = passwordHash(body.password, stored?.[0] ?? dummySalt);
  const matches = timingSafeEqual(supplied, stored?.[1] ?? dummyHash);
  insist(admin && matches, "invalid_credentials", 401);
  const token = randomToken();
  const csrf = randomToken();
  transaction(db, () => {
    db.prepare("DELETE FROM admin_session WHERE expires_at <= ?").run(now);
    db.prepare("INSERT INTO admin_session(token_hash, username, csrf, expires_at) VALUES (?, ?, ?, ?)")
      .run(digest(token), body.username, csrf, now + sessionLifetime);
  });
  return { token, csrf };
}

function requestToken(headers) {
  const values = (headers.cookie ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
  return values.length === 1 ? values[0].slice(cookieName.length + 1) : null;
}
export function adminSession(db, headers, now, csrfRequired = false) {
  const token = requestToken(headers);
  insist(token && /^[A-Za-z0-9_-]{43}$/.test(token), "administrator_required", 401);
  const session = db.prepare("SELECT * FROM admin_session WHERE token_hash = ? AND expires_at > ?").get(digest(token), now);
  insist(session, "administrator_required", 401);
  if (csrfRequired) insist(headers["x-csrf-token"] === session.csrf, "csrf_failed", 403);
  return session;
}
export function sessionCookie(token, secure) {
  return `${cookieName}=${token ?? ""}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? sessionLifetime : 0}${secure ? "; Secure" : ""}`;
}
