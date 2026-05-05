-- CreateTable
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "highThreshold" INTEGER NOT NULL DEFAULT 70,
    "medThreshold" INTEGER NOT NULL DEFAULT 40,
    "autoCancel" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);
