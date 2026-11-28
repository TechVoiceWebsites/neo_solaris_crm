
import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";

import { prisma } from "../config/db.js";
import { wrap, ok, parse, ApiError } from "../utils/http.js";
import { signToken, authenticate } from "../middleware/auth.js";

const r = Router();

const pub = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  username: u.username || null,
  role: u.role,
});

// --------------------------------------------------
// VALIDATORS
// --------------------------------------------------

const strictEmail = z
  .string()
  .trim()
  .regex(
    /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
    "Enter a valid email address"
  );

const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must contain at least 3 characters")
  .max(30, "Username cannot exceed 30 characters")
  .regex(
    /^[a-zA-Z0-9._-]+$/,
    "Username can contain letters, numbers, dots, underscores and hyphens only"
  );

const strongPassword = z
  .string()
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#^()_\-+=])[A-Za-z\d@$!%*?&#^()_\-+=]{8,}$/,
    "Password must be 8+ characters with uppercase, lowercase, number, and special character"
  );

const indianPhone = z
  .string()
  .trim()
  .regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number");

const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

// --------------------------------------------------
// ROLE VALIDATION
// --------------------------------------------------

function roleMatches(expectedRole, actualRole) {
  if (!expectedRole) return true;

  // Admin panel supports Admin and Manager accounts.
  if (expectedRole === "ADMIN") {
    return actualRole === "ADMIN" || actualRole === "MANAGER";
  }

  // Sales Person panel supports Sales Staff only.
  if (expectedRole === "SALES_STAFF") {
    return actualRole === "SALES_STAFF";
  }

  return false;
}

function roleMismatchMessage(actualRole) {
  if (actualRole === "ADMIN" || actualRole === "MANAGER") {
    return "This is an Admin account. Please use the Admin login panel.";
  }

  return "This is a Sales Person account. Please use the Sales Person login panel.";
}

// --------------------------------------------------
// OTP STORE
// email -> { otpHash, expiresAt, verified, attempts }
// --------------------------------------------------

const otpStore = new Map();

