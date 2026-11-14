import { prisma } from "../config/db.js";
import { emitTo } from "../socket/index.js";

// Simple in-process reminder job (no Redis needed). Runs on a persistent Node process only.
export function startJobs() {
  const runCheck = async () => {
    try {
      const now = new Date();
      const fifteenMinsAhead = new Date(now.getTime() + 15 * 60_000);

      // 1. Send 15-minute advance reminders for upcoming PENDING follow-ups
      const upcoming = await prisma.followup.findMany({
        where: {
          status: "PENDING",
          reminderSentAt: null,
          dueAt: { gte: now, lte: fifteenMinsAhead },
        },
        include: {
          lead: { select: { id: true, customerName: true, phone: true } },
        },
      });

      if (upcoming.length > 0) {
        await prisma.followup.updateMany({
          where: { id: { in: upcoming.map((u) => u.id) } },
          data: { reminderSentAt: now },
        });

        for (const u of upcoming) {
          emitTo(`user:${u.staffId}`, "followup:reminder", {
            followupId: u.id,
            leadId: u.leadId,
            customerName: u.lead?.customerName || "Customer",
            phone: u.lead?.phone || "",
            dueAt: u.dueAt,
            type: u.type,
            note: u.note || "",
          });
        }
      }

      // 2. Mark past-due PENDING follow-ups as OVERDUE and alert staff
      const due = await prisma.followup.findMany({
        where: { status: "PENDING", dueAt: { lt: now } },
        include: {
          lead: { select: { id: true, customerName: true, phone: true } },
        },
      });

      if (due.length > 0) {
        await prisma.followup.updateMany({
          where: { id: { in: due.map((d) => d.id) } },
          data: { status: "OVERDUE" },
        });

        for (const d of due) {
          emitTo(`user:${d.staffId}`, "followup:overdue", {
            followupId: d.id,
            leadId: d.leadId,
            customerName: d.lead?.customerName || "Customer",
            phone: d.lead?.phone || "",
            dueAt: d.dueAt,
            type: d.type,
            note: d.note || "",
          });
        }
      }
    } catch (e) {
      console.error("followup job failed", e.message);
    }
  };

  // Run once immediately on server startup, then every 60 seconds
  runCheck();
  setInterval(runCheck, 60_000).unref();
}