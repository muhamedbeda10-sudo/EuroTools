-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "firebaseUid" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "employeeNo" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" INTEGER,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "contact" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Material" (
    "id" SERIAL NOT NULL,
    "partNumber" TEXT NOT NULL,
    "materialNumber" TEXT,
    "description" TEXT,
    "spec" TEXT,
    "drawingNumber" TEXT,
    "drawingRev" TEXT,
    "hardnessMin" DOUBLE PRECISION,
    "hardnessMax" DOUBLE PRECISION,
    "hardnessUnit" TEXT NOT NULL DEFAULT 'HRC',
    "surfaceFinishRa" DOUBLE PRECISION,
    "requiredCerts" TEXT,
    "roughingAllowance" DOUBLE PRECISION,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialFeature" (
    "id" SERIAL NOT NULL,
    "materialId" INTEGER NOT NULL,
    "stage" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'DIMENSION',
    "nominal" DOUBLE PRECISION,
    "tolMinus" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tolPlus" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT 'mm',
    "critical" BOOLEAN NOT NULL DEFAULT false,
    "gdtSymbol" TEXT,
    "gdtLimit" DOUBLE PRECISION,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MaterialFeature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lot" (
    "id" SERIAL NOT NULL,
    "lotNumber" TEXT NOT NULL,
    "materialId" INTEGER NOT NULL,
    "supplierId" INTEGER,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "poNumber" TEXT,
    "heatNumber" TEXT,
    "receivedQty" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Certificate" (
    "id" SERIAL NOT NULL,
    "lotId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "number" TEXT,
    "issuedAt" TIMESTAMPTZ(3),
    "received" BOOLEAN NOT NULL DEFAULT false,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,

    CONSTRAINT "Certificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Analysis" (
    "id" SERIAL NOT NULL,
    "lotId" INTEGER NOT NULL,
    "sampleRef" TEXT NOT NULL,
    "method" TEXT,
    "performedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "performedBy" TEXT,
    "recordedById" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "conclusion" TEXT,
    "actionTaken" TEXT,

    CONSTRAINT "Analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisResult" (
    "id" SERIAL NOT NULL,
    "analysisId" INTEGER NOT NULL,
    "property" TEXT NOT NULL,
    "requiredMin" DOUBLE PRECISION,
    "requiredMax" DOUBLE PRECISION,
    "requiredText" TEXT,
    "actual" DOUBLE PRECISION,
    "actualText" TEXT,
    "unit" TEXT,
    "pass" BOOLEAN,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AnalysisResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Part" (
    "id" SERIAL NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "materialId" INTEGER NOT NULL,
    "lotId" INTEGER,
    "batchQty" INTEGER NOT NULL DEFAULT 1,
    "currentStage" TEXT NOT NULL DEFAULT 'POST_ROUGHING',
    "status" TEXT NOT NULL DEFAULT 'IN_PROCESS',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Part_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartEvent" (
    "id" SERIAL NOT NULL,
    "partId" INTEGER NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "stage" TEXT,
    "fromValue" TEXT,
    "toValue" TEXT,
    "note" TEXT,
    "actorId" INTEGER NOT NULL,
    "actor" TEXT NOT NULL,

    CONSTRAINT "PartEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inspection" (
    "id" SERIAL NOT NULL,
    "stage" TEXT NOT NULL,
    "partId" INTEGER,
    "lotId" INTEGER,
    "inspectorId" INTEGER NOT NULL,
    "inspector" TEXT NOT NULL,
    "inspectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "hardnessValue" DOUBLE PRECISION,
    "hardnessUnit" TEXT,
    "hardnessMin" DOUBLE PRECISION,
    "hardnessMax" DOUBLE PRECISION,
    "surfaceFinishRa" DOUBLE PRECISION,
    "cmmRequired" BOOLEAN NOT NULL DEFAULT false,
    "cmmReportRef" TEXT,
    "cmmReviewed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Inspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckResult" (
    "id" SERIAL NOT NULL,
    "inspectionId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "ok" BOOLEAN,
    "note" TEXT,

    CONSTRAINT "CheckResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Measurement" (
    "id" SERIAL NOT NULL,
    "inspectionId" INTEGER NOT NULL,
    "featureId" INTEGER,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'DIMENSION',
    "nominal" DOUBLE PRECISION,
    "tolMinus" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tolPlus" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gdtLimit" DOUBLE PRECISION,
    "actual" DOUBLE PRECISION,
    "unit" TEXT NOT NULL DEFAULT 'mm',
    "critical" BOOLEAN NOT NULL DEFAULT false,
    "result" TEXT NOT NULL DEFAULT 'PENDING',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Measurement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_firebaseUid_key" ON "User"("firebaseUid");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_active_idx" ON "User"("role", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_name_key" ON "Supplier"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Material_partNumber_key" ON "Material"("partNumber");

-- CreateIndex
CREATE INDEX "MaterialFeature_materialId_stage_idx" ON "MaterialFeature"("materialId", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "Lot_lotNumber_key" ON "Lot"("lotNumber");

-- CreateIndex
CREATE INDEX "Lot_status_idx" ON "Lot"("status");

-- CreateIndex
CREATE INDEX "Certificate_lotId_idx" ON "Certificate"("lotId");

-- CreateIndex
CREATE INDEX "Analysis_lotId_idx" ON "Analysis"("lotId");

-- CreateIndex
CREATE INDEX "Analysis_recordedById_idx" ON "Analysis"("recordedById");

-- CreateIndex
CREATE INDEX "AnalysisResult_analysisId_idx" ON "AnalysisResult"("analysisId");

-- CreateIndex
CREATE UNIQUE INDEX "Part_serialNumber_key" ON "Part"("serialNumber");

-- CreateIndex
CREATE INDEX "Part_currentStage_status_idx" ON "Part"("currentStage", "status");

-- CreateIndex
CREATE INDEX "PartEvent_partId_idx" ON "PartEvent"("partId");

-- CreateIndex
CREATE INDEX "PartEvent_actorId_idx" ON "PartEvent"("actorId");

-- CreateIndex
CREATE INDEX "Inspection_stage_status_idx" ON "Inspection"("stage", "status");

-- CreateIndex
CREATE INDEX "Inspection_partId_idx" ON "Inspection"("partId");

-- CreateIndex
CREATE INDEX "Inspection_lotId_idx" ON "Inspection"("lotId");

-- CreateIndex
CREATE INDEX "Inspection_inspectorId_idx" ON "Inspection"("inspectorId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckResult_inspectionId_key_key" ON "CheckResult"("inspectionId", "key");

-- CreateIndex
CREATE INDEX "Measurement_inspectionId_idx" ON "Measurement"("inspectionId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialFeature" ADD CONSTRAINT "MaterialFeature_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisResult" ADD CONSTRAINT "AnalysisResult_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Part" ADD CONSTRAINT "Part_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Part" ADD CONSTRAINT "Part_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartEvent" ADD CONSTRAINT "PartEvent_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartEvent" ADD CONSTRAINT "PartEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_inspectorId_fkey" FOREIGN KEY ("inspectorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckResult" ADD CONSTRAINT "CheckResult_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Measurement" ADD CONSTRAINT "Measurement_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
