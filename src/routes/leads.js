import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import { prisma } from "../config/db.js";
import { wrap, ok, parse, page, ApiError } from "../utils/http.js";
import { requireRole } from "../middleware/auth.js";
import { leadScope, getLeadOr404 } from "../services/scope.js";
import {
  createLead,
  leadInput,
  audit,
  normPhone,
  autoAllocateIfEnabled,
} from "../services/leadService.js";
import { emitLead } from "../socket/index.js";

const r = Router();

// Supabase Private Storage - Quotation PDFs

const QUOTATION_BUCKET = "quotation-pdfs";
const MAX_PDF_SIZE = 10 * 1024 * 1024;

let supabaseStorage = null;

function getSupabaseStorage() {
  if (supabaseStorage) return supabaseStorage;

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new ApiError(500, "Supabase Storage configuration is missing");
  }

  supabaseStorage = createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return supabaseStorage;
}

const quotationUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_PDF_SIZE,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype !== "application/pdf" ||
      !file.originalname.toLowerCase().endsWith(".pdf")
    ) {
      return cb(new ApiError(400, "Only PDF files are allowed"));
    }

    cb(null, true);
  },
});

const handleQuotationUpload = (req, res, next) => {
  quotationUpload.single("file")(req, res, (error) => {
    if (!error) return next();

    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return next(new ApiError(400, "PDF size must not exceed 10 MB"));
      }

      return next(new ApiError(400, error.message));
    }

    next(error);
  });
};

// Lightweight in-memory caches

const USER_CACHE_TTL = 2 * 60_000;
const LIST_CACHE_TTL = 10_000;

let userMapCache = null;
const listCache = new Map();

const invalidateLeadCaches = () => {
  listCache.clear();
};

async function getUserMap(ids) {
  const now = Date.now();

  if (
    !userMapCache ||
    now - userMapCache.at > USER_CACHE_TTL ||
    ids.some((id) => !userMapCache.map.has(id))
  ) {
    const users = await prisma.user.findMany({
      select: { id: true, name: true },
    });

    userMapCache = {
      map: new Map(users.map((u) => [u.id, u])),
      at: now,
    };
  }

  return userMapCache.map;
}

const withOwner = async (rows) => {
  const ids = [
    ...new Set(rows.map((l) => l.currentOwnerId).filter(Boolean)),
  ];

  if (!ids.length) {
    return rows.map((l) => ({ ...l, owner: null }));
  }

  const m = await getUserMap(ids);

  return rows.map((l) => ({
    ...l,
    owner: m.get(l.currentOwnerId) ?? null,
  }));
};

// Lead List Select

const leadListSelect = {
  id: true,
  customerName: true,
  phone: true,
  email: true,
  company: true,
  city: true,
  requirement: true,
  priority: true,
  status: true,
  validityStatus: true,
  estimatedValue: true,
  stageDetails: true,
  nextFollowupAt: true,
  stageId: true,
  sourceId: true,
  currentOwnerId: true,
  createdAt: true,
  updatedAt: true,

  source: {
    select: {
      id: true,
      name: true,
    },
  },

  stage: {
    select: {
      id: true,
      name: true,
      position: true,
      isWon: true,
      isLost: true,
    },
  },
};

// Lead List Query