async function sendOtpEmail(toEmail, userName, otp) {
  const htmlContent = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e1e6dc;border-radius:12px;">
      <h2 style="color:#0F1B3D;margin:0 0 8px;">Password Reset Request</h2>

      <p style="color:#5B6580;font-size:14px;">
        Hi ${userName || "User"}, use the OTP below to reset your Neo Solaris CRM password. It expires in 10 minutes.
      </p>

      <div style="margin:20px 0;padding:14px;background:#F4F6F1;border-radius:10px;text-align:center;font-size:28px;font-weight:bold;letter-spacing:6px;color:#3A7D1F;">
        ${otp}
      </div>

      <p style="color:#8A93A8;font-size:12px;">
        If you did not request this, you can safely ignore this email.
      </p>
    </div>
  `;

  if (process.env.BREVO_API_KEY) {
    const response = await fetch(
      "https://api.brevo.com/v3/smtp/email",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "api-key": process.env.BREVO_API_KEY,
        },
        body: JSON.stringify({
          sender: {
            name: "Neo Solaris CRM",
            email:
              process.env.SMTP_USER ||
              "techvoicewebsitedevelopment@gmail.com",
          },
          to: [{ email: toEmail, name: userName || toEmail }],
          subject: "Neo Solaris CRM — Password Reset OTP",
          htmlContent,
        }),
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      console.error("Brevo API Error:", errorBody);

      throw new ApiError(
        502,
        "Failed to send OTP email. Please try again."
      );
    }

    return;
  }

  // Development fallback only.
  console.log(
    `\n[DEV OTP] Password reset OTP for ${toEmail}: ${otp}\n`
  );
}

// --------------------------------------------------
// 1. LOGIN
// Supports email OR username + password.
// Backward compatible with the old { email, password }.
// --------------------------------------------------

r.post(
  "/login",
  loginRateLimit,
  wrap(async (req, res) => {
    const body = parse(
      z.object({
        identifier: z.string().trim().min(1).optional(),
        email: z.string().trim().min(1).optional(),
        password: z.string().min(1),
        expectedRole: z.enum(["ADMIN", "SALES_STAFF"]).optional(),
      }).refine(
        (data) => data.identifier || data.email,
        {
          message: "Enter your username or email address",
          path: ["identifier"],
        }
      ),
      req.body
    );

    const identifier = (body.identifier || body.email).trim().toLowerCase();

    const u = await prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier },
          { username: identifier },
        ],
        isActive: true,
        deletedAt: null,
      },
    });

    if (!u || !(await bcrypt.compare(body.password, u.passwordHash))) {
      throw new ApiError(401, "Username, email or password is incorrect");
    }

    if (!roleMatches(body.expectedRole, u.role)) {
      throw new ApiError(403, roleMismatchMessage(u.role));
    }

    await prisma.auditLog.create({
      data: {
        userId: u.id,
        action: "auth.login",
        entity: "user",
        entityId: u.id,
      },
    });

    ok(res, {
      token: signToken(u),
      user: pub(u),
    });
  })
);

// --------------------------------------------------
// 2. PUBLIC REGISTRATION DISABLED
// Accounts must be created through protected users API.
// --------------------------------------------------

r.post(
  "/register",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
  }),
  (req, res) => {
    throw new ApiError(
      403,
      "Public registration is disabled. Please contact your CRM Administrator."
    );
  }
);

// --------------------------------------------------
// 3. FORGOT PASSWORD - SEND OTP
// --------------------------------------------------

r.post(
  "/forgot-password",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
  }),
  wrap(async (req, res) => {
    const { email, role } = parse(
      z.object({
        email: strictEmail,
        role: z.enum(["ADMIN", "MANAGER", "SALES_STAFF"]).optional(),
      }),
      req.body
    );

    const normalizedEmail = email.toLowerCase();

    const u = await prisma.user.findFirst({
      where: {
        email: normalizedEmail,
        isActive: true,
        deletedAt: null,
      },
    });

    if (!u) {
      throw new ApiError(
        404,
        "No active account found with this email"
      );
    }

    // Admin tab supports both ADMIN and MANAGER.
    if (role && !roleMatches(role, u.role)) {
      throw new ApiError(
        400,
        roleMismatchMessage(u.role)
      );
    }

    const otp = String(crypto.randomInt(100000, 1000000));
    const otpHash = await bcrypt.hash(otp, 10);

    otpStore.set(normalizedEmail, {
      otpHash,
      expiresAt: Date.now() + 10 * 60 * 1000,
      verified: false,
      attempts: 0,
    });

    await sendOtpEmail(normalizedEmail, u.name, otp);

    ok(res, {
      sent: true,
      message: "6-digit OTP sent to your email",
    });
  })
);

// --------------------------------------------------
// 4. VERIFY OTP
// --------------------------------------------------

r.post(
  "/verify-otp",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
  }),
  wrap(async (req, res) => {
    const { email, otp } = parse(
      z.object({
        email: strictEmail,
        otp: z.string().trim().regex(/^\d{6}$/, "OTP must be 6 digits"),
      }),
      req.body
    );

    const normalizedEmail = email.toLowerCase();
    const record = otpStore.get(normalizedEmail);

    if (!record) {
      throw new ApiError(
        400,
        "No OTP requested or OTP expired. Please request a new one."
      );
    }

    if (Date.now() > record.expiresAt) {
      otpStore.delete(normalizedEmail);

      throw new ApiError(
        400,
        "OTP has expired. Please request a new one."
      );
    }

    if (record.attempts >= 5) {
      otpStore.delete(normalizedEmail);

      throw new ApiError(
        429,
        "Too many invalid attempts. Request a new OTP."
      );
    }

    const valid = await bcrypt.compare(otp, record.otpHash);

    if (!valid) {
      record.attempts += 1;

      throw new ApiError(
        400,
        "Invalid OTP. Please check and try again."
      );
    }

    record.verified = true;

    ok(res, {
      verified: true,
    });
  })
);

// --------------------------------------------------
// 5. RESET PASSWORD
// --------------------------------------------------

r.post(
  "/reset-password",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 15,
  }),
  wrap(async (req, res) => {
    const { email, otp, newPassword } = parse(
      z.object({
        email: strictEmail,
        otp: z.string().trim().regex(/^\d{6}$/, "OTP must be 6 digits"),
        newPassword: strongPassword,
      }),
      req.body
    );

    const normalizedEmail = email.toLowerCase();
    const record = otpStore.get(normalizedEmail);

    if (
      !record ||
      !record.verified ||
      Date.now() > record.expiresAt
    ) {
      throw new ApiError(
        400,
        "OTP session expired. Please verify OTP again."
      );
    }

    const valid = await bcrypt.compare(otp, record.otpHash);

    if (!valid) {
      throw new ApiError(400, "Invalid OTP");
    }

    const u = await prisma.user.findFirst({
      where: {
        email: normalizedEmail,
        isActive: true,
        deletedAt: null,
      },
    });

    if (!u) {
      throw new ApiError(404, "User not found");
    }

    await prisma.user.update({
      where: { id: u.id },
      data: {
        passwordHash: await bcrypt.hash(newPassword, 12),
        refreshTokenHash: null,
      },
    });

    otpStore.delete(normalizedEmail);

    await prisma.auditLog.create({
      data: {
        userId: u.id,
        action: "auth.password_reset",
        entity: "user",
        entityId: u.id,
      },
    });

    ok(res, {
      reset: true,
    });
  })
);

// --------------------------------------------------
// 6. CURRENT USER
// --------------------------------------------------

r.get(
  "/me",
  authenticate,
  (req, res) => ok(res, pub(req.user))
);

// --------------------------------------------------
// 7. LOGOUT
// --------------------------------------------------

r.post(
  "/logout",
  authenticate,
  wrap(async (req, res) => {
    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: "auth.logout",
        entity: "user",
        entityId: req.user.id,
      },
    });

    ok(res, {
      loggedOut: true,
    });
  })
);

// --------------------------------------------------
// 8. CHANGE PASSWORD
// --------------------------------------------------

r.post(
  "/password",
  authenticate,
  wrap(async (req, res) => {
    const { current, next } = parse(
      z.object({
        current: z.string().min(1),
        next: strongPassword,
      }),
      req.body
    );

    if (!(await bcrypt.compare(current, req.user.passwordHash))) {
      throw new ApiError(
        400,
        "Current password is incorrect"
      );
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        passwordHash: await bcrypt.hash(next, 12),
        refreshTokenHash: null,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: "auth.password_change",
        entity: "user",
        entityId: req.user.id,
      },
    });

    ok(res, {
      updated: true,
    });
  })
);

export default r;
