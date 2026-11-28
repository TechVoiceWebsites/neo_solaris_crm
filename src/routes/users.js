
import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";

import { prisma } from "../config/db.js";
import { wrap, ok, parse, ApiError } from "../utils/http.js";
import {
  requireRole,
  invalidateUserCache,
} from "../middleware/auth.js";
import { audit } from "../services/leadService.js";

const r = Router();

// --------------------------------------------------
// USER RESPONSE FIELDS
// --------------------------------------------------

const select = {
  id: true,
  name: true,
  email: true,
  username: true,
  role: true,
  isActive: true,
  createdAt: true,
  profile: {
    select: {
      phone: true,
      teamName: true,
      managerId: true,
    },
  },
};

// --------------------------------------------------
// VALIDATORS
// --------------------------------------------------

const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must contain at least 3 characters")
  .max(30, "Username cannot exceed 30 characters")
  .regex(
    /^[a-zA-Z0-9._-]+$/,
    "Username can contain letters, numbers, dots, underscores and hyphens only"
  );

const emailSchema = z
  .string()
  .trim()
  .email("Enter a valid email address");

const passwordSchema = z
  .string()
  .min(8, "Password must contain at least 8 characters");

// --------------------------------------------------
// 1. GET ALL USERS
// ADMIN / MANAGER
// --------------------------------------------------

r.get(
  "/",
  requireRole("ADMIN", "MANAGER"),
  wrap(async (req, res) => {
    const where = {
      deletedAt: null,

      ...(req.user.role === "MANAGER" && {
        OR: [
          { id: req.user.id },
          {
            profile: {
              manager: {
                userId: req.user.id,
              },
            },
          },
        ],
      }),
    };

    const users = await prisma.user.findMany({
      where,
      select,
      orderBy: {
        name: "asc",
      },
    });

    ok(res, users);
  })
);

// --------------------------------------------------
// 2. CREATE USER
// ADMIN ONLY
// --------------------------------------------------

const createBody = z.object({
  name: z.string().trim().min(2),
  username: usernameSchema,
  email: emailSchema,
  role: z.enum(["ADMIN", "MANAGER", "SALES_STAFF"]),
  password: passwordSchema,
  phone: z.string().trim().optional(),
  teamName: z.string().trim().optional(),
  managerUserId: z.string().uuid().optional(),
});

r.post(
  "/",
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    const d = parse(createBody, req.body);

    const normalizedEmail = d.email.toLowerCase();
    const normalizedUsername = d.username.toLowerCase();

    // Check duplicate email and username
    const [emailExists, usernameExists] = await Promise.all([
      prisma.user.findUnique({
        where: {
          email: normalizedEmail,
        },
        select: {
          id: true,
        },
      }),

      prisma.user.findUnique({
        where: {
          username: normalizedUsername,
        },
        select: {
          id: true,
        },
      }),
    ]);

    if (emailExists) {
      throw new ApiError(
        409,
        "An account with this email already exists"
      );
    }

    if (usernameExists) {
      throw new ApiError(
        409,
        "This username is already taken. Please choose another username."
      );
    }

    // Validate Manager assignment
    let managerProfile = null;

    if (d.managerUserId) {
      const manager = await prisma.user.findFirst({
        where: {
          id: d.managerUserId,
          role: "MANAGER",
          isActive: true,
          deletedAt: null,
        },
        include: {
          profile: true,
        },
      });

      if (!manager || !manager.profile) {
        throw new ApiError(
          400,
          "Selected Manager account is invalid or inactive"
        );
      }

      managerProfile = manager.profile;
    }

    const passwordHash = await bcrypt.hash(d.password, 12);

    const created = await prisma.user.create({
      data: {
        name: d.name,
        username: normalizedUsername,
        email: normalizedEmail,
        role: d.role,
        passwordHash,
        isActive: true,

        profile: {
          create: {
            phone: d.phone || null,
            teamName:
              d.teamName ||
              (d.role === "SALES_STAFF"
                ? "Sales Team"
                : "Administration"),
            managerId: managerProfile?.id || null,
          },
        },
      },
      select,
    });

    await audit(
      prisma,
      req.user.id,
      "user.create",
      "user",
      created.id,
      {
        name: created.name,
        username: created.username,
        role: created.role,
      }
    );

    ok(res, created, undefined, 201);
  })
);

// --------------------------------------------------
// 3. UPDATE USER
// ADMIN ONLY
// --------------------------------------------------

const updateBody = z.object({
  name: z.string().trim().min(2).optional(),

  username: usernameSchema.optional(),

  email: emailSchema.optional(),

  role: z.enum(["ADMIN", "MANAGER", "SALES_STAFF"]).optional(),

  phone: z.string().trim().nullable().optional(),

  teamName: z.string().trim().nullable().optional(),

  managerUserId: z.string().uuid().nullable().optional(),

  password: passwordSchema.optional(),

  isActive: z.boolean().optional(),
});

