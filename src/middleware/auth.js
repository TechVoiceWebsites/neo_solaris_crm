
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { prisma } from "../config/db.js";
import { ApiError, wrap } from "../utils/http.js";

const AUTH_CACHE_TTL = 30_000;

const userCache = new Map();

export const invalidateUserCache = (id) => {
  if (id) {
    userCache.delete(id);
  } else {
    userCache.clear();
  }
};

export const signToken = (u) =>
  jwt.sign(
    { sub: u.id },
    env.jwtSecret,
    { expiresIn: "8h" }
  );

// --------------------------------------------------
// AUTHENTICATION
// --------------------------------------------------

export const authenticate = wrap(async (req, _res, next) => {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    throw new ApiError(401, "Sign in required");
  }

  let id;

  try {
    const decoded = jwt.verify(
      header.slice(7),
      env.jwtSecret
    );

    id = decoded.sub;

    if (!id) {
      throw new Error("Invalid token");
    }
  } catch {
    throw new ApiError(
      401,
      "Session expired, sign in again"
    );
  }

  // Check cache
  const cachedUser = userCache.get(id);

  if (
    cachedUser &&
    Date.now() - cachedUser.at < AUTH_CACHE_TTL
  ) {
    req.user = cachedUser.user;
    return next();
  }

  // Verify user from database
  const user = await prisma.user.findFirst({
    where: {
      id,
      isActive: true,
      deletedAt: null,
    },
    select: {
      id: true,
      name: true,
      email: true,
      username: true,
      role: true,
      isActive: true,
    },
  });

  if (!user) {
    userCache.delete(id);

    throw new ApiError(
      401,
      "Account is not active"
    );
  }

  userCache.set(id, {
    user,
    at: Date.now(),
  });

  req.user = user;

  next();
});

// --------------------------------------------------
// ROLE AUTHORIZATION
// --------------------------------------------------

export const requireRole = (...roles) => (
  req,
  _res,
  next
) => {
  if (!req.user) {
    return next(
      new ApiError(401, "Sign in required")
    );
  }

  if (!roles.includes(req.user.role)) {
    return next(
      new ApiError(
        403,
        "You do not have permission for this action"
      )
    );
  }

  next();
};
