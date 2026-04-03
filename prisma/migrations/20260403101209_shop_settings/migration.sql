-- CreateTable
CREATE TABLE "ShopSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "leadTimeDays" INTEGER NOT NULL DEFAULT 14,
    "bufferPct" REAL NOT NULL DEFAULT 0.2,
    "updatedAt" DATETIME NOT NULL
);