const listQuery = async (req, extra = {}, cacheTag = "all") => {
  const cacheKey = `${cacheTag}|${req.user.id}|${req.user.role}|${JSON.stringify(req.query)}`;

  if (req.query.fresh !== "1") {
    const hit = listCache.get(cacheKey);

    if (hit && Date.now() - hit.at < LIST_CACHE_TTL) {
      return {
        rows: hit.rows,
        meta: hit.meta,
      };
    }
  }

  const {
    q,
    sourceId,
    stageId,
    status,
    validityStatus,
    priority,
    ownerId,
  } = req.query;

  if (validityStatus && !["PENDING", "VALID", "INVALID"].includes(validityStatus)) {
    throw new ApiError(400, "Invalid lead validity status");
  }

  const where = {
    ...(await leadScope(req.user)),
    ...extra,
    ...(sourceId && { sourceId }),
    ...(stageId && { stageId }),
    ...(status && { status }),
    ...(validityStatus && { validityStatus }),
    ...(priority && { priority }),
    ...(ownerId && { currentOwnerId: ownerId }),

    ...(q && {
      OR: [
        {
          customerName: {
            contains: q,
            mode: "insensitive",
          },
        },
        {
          company: {
            contains: q,
            mode: "insensitive",
          },
        },
        {
          phone: {
            contains: String(q).replace(/\D/g, "") || "~~",
          },
        },
      ],
    }),
  };

  const { skip, take, p, size } = page(req.query);

  const sortBy = [
    "createdAt",
    "updatedAt",
    "customerName",
    "nextFollowupAt",
  ].includes(req.query.sortBy)
    ? req.query.sortBy
    : "createdAt";

  const [rows, total] = await Promise.all([
    prisma.lead.findMany({
      where,
      skip,
      take,
      orderBy: {
        [sortBy]: req.query.order === "asc" ? "asc" : "desc",
      },
      select: leadListSelect,
    }),

    prisma.lead.count({ where }),
  ]);

  const enriched = await withOwner(rows);

  const meta = {
    page: p,
    pageSize: size,
    total,
  };

  listCache.set(cacheKey, {
    rows: enriched,
    meta,
    at: Date.now(),
  });

  return {
    rows: enriched,
    meta,
  };
};

// GET Leads

r.get("/", wrap(async (req, res) => {
  const { rows, meta } = await listQuery(req, {}, "all");
  ok(res, rows, meta);
}));

// GET My Leads

r.get("/my-leads", wrap(async (req, res) => {
  const { rows, meta } = await listQuery(
    req,
    { currentOwnerId: req.user.id },
    "mine"
  );

  ok(res, rows, meta);
}));

// GET Unassigned Leads

r.get(
  "/unassigned",
  requireRole("ADMIN", "MANAGER"),
  wrap(async (req, res) => {
    const cacheKey = `unassigned|${JSON.stringify(req.query)}`;

    if (req.query.fresh !== "1") {
      const hit = listCache.get(cacheKey);

      if (hit && Date.now() - hit.at < LIST_CACHE_TTL) {
        return ok(res, hit.rows, hit.meta);
      }
    }

    const where = {
      deletedAt: null,
      currentOwnerId: null,
      status: "OPEN",
    };

    const { skip, take, p, size } = page(req.query);

    const [rows, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" },
        select: leadListSelect,
      }),

      prisma.lead.count({ where }),
    ]);

    const meta = {
      page: p,
      pageSize: size,
      total,
    };

    listCache.set(cacheKey, {
      rows,
      meta,
      at: Date.now(),
    });

    ok(res, rows, meta);
  })
);

// CREATE Lead
// Admin-created leads must be assigned to the Sales Person selected by Admin.
// Sales Staff self-created leads remain assigned to their creator.
// Other creation paths retain their existing allocation behaviour.

const createLeadBody = leadInput.extend({
  assigneeId: z.string().uuid().optional(),
});

