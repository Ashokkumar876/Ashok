/* =====================================================================
   Change ARTICLE_ID  DB_1200 -> DB-1200  in dbo.CONNDESC
   Database : HW_STUDIO_2026_ORG
   CSV      : ArticleUpdate_DB1200.csv (NAME,OLD_ARTICLE_ID,NEW_ARTICLE_ID)
   A row is changed only if NAME matches AND its current ARTICLE_ID still
   equals OLD_ARTICLE_ID. Only data changes; #temp tables vanish when
   the window is closed.
   Run with F5. @Commit = 0 is a dry run (rollback). Set to 1 to save.
   ===================================================================== */
USE HW_STUDIO_2026_ORG;
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Commit BIT = 0;          -- 0 = test only (rollback), 1 = save changes

/* ---- 1. Values from the CSV ---------------------------------------- */
IF OBJECT_ID('tempdb..#Upd') IS NOT NULL DROP TABLE #Upd;
CREATE TABLE #Upd (NAME NVARCHAR(255) COLLATE DATABASE_DEFAULT NOT NULL,
                   OLD_ARTICLE_ID NVARCHAR(255) COLLATE DATABASE_DEFAULT NOT NULL,
                   NEW_ARTICLE_ID NVARCHAR(255) COLLATE DATABASE_DEFAULT NOT NULL);

INSERT INTO #Upd (NAME, OLD_ARTICLE_ID, NEW_ARTICLE_ID) VALUES
('PM_EXH_DCO_SNS_BL_1200', 'DB_1200', 'DB-1200');
-- More rows:  ,('NAME', 'OLD_ID', 'NEW_ID')

-- Or read the CSV (file must be on the SQL Server machine 192.168.2.7):
-- BULK INSERT #Upd FROM 'C:\Temp\ArticleUpdate_DB1200.csv'
-- WITH (FORMAT = 'CSV', FIRSTROW = 2, CODEPAGE = '65001');

/* ---- 2. Preview ---------------------------------------------------- */
SELECT 'PREVIEW' AS Step, c.NAME, c.TEXT_SHORT,
       c.ARTICLE_ID AS CURRENT_ARTICLE_ID, u.OLD_ARTICLE_ID, u.NEW_ARTICLE_ID,
       CASE WHEN c.ARTICLE_ID = u.OLD_ARTICLE_ID THEN 'WILL CHANGE'
            ELSE 'SKIPPED - current value differs' END AS Result
FROM dbo.CONNDESC c
JOIN #Upd u ON c.NAME = u.NAME;

SELECT 'NOT FOUND IN CONNDESC' AS Step, u.*
FROM #Upd u
WHERE NOT EXISTS (SELECT 1 FROM dbo.CONNDESC c WHERE c.NAME = u.NAME);

-- Other rows that already use the new code (info only)
SELECT 'NEW CODE ALREADY USED BY' AS Step, c.NAME, c.ARTICLE_ID, c.TEXT_SHORT, c.SUPPLIER
FROM dbo.CONNDESC c
JOIN #Upd u ON c.ARTICLE_ID = u.NEW_ARTICLE_ID AND c.NAME <> u.NAME;

/* ---- 3. Update ----------------------------------------------------- */
IF OBJECT_ID('tempdb..#Log') IS NOT NULL DROP TABLE #Log;
CREATE TABLE #Log (NAME NVARCHAR(255) COLLATE DATABASE_DEFAULT, OLD_ARTICLE_ID NVARCHAR(255) COLLATE DATABASE_DEFAULT, NEW_ARTICLE_ID NVARCHAR(255) COLLATE DATABASE_DEFAULT);

DECLARE @Expected INT = (SELECT COUNT(*) FROM dbo.CONNDESC c
                         JOIN #Upd u ON c.NAME = u.NAME AND c.ARTICLE_ID = u.OLD_ARTICLE_ID);

BEGIN TRAN;

UPDATE c
SET    c.ARTICLE_ID = u.NEW_ARTICLE_ID
OUTPUT inserted.NAME, deleted.ARTICLE_ID, inserted.ARTICLE_ID INTO #Log
FROM   dbo.CONNDESC c
JOIN   #Upd u ON c.NAME = u.NAME AND c.ARTICLE_ID = u.OLD_ARTICLE_ID;

DECLARE @Updated INT = @@ROWCOUNT;

SELECT 'CHANGED' AS Step, * FROM #Log;

IF @Commit = 1 AND @Updated = @Expected AND @Updated > 0
BEGIN
    COMMIT;
    PRINT CONCAT('COMMITTED: ', @Updated, ' row(s) updated.');
END
ELSE
BEGIN
    ROLLBACK;
    PRINT CONCAT('ROLLED BACK (test mode or nothing to change). Rows that would change: ', @Updated);
END

/* ---- 4. Current value ---------------------------------------------- */
SELECT 'AFTER' AS Step, c.NAME, c.ARTICLE_ID
FROM dbo.CONNDESC c
JOIN #Upd u ON c.NAME = u.NAME;

/* ---- UNDO (run separately only if needed) ---------------------------
UPDATE dbo.CONNDESC
SET    ARTICLE_ID = 'DB_1200'
WHERE  NAME = 'PM_EXH_DCO_SNS_BL_1200' AND ARTICLE_ID = 'DB-1200';
---------------------------------------------------------------------- */
