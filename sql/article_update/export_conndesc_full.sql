/* =====================================================================
   Export the FULL table dbo.CONNDESC (all columns, all rows)
   Database : HW_STUDIO_2026_ORG
   Read-only: nothing in the database is changed.
   ===================================================================== */
USE HW_STUDIO_2026_ORG;
SET NOCOUNT ON;

-- Row count, to check the exported file is complete
SELECT COUNT(*) AS TotalRows FROM dbo.CONNDESC;

/* ---- Method 1: SSMS grid -> CSV -------------------------------------
   One-time setup (then open a NEW query window):
     Tools > Options > Query Results > SQL Server > Results to Grid
       [x] Include column headers when copying or saving the results
       [x] Quote strings containing list separators when saving .csv results
   Run the SELECT below, right-click the grid > "Save Results As..."
   > Save as type: CSV (Comma delimited) > CONNDESC_full.csv          */
SELECT *
FROM [HW_STUDIO_2026_ORG].[dbo].[CONNDESC]
ORDER BY NAME;

/* ---- Method 2: PowerShell (headers + quoting handled automatically) --
   Needs the SqlServer module once:  Install-Module SqlServer -Scope CurrentUser

Invoke-Sqlcmd -ServerInstance "192.168.2.7,65022" -Database "HW_STUDIO_2026_ORG" `
  -Username "IMOSADMIN" -Password "<password>" -TrustServerCertificate `
  -MaxCharLength 65535 -QueryTimeout 0 `
  -Query "SELECT * FROM dbo.CONNDESC ORDER BY NAME" |
  Select-Object * -ExcludeProperty ItemArray, Table, RowError, RowState, HasErrors |
  Export-Csv "C:\Temp\CONNDESC_full.csv" -NoTypeInformation -Encoding UTF8
---------------------------------------------------------------------- */

/* ---- Method 3: bcp (Command Prompt) - tab-delimited, very fast -------
   Tab is used because TEXT_SHORT etc. can contain commas.
   bcp writes no header row.

bcp "SELECT * FROM HW_STUDIO_2026_ORG.dbo.CONNDESC ORDER BY NAME" queryout "C:\Temp\CONNDESC_full.txt" -c -C 65001 -S 192.168.2.7,65022 -U IMOSADMIN -P <password>

   Exact copy for restoring into SQL Server later (native format, not for Excel):
bcp HW_STUDIO_2026_ORG.dbo.CONNDESC out "C:\Temp\CONNDESC_full.bcp" -n -S 192.168.2.7,65022 -U IMOSADMIN -P <password>
---------------------------------------------------------------------- */