r.post("/", wrap(async (req, res) => {
  const d = parse(createLeadBody, req.body);

  let assignment = null;

  if (req.user.role === "ADMIN") {
    if (!d.assigneeId) {
      throw new ApiError(422, "Please select a Sales Person for this lead");
    }

    const selectedStaff = await prisma.user.findFirst({
      where: {
        id: d.assigneeId,
        role: "SALES_STAFF",
        isActive: true,
        deletedAt: null,
      },
      select: { id: true },
    });

    if (!selectedStaff) {
      throw new ApiError(400, "Selected Sales Person is invalid or inactive");
    }

    assignment = {
      assigneeId: selectedStaff.id,
      assignedById: req.user.id,
      note: "Admin manual assignment",
    };
  } else if (req.user.role === "SALES_STAFF") {
    assignment = {
      assigneeId: req.user.id,
      assignedById: req.user.id,
      note: "Self-created",
    };
  }

  const { lead, duplicate } = await createLead({
    data: d,
    sourceCode: "DIRECT",
    createdById: req.user.id,
    assignment,
  });

  if (duplicate) {
    throw new ApiError(
      409,
      "A lead with this phone number is already open",
      { leadId: lead.id }
    );
  }

  // Admin and Sales Staff assignments are committed with lead creation.
  // Manager-created leads retain the existing optional auto-allocation behaviour.
  const final = assignment ? lead : await autoAllocateIfEnabled(lead);

  invalidateLeadCaches();

  await emitLead("lead:new", final);

  ok(res, final, undefined, 201);
}));
// FULL Lead Detail + Complete Staff Activity Timeline

r.get("/:id", wrap(async (req, res) => {
  const lead = await getLeadOr404(req.user, req.params.id);

  const full = await prisma.lead.findUnique({
    where: { id: lead.id },

    include: {
      source: true,
      stage: true,

      assignments: {
        orderBy: { assignedAt: "desc" },

        include: {
          assignedTo: {
            select: { id: true, name: true },
          },

          assignedBy: {
            select: { id: true, name: true },
          },
        },
      },

      followups: {
        orderBy: { dueAt: "desc" },

        include: {
          staff: {
            select: { id: true, name: true },
          },
        },
      },

      calls: {
        orderBy: { calledAt: "desc" },

        include: {
          staff: {
            select: { id: true, name: true },
          },
        },
      },

      stageHistory: {
        orderBy: { changedAt: "desc" },

        include: {
          fromStage: {
            select: { id: true, name: true },
          },

          toStage: {
            select: { id: true, name: true },
          },

          changedBy: {
            select: { id: true, name: true },
          },
        },
      },

      quotations: true,
      orders: true,
    },
  });

  const activityFeed = [
    ...full.assignments.map((a) => ({
      id: `assign_${a.id}`,
      kind: "ASSIGNMENT",
      at: a.assignedAt,
      actor: a.assignedBy?.name || "System",
      summary: `Assigned to ${a.assignedTo?.name || "Staff"}`,
      note: a.note || "",
    })),

    ...full.calls.map((c) => ({
      id: `call_${c.id}`,
      kind: c.type,
      at: c.calledAt,
      actor: c.staff?.name || "Staff",
      summary: `${c.type}${c.outcome ? ` (${c.outcome.replace(/_/g, " ")})` : ""}`,
      note: c.notes || "",
    })),

    ...full.stageHistory.map((s) => ({
      id: `stage_${s.id}`,
      kind: "STAGE_CHANGE",
      at: s.changedAt,
      actor: s.changedBy?.name || "Staff",
      summary: `Moved ${s.fromStage?.name ? `from ${s.fromStage.name} ` : ""}to ${s.toStage?.name}`,
      note: s.reason || "",
    })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));

  const enriched = (await withOwner([full]))[0];

  ok(res, {
    ...enriched,
    activityFeed,
  });
}));


// UPDATE shared lead validity (Admin, Manager within scope, or owning Sales Person)
r.patch("/:id/validity", wrap(async (req, res) => {
  const lead = await getLeadOr404(req.user, req.params.id);
  const { validityStatus } = parse(
    z.object({ validityStatus: z.enum(["PENDING", "VALID", "INVALID"]) }),
    req.body
  );

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.lead.update({
      where: { id: lead.id },
      data: { validityStatus },
    });

    await audit(
      tx,
      req.user.id,
      "lead.validity.update",
      "lead",
      lead.id,
      { from: lead.validityStatus ?? "PENDING", to: validityStatus }
    );

    return row;
  });

  invalidateLeadCaches();
  try {
    await emitLead("lead:updated", updated);
  } catch (socketError) {
    console.error("Lead validity saved, but update event failed:", socketError?.message || socketError);
  }

  ok(res, updated);
}));

