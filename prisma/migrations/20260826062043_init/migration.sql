-- CreateTable
CREATE TABLE "Supplier" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "contact" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Material" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "partNumber" TEXT NOT NULL,
    "materialNumber" TEXT,
    "description" TEXT,
    "spec" TEXT,
    "drawingNumber" TEXT,
    "drawingRev" TEXT,
    "hardnessMin" REAL,
    "hardnessMax" REAL,
    "hardnessUnit" TEXT NOT NULL DEFAULT 'HRC',
    "surfaceFinishRa" REAL,
    "requiredCerts" TEXT,
    "roughingAllowance" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MaterialFeature" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "materialId" INTEGER NOT NULL,
    "stage" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'DIMENSION',
    "nominal" REAL,
    "tolMinus" REAL NOT NULL DEFAULT 0,
    "tolPlus" REAL NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT 'mm',
    "critical" BOOLEAN NOT NULL DEFAULT false,
    "gdtSymbol" TEXT,
    "gdtLimit" REAL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "MaterialFeature_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Lot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "lotNumber" TEXT NOT NULL,
    "materialId" INTEGER NOT NULL,
    "supplierId" INTEGER,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "poNumber" TEXT,
    "heatNumber" TEXT,
    "receivedQty" REAL NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Lot_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Lot_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Certificate" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "lotId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "number" TEXT,
    "issuedAt" DATETIME,
    "received" BOOLEAN NOT NULL DEFAULT false,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    CONSTRAINT "Certificate_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Analysis" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "lotId" INTEGER NOT NULL,
    "sampleRef" TEXT NOT NULL,
    "method" TEXT,
    "performedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "performedBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "conclusion" TEXT,
    "actionTaken" TEXT,
    CONSTRAINT "Analysis_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AnalysisResult" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "analysisId" INTEGER NOT NULL,
    "property" TEXT NOT NULL,
    "requiredMin" REAL,
    "requiredMax" REAL,
    "requiredText" TEXT,
    "actual" REAL,
    "actualText" TEXT,
    "unit" TEXT,
    "pass" BOOLEAN,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "AnalysisResult_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Part" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "serialNumber" TEXT NOT NULL,
    "materialId" INTEGER NOT NULL,
    "lotId" INTEGER,
    "batchQty" INTEGER NOT NULL DEFAULT 1,
    "currentStage" TEXT NOT NULL DEFAULT 'POST_ROUGHING',
    "status" TEXT NOT NULL DEFAULT 'IN_PROCESS',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Part_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Part_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PartEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "partId" INTEGER NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "stage" TEXT,
    "fromValue" TEXT,
    "toValue" TEXT,
    "note" TEXT,
    "actor" TEXT,
    CONSTRAINT "PartEvent_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Inspection" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "stage" TEXT NOT NULL,
    "partId" INTEGER,
    "lotId" INTEGER,
    "inspector" TEXT NOT NULL,
    "inspectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "hardnessValue" REAL,
    "hardnessUnit" TEXT,
    "hardnessMin" REAL,
    "hardnessMax" REAL,
    "surfaceFinishRa" REAL,
    "cmmRequired" BOOLEAN NOT NULL DEFAULT false,
    "cmmReportRef" TEXT,
    "cmmReviewed" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Inspection_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Inspection_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CheckResult" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "inspectionId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "ok" BOOLEAN,
    "note" TEXT,
    CONSTRAINT "CheckResult_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Measurement" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "inspectionId" INTEGER NOT NULL,
    "featureId" INTEGER,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'DIMENSION',
    "nominal" REAL,
    "tolMinus" REAL NOT NULL DEFAULT 0,
    "tolPlus" REAL NOT NULL DEFAULT 0,
    "gdtLimit" REAL,
    "actual" REAL,
    "unit" TEXT NOT NULL DEFAULT 'mm',
    "critical" BOOLEAN NOT NULL DEFAULT false,
    "result" TEXT NOT NULL DEFAULT 'PENDING',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Measurement_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

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
CREATE INDEX "AnalysisResult_analysisId_idx" ON "AnalysisResult"("analysisId");

-- CreateIndex
CREATE UNIQUE INDEX "Part_serialNumber_key" ON "Part"("serialNumber");

-- CreateIndex
CREATE INDEX "Part_currentStage_status_idx" ON "Part"("currentStage", "status");

-- CreateIndex
CREATE INDEX "PartEvent_partId_idx" ON "PartEvent"("partId");

-- CreateIndex
CREATE INDEX "Inspection_stage_status_idx" ON "Inspection"("stage", "status");

-- CreateIndex
CREATE INDEX "Inspection_partId_idx" ON "Inspection"("partId");

-- CreateIndex
CREATE INDEX "Inspection_lotId_idx" ON "Inspection"("lotId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckResult_inspectionId_key_key" ON "CheckResult"("inspectionId", "key");

-- CreateIndex
CREATE INDEX "Measurement_inspectionId_idx" ON "Measurement"("inspectionId");
