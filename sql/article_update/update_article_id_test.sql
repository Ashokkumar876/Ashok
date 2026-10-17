/* =====================================================================
   Test: change ARTICLE_ID in dbo.CONNDESC from a CSV list
   Database : HW_STUDIO_2026_ORG   (test copy)
   CSV      : ArticleUpdate.csv  (columns: NAME,NEW_ARTICLE_ID)
   Only data is changed. #temp tables are dropped automatically when
   this query window is closed - no tables/columns are added.
   Run the whole script with F5. It ROLLS BACK by default; change
   @Commit to 1 only after the preview looks right.
   ===================================================================== */
USE HW_STUDIO_2026_ORG;
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Commit BIT = 0;          -- 0 = test only (rollback), 1 = save changes

/* ---- 1. Load the CSV values ---------------------------------------- */
IF OBJECT_ID('tempdb..#Upd') IS NOT NULL DROP TABLE #Upd;
CREATE TABLE #Upd (NAME NVARCHAR(255) NOT NULL, NEW_ARTICLE_ID NVARCHAR(255) NOT NULL);

-- Option A (default): values copied from ArticleUpdate.csv
INSERT INTO #Upd (NAME, NEW_ARTICLE_ID) VALUES
('PM_EXH_SEV_SS088_JB_160', 'SHJB_160_TEST');

-- Option B: read the CSV directly. The file must be on the SQL Server
-- machine (192.168.2.7). Comment out Option A if you use this.
-- BULK INSERT #Upd
-- FROM 'C:\Temp\ArticleUpdate.csv'
-- WITH (FIRSTROW = 2, FIELDTERMINATOR = ',', ROWTERMINATOR = '\n', CODEPAGE = '65001');

UPDATE #Upd SET NAME           = LTRIM(RTRIM(NAME)),
                NEW_ARTICLE_ID = LTRIM(RTRIM(REPLACE(NEW_ARTICLE_ID, CHAR(13), '')));

/* ---- 2. Preview ---------------------------------------------------- */
SELECT 'PREVIEW' AS Step, c.NAME, c.ARTICLE_ID AS OLD_ARTICLE_ID, u.NEW_ARTICLE_ID
FROM dbo.CONNDESC c
JOIN #Upd u ON c.NAME = u.NAME;

SELECT 'NOT FOUND IN CONNDESC' AS Step, u.*
FROM #Upd u
WHERE NOT EXISTS (SELECT 1 FROM dbo.CONNDESC c WHERE c.NAME = u.NAME);

/* ---- 3. Update (with old/new log) ---------------------------------- */
IF OBJECT_ID('tempdb..#Log') IS NOT NULL DROP TABLE #Log;
CREATE TABLE #Log (NAME NVARCHAR(255), OLD_ARTICLE_ID NVARCHAR(255), NEW_ARTICLE_ID NVARCHAR(255));

DECLARE @Expected INT = (SELECT COUNT(*) FROM dbo.CONNDESC c JOIN #Upd u ON c.NAME = u.NAME);

BEGIN TRAN;

UPDATE c
SET    c.ARTICLE_ID = u.NEW_ARTICLE_ID
OUTPUT inserted.NAME, deleted.ARTICLE_ID, inserted.ARTICLE_ID INTO #Log
FROM   dbo.CONNDESC c
JOIN   #Upd u ON c.NAME = u.NAME;

DECLARE @Updated INT = @@ROWCOUNT;

SELECT 'CHANGED' AS Step, * FROM #Log;   -- save as CSV to keep an undo list

IF @Commit = 1 AND @Updated = @Expected AND @Updated > 0
BEGIN
    COMMIT;
    PRINT CONCAT('COMMITTED: ', @Updated, ' row(s) updated.');
END
ELSE
BEGIN
    ROLLBACK;
    PRINT CONCAT('ROLLED BACK (test mode or row count mismatch). Rows that would change: ', @Updated);
END

/* ---- 4. Check the current value ------------------------------------ */
SELECT 'AFTER' AS Step, c.NAME, c.ARTICLE_ID
FROM dbo.CONNDESC c
JOIN #Upd u ON c.NAME = u.NAME;

/* ---- UNDO (run separately if you need to restore the old value) -----
UPDATE dbo.CONNDESC
SET    ARTICLE_ID = 'SHJB_160'
WHERE  NAME = 'PM_EXH_SEV_SS088_JB_160';
---------------------------------------------------------------------- */