// UPDATE Lead

r.put("/:id", wrap(async (req, res) => {
  const lead = await getLeadOr404(req.user, req.params.id);

  const d = parse(leadInput.partial(), req.body);

  const data = {
    ...d,
    ...(d.phone && { phone: normPhone(d.phone) }),
    email: d.email || undefined,
  };

  const up = await prisma.$transaction(async (tx) => {
    const u = await tx.lead.update({
      where: { id: lead.id },
      data,
    });

    await audit(
      tx,
      req.user.id,
      "lead.update",
      "lead",
      lead.id,
      { fields: Object.keys(d) }
    );

    return u;
  });

  invalidateLeadCaches();

  await emitLead("lead:updated", up);

  ok(res, up);
}));

// DELETE Lead (Admin & Manager only)

r.delete(
  "/:id",
  requireRole("ADMIN", "MANAGER"),
  wrap(async (req, res) => {
    const lead = await getLeadOr404(req.user, req.params.id);

    const [deleted] = await prisma.$transaction([
      prisma.lead.update({
        where: { id: lead.id },
        data: { deletedAt: new Date() },
      }),

      prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "lead.delete",
          entity: "lead",
          entityId: lead.id,
          meta: {
            customerName: lead.customerName,
            phone: lead.phone,
          },
        },
      }),
    ]);

    invalidateLeadCaches();

    await emitLead("lead:deleted", deleted);

    ok(res, {
      id: lead.id,
      deleted: true,
    });
  })
);

// UPLOAD Quotation PDF
// Stores the PDF in the private bucket and saves its path in lead.stageDetails.quotation.

r.post(
  "/:id/quotation-pdf",
  handleQuotationUpload,
  wrap(async (req, res) => {
    const lead = await getLeadOr404(req.user, req.params.id);

    if (!req.file) {
      throw new ApiError(400, "Please select a PDF file");
    }

    const pdfSignature = req.file.buffer.subarray(0, 5).toString();
    if (pdfSignature !== "%PDF-") {
      throw new ApiError(400, "Invalid PDF file");
    }

    const supabase = getSupabaseStorage();
    const filePath = `${lead.id}/${randomUUID()}.pdf`;

    const { error: uploadError } = await supabase.storage
      .from(QUOTATION_BUCKET)
      .upload(filePath, req.file.buffer, {
        contentType: "application/pdf",
        upsert: false,
      });

    if (uploadError) {
      console.error("Quotation PDF upload failed:", uploadError.message);
      throw new ApiError(500, "Quotation PDF upload failed");
    }

    let updatedLead;

    // Only remove the uploaded object if the database write fails.
    // Socket/event failures must never delete a file whose path is already saved.
    try {
      updatedLead = await prisma.$transaction(async (tx) => {
        const current = await tx.lead.findUnique({
          where: { id: lead.id },
          select: { stageDetails: true },
        });

        if (!current) {
          throw new ApiError(404, "Lead not found");
        }

        const currentDetails =
          current.stageDetails &&
          typeof current.stageDetails === "object" &&
          !Array.isArray(current.stageDetails)
            ? current.stageDetails
            : {};

        const currentQuotation =
          currentDetails.quotation &&
          typeof currentDetails.quotation === "object" &&
          !Array.isArray(currentDetails.quotation)
            ? currentDetails.quotation
            : {};

        const updatedDetails = {
          ...currentDetails,
          quotation: {
            ...currentQuotation,
            quotationPdfPath: filePath,
            quotationPdfName: req.file.originalname,
            pdfUploadedAt: new Date().toISOString(),
          },
        };

        return tx.lead.update({
          where: { id: lead.id },
          data: { stageDetails: updatedDetails },
        });
      });
    } catch (error) {
      const { error: cleanupError } = await supabase.storage
        .from(QUOTATION_BUCKET)
        .remove([filePath]);

      if (cleanupError) {
        console.error(
          "Quotation PDF cleanup failed:",
          cleanupError.message || cleanupError
        );
      }

      throw error;
    }

    invalidateLeadCaches();

    try {
      await emitLead("lead:updated", updatedLead);
    } catch (socketError) {
      console.error(
        "Quotation PDF saved, but lead update event failed:",
        socketError?.message || socketError
      );
    }

    ok(
      res,
      {
        quotationPdfPath: filePath,
        quotationPdfName: req.file.originalname,
        message: "Quotation PDF uploaded successfully",
      },
      undefined,
      201
    );
  })
);

