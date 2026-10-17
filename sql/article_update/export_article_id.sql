/* =====================================================================
   Export NAME + ARTICLE_ID from dbo.CONNDESC to CSV
   Database : HW_STUDIO_2026_ORG
   The output has the same columns as ArticleUpdate.csv
   (NAME,NEW_ARTICLE_ID), so you can edit NEW_ARTICLE_ID in Excel and
   feed the file straight back into update_article_id_test.sql.
   Read-only: nothing in the database is changed.
   ===================================================================== */
USE HW_STUDIO_2026_ORG;
SET NOCOUNT ON;

/* ---- Filter: leave NULL to export all rows ------------------------- */
DECLARE @NameLike    NVARCHAR(255) = NULL;   -- e.g. N'PM[_]EXH[_]SEV%'
DECLARE @ArticleLike NVARCHAR(255) = NULL;   -- e.g. N'SHJB%'

/* ---- Option 1: grid result -> right-click > "Save Results As..." --- */
SELECT c.NAME,
       c.ARTICLE_ID AS NEW_ARTICLE_ID,      -- current value; edit this column in Excel
       c.ARTICLE_ID AS OLD_ARTICLE_ID,      -- keep for reference / undo (delete before import)
       c.TEXT_SHORT,
       c.SUPPLIER
FROM dbo.CONNDESC c
WHERE (@NameLike    IS NULL OR c.NAME       LIKE @NameLike)
  AND (@ArticleLike IS NULL OR c.ARTICLE_ID LIKE @ArticleLike)
ORDER BY c.NAME;

/* ---- Option 2: ready-made CSV text ---------------------------------
   Switch SSMS to text output (Ctrl+T) or file output (Ctrl+Shift+F),
   run only this part, and save. Values containing commas or quotes
   are wrapped in quotes so Excel opens them correctly.              */
SELECT CsvLine
FROM (
    SELECT 0 AS SortKey, N'' AS NAME, N'NAME,NEW_ARTICLE_ID' AS CsvLine
    UNION ALL
    SELECT 1, c.NAME,
           CASE WHEN c.NAME LIKE N'%[,"]%'
                THEN N'"' + REPLACE(c.NAME, N'"', N'""') + N'"' ELSE c.NAME END
         + N','
         + CASE WHEN c.ARTICLE_ID LIKE N'%[,"]%'
                THEN N'"' + REPLACE(c.ARTICLE_ID, N'"', N'""') + N'"' ELSE ISNULL(c.ARTICLE_ID, N'') END
    FROM dbo.CONNDESC c
    WHERE (@NameLike    IS NULL OR c.NAME       LIKE @NameLike)
      AND (@ArticleLike IS NULL OR c.ARTICLE_ID LIKE @ArticleLike)
) x
ORDER BY SortKey, NAME;

/* ---- Option 3: straight to a file with bcp (run in Command Prompt) --
bcp "SELECT NAME, ARTICLE_ID FROM HW_STUDIO_2026_ORG.dbo.CONNDESC ORDER BY NAME" queryout "C:\Temp\CONNDESC_export.csv" -c -t, -C 65001 -S 192.168.2.7,65022 -U IMOSADMIN -P <password>

   bcp writes no header row: add "NAME,NEW_ARTICLE_ID" as the first line
   before using the file with update_article_id_test.sql.
---------------------------------------------------------------------- */
