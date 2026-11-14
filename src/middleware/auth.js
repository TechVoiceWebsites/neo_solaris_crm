import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { prisma } from "../config/db.js";
import { ApiError, wrap } from "../utils/http.js";

const AUTH_CACHE_TTL = 30_000; // 30s user verification cache (eliminates ~1.1s DB round-trip per API call)
const userCache = new Map(); // userId -> { user, at }

export const invalidateUserCache = (id) => {
  if (id) userCache.delete(id);
  else userCache.clear();
};

export const signToken = (u) => jwt.sign({ sub: u.id }, env.jwtSecret, { expiresIn: "8h" });

// Role is re-read from DB every 30s (never trusted from token/client), while avoiding redundant queries on burst requests.
export const authenticate = wrap(async (req, _res, next) => {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) throw new ApiError(401, "Sign in required");

  let id;
  try {
    id = jwt.verify(h.slice(7), env.jwtSecret).sub;
  } catch {
    throw new ApiError(401, "Session expired, sign in again");
  }

  const hit = userCache.get(id);
  if (hit && Date.now() - hit.at < AUTH_CACHE_TTL) {
    req.user = hit.user;
    return next();
  }

  const user = await prisma.user.findFirst({
    where: { id, isActive: true, deletedAt: null },
    select: { id: true, name: true, email: true, role: true, isActive: true },
  });
  if (!user) {
    userCache.delete(id);
    throw new ApiError(401, "Account is not active");
  }

  userCache.set(id, { user, at: Date.now() });
  req.user = user;
  next();
});

export const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user.role) ? next() : next(new ApiError(403, "You do not have permission for this action"));