// GET Private Quotation PDF Signed URL

r.get(
  "/:id/quotation-pdf",
  wrap(async (req, res) => {
    const lead = await getLeadOr404(req.user, req.params.id);

    const filePath =
      lead.stageDetails?.quotation?.quotationPdfPath;

    if (!filePath) {
      throw new ApiError(404, "Quotation PDF not found");
    }

    if (!filePath.startsWith(`${lead.id}/`)) {
      throw new ApiError(403, "Invalid quotation PDF path");
    }

    const supabase = getSupabaseStorage();

    const { data, error } = await supabase.storage
      .from(QUOTATION_BUCKET)
      .createSignedUrl(filePath, 300);

    if (error || !data?.signedUrl) {
      console.error("Signed URL error:", error?.message);
      throw new ApiError(500, "Could not generate quotation PDF link");
    }

    ok(res, {
      url: data.signedUrl,
      fileName:
        lead.stageDetails?.quotation?.quotationPdfName || "quotation.pdf",
      expiresIn: 300,
    });
  })
);
// PIPELINE STAGE DETAILS VALIDATION

const stageDetailSchemas = {
  discussion: z.object({
    ebBill: z.string().optional(),
    roofArea: z.string().optional(),
    customerBudget: z.string().optional(),
    callNotes: z.string().max(2000).optional(),
  }),

  quotation: z.object({
    systemCapacity: z.string().max(100).optional(),
    quotationAmount: z.string().max(50).optional(),
    quotationPdfPath: z.string().max(500).optional(),
    quotationPdfName: z.string().max(255).optional(),
    validityDate: z.string().max(30).optional(),

    // Generated quotation line items
    items: z.array(
      z.object({
        description: z.string().max(300),
        quantity: z.string().max(30),
        unitPrice: z.string().max(30),
      })
    ).max(100).optional(),

    gstPercent: z.string().max(10).optional(),
    advanceAmount: z.string().max(30).optional(),
    balanceAmount: z.string().max(30).optional(),
    paymentTerms: z.string().max(2000).optional(),
    warrantyDetails: z.string().max(3000).optional(),
  }),

  negotiation: z.object({
    customerFeedback: z.string().max(2000).optional(),
    discount: z.string().optional(),
    revisedAmount: z.string().optional(),
    paymentTerms: z.string().optional(),
  }),

  "order confirmation": z.object({
    orderValue: z.string().optional(),
    advanceAmount: z.string().optional(),
    balanceAmount: z.string().optional(),
    orderDate: z.string().optional(),
  }),

  installation: z.object({
    installationDate: z.string().optional(),
    technicianName: z.string().optional(),
    installationStatus: z.string().optional(),
    notes: z.string().max(2000).optional(),
  }),

  completed: z.object({
    completionDate: z.string().optional(),
    testingStatus: z.string().optional(),
    handoverConfirmation: z.string().optional(),
  }),
};

// Normalize Pipeline Stage Name

const getStageDetailKey = (stage) => {
  const name = stage.name.trim().toLowerCase();

  if (stage.isLost || name === "lost") {
    return "lost";
  }

  if (stage.isWon || name === "completed") {
    return "completed";
  }

  return name;
};