r.patch(
  "/:id",
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    const d = parse(updateBody, req.body);
    const userId = req.params.id;

    if (userId === req.user.id && d.isActive === false) {
      throw new ApiError(
        400,
        "You cannot deactivate your own account"
      );
    }

    if (userId === req.user.id && d.role && d.role !== "ADMIN") {
      throw new ApiError(
        400,
        "You cannot change your own Admin role"
      );
    }

    const target = await prisma.user.findFirst({
      where: {
        id: userId,
        deletedAt: null,
      },
    });

    if (!target) {
      throw new ApiError(404, "Staff member not found");
    }

    const normalizedEmail =
      d.email !== undefined
        ? d.email.toLowerCase()
        : undefined;

    const normalizedUsername =
      d.username !== undefined
        ? d.username.toLowerCase()
        : undefined;

    // Check duplicate email
    if (
      normalizedEmail &&
      normalizedEmail !== target.email
    ) {
      const duplicateEmail = await prisma.user.findUnique({
        where: {
          email: normalizedEmail,
        },
        select: {
          id: true,
        },
      });

      if (duplicateEmail && duplicateEmail.id !== target.id) {
        throw new ApiError(
          409,
          "Another account already uses this email"
        );
      }
    }

    // Check duplicate username
    if (
      normalizedUsername &&
      normalizedUsername !== target.username
    ) {
      const duplicateUsername = await prisma.user.findUnique({
        where: {
          username: normalizedUsername,
        },
        select: {
          id: true,
        },
      });

      if (
        duplicateUsername &&
        duplicateUsername.id !== target.id
      ) {
        throw new ApiError(
          409,
          "This username is already taken"
        );
      }
    }

    // Validate Manager assignment
    let managerProfile = undefined;

    if (d.managerUserId !== undefined) {
      if (d.managerUserId === null) {
        managerProfile = null;
      } else {
        const manager = await prisma.user.findFirst({
          where: {
            id: d.managerUserId,
            role: "MANAGER",
            isActive: true,
            deletedAt: null,
          },
          include: {
            profile: true,
          },
        });

        if (!manager || !manager.profile) {
          throw new ApiError(
            400,
            "Selected Manager account is invalid or inactive"
          );
        }

        managerProfile = manager.profile.id;
      }
    }

    const data = {
      ...(d.name !== undefined && {
        name: d.name,
      }),

      ...(normalizedEmail !== undefined && {
        email: normalizedEmail,
      }),

      ...(normalizedUsername !== undefined && {
        username: normalizedUsername,
      }),

      ...(d.role !== undefined && {
        role: d.role,
      }),

      ...(d.isActive !== undefined && {
        isActive: d.isActive,
      }),

      ...(d.password && {
        passwordHash: await bcrypt.hash(d.password, 12),
        refreshTokenHash: null,
      }),

      ...((d.phone !== undefined ||
        d.teamName !== undefined ||
        managerProfile !== undefined) && {
        profile: {
          upsert: {
            create: {
              phone: d.phone || null,
              teamName: d.teamName || null,
              managerId:
                managerProfile === undefined
                  ? null
                  : managerProfile,
            },

            update: {
              ...(d.phone !== undefined && {
                phone: d.phone,
              }),

              ...(d.teamName !== undefined && {
                teamName: d.teamName,
              }),

              ...(managerProfile !== undefined && {
                managerId: managerProfile,
              }),
            },
          },
        },
      }),
    };

    const updated = await prisma.user.update({
      where: {
        id: userId,
      },
      data,
      select,
    });

    // Immediately invalidate cached authentication user
    invalidateUserCache(userId);

    await audit(
      prisma,
      req.user.id,
      "user.update",
      "user",
      updated.id,
      {
        name: d.name,
        email: normalizedEmail,
        username: normalizedUsername,
        role: d.role,
        isActive: d.isActive,
      }
    );

    ok(res, updated);
  })
);

// --------------------------------------------------
// 4. DELETE USER
// ADMIN ONLY - SOFT DELETE
// --------------------------------------------------

r.delete(
  "/:id",
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    const userId = req.params.id;

    if (userId === req.user.id) {
      throw new ApiError(
        400,
        "You cannot delete your own account"
      );
    }

    const target = await prisma.user.findFirst({
      where: {
        id: userId,
        deletedAt: null,
      },
    });

    if (!target) {
      throw new ApiError(404, "Staff member not found");
    }

    const deletedSuffix = Date.now();

    await prisma.$transaction(
      async (tx) => {
        await tx.lead.updateMany({
          where: {
            currentOwnerId: target.id,
            status: "OPEN",
          },
          data: {
            currentOwnerId: null,
          },
        });

        await tx.user.update({
          where: {
            id: target.id,
          },
          data: {
            isActive: false,
            deletedAt: new Date(),

            email: `${target.email}.deleted.${deletedSuffix}`,

            username: target.username
              ? `${target.username}.deleted.${deletedSuffix}`
              : null,

            refreshTokenHash: null,
          },
        });

        await audit(
          tx,
          req.user.id,
          "user.delete",
          "user",
          target.id,
          {
            name: target.name,
            username: target.username,
          }
        );
      },
      {
        timeout: 15000,
        maxWait: 10000,
      }
    );

    // Clear cached user immediately
    invalidateUserCache(userId);

    ok(res, {
      deleted: true,
    });
  })
);

export default r;
