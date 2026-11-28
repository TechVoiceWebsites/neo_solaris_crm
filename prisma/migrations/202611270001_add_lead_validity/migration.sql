-- Add a separate shared validity classification without changing pipeline outcome.
CREATE TYPE "LeadValidity" AS ENUM ('PENDING', 'VALID', 'INVALID');

ALTER TABLE "leads"
ADD COLUMN "validity_status" "LeadValidity" NOT NULL DEFAULT 'PENDING';

CREATE INDEX "leads_validity_status_created_at_idx"
ON "leads"("validity_status", "created_at");