// UPDATE Quotation Details Without Changing Pipeline Stage
// Used when a lead is already in the Quotation stage and the user creates/edits its quotation.
r.put("/:id/quotation-details", wrap(async (req, res) => {
  const lead = await getLeadOr404(req.user, req.params.id);

  const { details } = parse(
    z.object({
      details: z.record(z.unknown()),
    }),
    req.body
  );

  const currentStage = lead.stageId
    ? await prisma.pipelineStage.findUnique({ where: { id: lead.stageId } })
    : null;

  if (!currentStage || getStageDetailKey(currentStage) !== "quotation") {
    throw new ApiError(409, "Quotation details can only be saved while the lead is in the Quotation stage");
  }

  const validatedDetails = parse(stageDetailSchemas.quotation, details);

  const updatedLead = await prisma.$transaction(async (tx) => {
    const current = await tx.lead.findUnique({
      where: { id: lead.id },
      select: { stageDetails: true },
    });

    const existingDetails =
      current?.stageDetails &&
      typeof current.stageDetails === "object" &&
      !Array.isArray(current.stageDetails)
        ? current.stageDetails
        : {};

    const existingQuotation =
      existingDetails.quotation &&
      typeof existingDetails.quotation === "object" &&
      !Array.isArray(existingDetails.quotation)
        ? existingDetails.quotation
        : {};

    const stageDetails = {
      ...existingDetails,
      quotation: {
        ...existingQuotation,
        ...validatedDetails,
        updatedAt: new Date().toISOString(),
        updatedBy: req.user.id,
      },
    };

    const updated = await tx.lead.update({
      where: { id: lead.id },
      data: { stageDetails },
    });

    await audit(
      tx,
      req.user.id,
      "lead.quotation.update",
      "lead",
      lead.id,
      { fields: Object.keys(validatedDetails) }
    );

    return updated;
  });

  invalidateLeadCaches();

  try {
    await emitLead("lead:updated", updatedLead);
  } catch (socketError) {
    console.error("Quotation saved, but lead update event failed:", socketError?.message || socketError);
  }

  ok(res, updatedLead);
}));

// UPDATE Pipeline Stage + Save Stage Details

