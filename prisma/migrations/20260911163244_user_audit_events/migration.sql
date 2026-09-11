-- CreateTable
CREATE TABLE "UserAuditEvent" (
    "id" SERIAL NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "subjectId" INTEGER NOT NULL,
    "actorId" INTEGER NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,

    CONSTRAINT "UserAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserAuditEvent_subjectId_at_idx" ON "UserAuditEvent"("subjectId", "at");

-- CreateIndex
CREATE INDEX "UserAuditEvent_at_idx" ON "UserAuditEvent"("at");

-- AddForeignKey
ALTER TABLE "UserAuditEvent" ADD CONSTRAINT "UserAuditEvent_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAuditEvent" ADD CONSTRAINT "UserAuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