r.put("/:id/stage", wrap(async (req, res) => {
  const lead = await getLeadOr404(req.user, req.params.id);

  const { stageId, reason, details } = parse(
    z.object({
      stageId: z.string().uuid(),
      reason: z.string().max(300).optional(),
      details: z.record(z.unknown()).optional(),
    }),
    req.body
  );

  const to = await prisma.pipelineStage.findUnique({
    where: { id: stageId },
  });

  if (!to) {
    throw new ApiError(400, "Unknown stage");
  }

  if (to.isLost && !reason) {
    throw new ApiError(
      422,
      "A lost reason is required",
      { reason: ["Required when marking a lead as Lost"] }
    );
  }

  const detailKey = getStageDetailKey(to);
  const detailSchema = stageDetailSchemas[detailKey];

  let validatedDetails = null;

  if (detailSchema) {
    if (!details) {
      throw new ApiError(
        422,
        "Stage details are required",
        { details: ["Please complete the stage form"] }
      );
    }

    validatedDetails = parse(detailSchema, details);
  }

  const up = await prisma.$transaction(async (tx) => {
    const current = await tx.lead.findUnique({
      where: { id: lead.id },
      select: { stageId: true, status: true, stageDetails: true },
    });

    if (!current) {
      throw new ApiError(404, "Lead not found");
    }

    const isSameStage = current.stageId === to.id;
    if (isSameStage && !validatedDetails) {
      throw new ApiError(409, "Lead is already in this stage");
    }

    const existingStageDetails =
      current.stageDetails &&
      typeof current.stageDetails === "object" &&
      !Array.isArray(current.stageDetails)
        ? current.stageDetails
        : {};

    // A lead can move to Completed only after Installation is marked COMPLETED.
    if (to.name.trim().toLowerCase() === "completed") {
      const installationStatus =
        existingStageDetails.installation?.installationStatus;

      if (installationStatus !== "COMPLETED") {
        throw new ApiError(
          422,
          "Installation must be completed before moving this lead to Completed",
          {
            installationStatus: [
              "Please complete the Installation stage first",
            ],
          }
        );
      }
    }

    let stageDetails = { ...existingStageDetails };

    if (validatedDetails) {
      const existingStageEntry =
        existingStageDetails[detailKey] &&
        typeof existingStageDetails[detailKey] === "object" &&
        !Array.isArray(existingStageDetails[detailKey])
          ? existingStageDetails[detailKey]
          : {};

      stageDetails = {
        ...existingStageDetails,
        [detailKey]: {
          ...existingStageEntry,
          ...validatedDetails,
          updatedAt: new Date().toISOString(),
          updatedBy: req.user.id,
        },
      };
    }

    const u = await tx.lead.update({
      where: { id: lead.id },
      data: {
        stageId: to.id,
        status: isSameStage
          ? current.status
          : to.isWon
            ? "WON"
            : to.isLost
              ? "LOST"
              : "OPEN",
        lostReason: to.isLost ? reason : null,
        ...(validatedDetails && { stageDetails }),
      },
    });

    if (!isSameStage) {
      await tx.leadStageHistory.create({
        data: {
          leadId: lead.id,
          fromStageId: current.stageId,
          toStageId: to.id,
          changedById: req.user.id,
          reason,
        },
      });
    }

    await audit(
      tx,
      req.user.id,
      isSameStage ? "lead.stage.details.update" : "lead.stage",
      "lead",
      lead.id,
      {
        to: to.name,
        detailsUpdated: Boolean(validatedDetails),
        sameStage: isSameStage,
      }
    );

    return u;
  });

  invalidateLeadCaches();

  await emitLead("pipeline:updated", up, {
    stageId: to.id,
  });

  ok(res, up);
}));
// GET Lead Stage History

r.get("/:id/stage-history", wrap(async (req, res) => {
  await getLeadOr404(req.user, req.params.id);

  const history = await prisma.leadStageHistory.findMany({
    where: { leadId: req.params.id },

    orderBy: { changedAt: "desc" },

    include: {
      fromStage: true,
      toStage: true,

      changedBy: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  ok(res, history);
}));

// GET Lead Activities

r.get("/:id/activities", wrap(async (req, res) => {
  await getLeadOr404(req.user, req.params.id);

  const activities = await prisma.callActivity.findMany({
    where: { leadId: req.params.id },

    orderBy: { calledAt: "desc" },

    include: {
      staff: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  ok(res, activities);
}));

// CREATE Lead Activity

r.post("/:id/activities", wrap(async (req, res) => {
  const lead = await getLeadOr404(req.user, req.params.id);

  const d = parse(
    z.object({
      type: z.enum([
        "CALL",
        "WHATSAPP",
        "EMAIL",
        "MEETING",
      ]),

      outcome: z.enum([
        "CONNECTED",
        "NOT_REACHABLE",
        "CALL_BACK_LATER",
        "INTERESTED",
        "NOT_INTERESTED",
        "WRONG_NUMBER",
      ]).optional(),

      notes: z.string().max(2000).optional(),
      calledAt: z.coerce.date().optional(),
    }),

    req.body
  );

  const a = await prisma.$transaction(async (tx) => {
    const created = await tx.callActivity.create({
      data: {
        leadId: lead.id,
        staffId: req.user.id,
        calledAt: d.calledAt ?? new Date(),
        type: d.type,
        outcome: d.outcome,
        notes: d.notes,
      },

      include: {
        staff: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    await audit(
      tx,
      req.user.id,
      "lead.activity",
      "lead",
      lead.id,
      {
        type: d.type,
        outcome: d.outcome,
      }
    );

    return created;
  });

  invalidateLeadCaches();

  await emitLead("lead:updated", lead);

  ok(res, a, undefined, 201);
}));

export default r;