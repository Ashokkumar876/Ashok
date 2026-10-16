# ============================================================
# Studio Vs IMOS Report - Comparison Script
# Version : 1.0
# Author  : Ashok
# ============================================================
#
# PURPOSE
#   Compares the Studio report and the IMOS Assembly Report of every order in
#   the input folders and writes one plain CSV output per order.
#
# FILE PAIRING (by order number)
#   Input File Studio\3FO3GLIS8SS6.xlsx
#   Input File IMOS\3FO3GLIS8SS6_ASSEMBLY_REPORT.xlsx
#   If one file of a pair is missing, that order is skipped, its file stays in
#   the input folder and it is listed as UNMATCHED. All other pairs still run.
#
# STEPS FOR EACH PAIR (numbered sections below)
#   1. Convert both .xlsx files to CSV (merged cells removed).
#   2. Read the cabinets and sections, round sizes to one decimal, remove
#      empty rows, and save the cleaned CSV in Archive\Temp\<Order No>\.
#   3. Compare (rules below).
#   4. Write Output File\<Order>_OUTPUT_<dd_MM_yyyy_HH_mm>.csv and a copy in
#      Archive\Output File\<Order>\.
#   5. Move the inputs to Archive\Input File Studio\<Order>\ and
#      Archive\Input File IMOS\<Order>\, renamed with date and time.
#   If any step fails, the input files are NOT moved.
#
# COMPARISON RULES
#   Cabinets : matched by Install Code + Cabinet Name. Unit sizes are shown,
#              not compared.
#   Panels   : matched by size. Width/Depth may be interchanged; thickness must
#              be equal. Sizes are rounded to one decimal (half up), then must
#              match exactly. Every row counts as 1 panel.
#              Same size, same number of panels -> compare finish:
#                Core Material and Edge Band exactly, Top/Bottom Surface
#                exactly but may be interchanged.
#              Same size but different number of panels -> the extra (last)
#                panel(s) of that size = Mismatch Quantity.
#              Size only in one file -> Missing in IMOS / Missing in Studio.
#              "Installation Cost" (Studio only) is left out.
#   Stretchable parts and Hardware:
#              matched by Article Code (exact) within the same cabinet. Rows
#              with the same Article Code are added together. Only the quantity
#              is compared (Running Meter rounded to one decimal; hardware Qty
#              as is). Different -> Mismatch Quantity.
#              Article Code only in one file -> Missing in IMOS / Missing in Studio.
#   Status   : Ok | Missing in IMOS | Missing in Studio | Mismatch Quantity |
#              Mismatch Finish   (Quantity is reported before Finish)
#
# OUTPUT ROW ORDER (per cabinet)
#   Panels (matched, IMOS order) -> panel missing/extra rows
#   Stretchable parts            -> stretchable missing rows
#   Hardware                     -> hardware missing rows
#
# HOW TO RUN
#   Double-click "Run-Studio-Vs-IMOS-Compare.bat" in the main folder.
#   No Excel or LibreOffice is needed. The .xlsx files are read directly.
# ============================================================

# ============================================================
# FILE LOCATIONS - change these if the folders move
# ============================================================

$StudioInputFolder   = "O:\DECORIA\Ashok\Studio Vs IMOS Report\Input File Studio"
$ImosInputFolder     = "O:\DECORIA\Ashok\Studio Vs IMOS Report\Input File IMOS"
$OutputFolder        = "O:\DECORIA\Ashok\Studio Vs IMOS Report\Output File"

$ArchiveStudioFolder = "O:\DECORIA\Ashok\Studio Vs IMOS Report\Archive\Input File Studio"
$ArchiveImosFolder   = "O:\DECORIA\Ashok\Studio Vs IMOS Report\Archive\Input File IMOS"
$ArchiveOutputFolder = "O:\DECORIA\Ashok\Studio Vs IMOS Report\Archive\Output File"
$TempFolder          = "O:\DECORIA\Ashok\Studio Vs IMOS Report\Archive\Temp"

# ============================================================
# SETTINGS
# ============================================================

# IMOS file name = <order number> + this suffix + .xlsx
$ImosFileSuffix  = "_ASSEMBLY_REPORT"

# Date/time added to output and archive file names (24-hour clock)
$TimestampFormat = "dd_MM_yyyy_HH_mm"

# Studio panel rows left out of the comparison and the output
$ExcludeStudioPanels = @("Installation Cost")

# Section header rows (column A, both files)
$PanelHeader       = "Panel Name"
$StretchableHeader = "Stretchable Purchase Part Name"
$HardwareHeader    = "Hardware Description"

# Status texts
$StatusOk             = "Ok"
$StatusMissingImos    = "Missing in IMOS"
$StatusMissingStudio  = "Missing in Studio"
$StatusMismatchQty    = "Mismatch Quantity"
$StatusMismatchFinish = "Mismatch Finish"

# ------------------------------------------------------------
# Column letters in the converted CSV (same as the Excel columns)
# ------------------------------------------------------------
# Cabinet header row: Name, Width, Depth, Height, Install Code
$CabNameCol = "A"; $CabSizeCols = @("B", "C", "D"); $CabInstallCodeCol = "E"

# Panel rows (both files)
$PanelNameCol   = "A"
$PanelSizeCols  = @("B", "C", "D")          # Width, Depth, Thickness
$PanelCoreCol   = "E"
$PanelTopCol    = "F"
$PanelBottomCol = "G"
$PanelEdgeCol   = "H"

# Stretchable / Hardware rows
$ArticleCodeCol  = "E"
$ImosQtyCol      = "I"      # IMOS   : Total Running Meter / Total Qty
$StudioQtyCol    = "H"      # Studio : Total Running Meter / Total Qty
$StudioPriceCol  = "J"      # Studio : Total Price (added up for repeated codes)

# Output columns: header name -> CSV column letter of the source row
$ImosOutputColumns = [ordered]@{
    "IMOS_Description"    = "A"; "IMOS_Width"          = "B"; "IMOS_Depth"     = "C"
    "IMOS_Thickness"      = "D"; "IMOS_Core Material"  = "E"; "IMOS_Top Surface" = "F"
    "IMOS_Bottom Surface" = "G"; "IMOS_Edge Band"      = "H"; "IMOS_Count"     = "I"
}
$StudioOutputColumns = [ordered]@{
    "Studio_Description"    = "A"; "Studio_Width"         = "B"; "Studio_Depth"     = "C"
    "Studio_Thickness"      = "D"; "Studio_Core Material" = "E"; "Studio_Top Surface" = "F"
    "Studio_Bottom Surface" = "G"; "Studio_Edge Band"     = "H"; "Studio_Qty/SqFt"  = "I"
    "Total Price"           = "J"; "Type"                 = "K"
}

# ============================================================
# Start-up
# ============================================================

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$Invariant = [System.Globalization.CultureInfo]::InvariantCulture
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$RunStamp  = Get-Date -Format $TimestampFormat

$SuccessOrders  = New-Object System.Collections.Generic.List[string]
$FailedOrders   = New-Object System.Collections.Generic.List[string]
$UnmatchedFiles = New-Object System.Collections.Generic.List[string]
$IgnoredFiles   = New-Object System.Collections.Generic.List[string]
$ErrorLog       = New-Object System.Collections.Generic.List[string]

# ============================================================
# Helper Functions
# ============================================================

function New-FolderIfMissing
{
    param([string]$Path)
    if (!(Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
}

# Returns a path that does not exist yet: name.ext, name_2.ext, name_3.ext ...
function Get-UniquePath
{
    param([string]$Folder, [string]$BaseName, [string]$Extension)
    $Path = Join-Path $Folder ($BaseName + $Extension)
    $n = 2
    while (Test-Path -LiteralPath $Path)
    {
        $Path = Join-Path $Folder ($BaseName + "_" + $n + $Extension)
        $n++
    }
    return $Path
}

function ConvertTo-ColumnNumber
{
    param([string]$Letters)
    $n = 0
    foreach ($ch in $Letters.ToUpper().ToCharArray()) { $n = $n * 26 + ([int]$ch - 64) }
    return $n
}

function ConvertTo-ColumnLetters
{
    param([int]$Number)
    $s = ""
    while ($Number -gt 0)
    {
        $r = ($Number - 1) % 26
        $s = [char](65 + $r) + $s
        $Number = [int](($Number - $r - 1) / 26)
    }
    return $s
}

# Line breaks / tabs / repeated spaces -> one space, trimmed
function Get-CleanText
{
    param([object]$Text)
    if ($null -eq $Text) { return "" }
    return ([regex]::Replace([string]$Text, '\s+', ' ')).Trim()
}

function ConvertTo-CsvField
{
    param([string]$Text)
    if ($Text -match '[",\r\n]') { return '"' + $Text.Replace('"', '""') + '"' }
    return $Text
}

# Text -> decimal, or $null if it is not a number
function ConvertTo-Number
{
    param([string]$Text)
    $Value = [decimal]0
    if ([decimal]::TryParse($Text, [System.Globalization.NumberStyles]::Float, $Invariant, [ref]$Value)) { return $Value }
    return $null
}

# Rounds a number to one decimal (half up) and always shows one decimal: 700 -> 700.0
# Text that is not a number is returned unchanged.
function Format-OneDecimal
{
    param([string]$Text)
    $Number = ConvertTo-Number $Text
    if ($null -eq $Number) { return $Text }
    return ([decimal]::Round($Number, 1, [System.MidpointRounding]::AwayFromZero)).ToString("0.0", $Invariant)
}

# Plain number text without trailing zeros: 12.0 -> 12, 600.50 -> 600.5
function Format-Number
{
    param([decimal]$Number)
    return $Number.ToString("0.##########", $Invariant)
}

function Test-RowEmpty
{
    param([hashtable]$Row)
    foreach ($V in $Row.Values) { if ("$V" -ne "") { return $false } }
    return $true
}

# Same words in any order: "Side Panel Left" = "Left Side Panel"
function Get-NameKey
{
    param([string]$Name)
    return ((($Name.ToLower() -split '\s+') | Where-Object { $_ } | Sort-Object) -join " ")
}

# Writes rows (hashtables keyed by column letter) as CSV with a letter header
function Save-RowsAsCsv
{
    param([System.Collections.Generic.List[hashtable]]$Rows, [string[]]$Columns, [string]$CsvPath)

    $Lines = New-Object System.Collections.Generic.List[string]
    $Lines.Add(($Columns -join ","))
    foreach ($Row in $Rows)
    {
        $Lines.Add((($Columns | ForEach-Object { ConvertTo-CsvField ([string]$Row[$_]) }) -join ","))
    }
    [System.IO.File]::WriteAllLines($CsvPath, $Lines, $Utf8NoBom)
}

# Reads one XML part from the xlsx (zip). Returns $null if missing.
function Read-ZipXml
{
    param([System.IO.Compression.ZipArchive]$Zip, [string]$EntryName)

    $Entry = $Zip.GetEntry($EntryName)
    if ($null -eq $Entry) { return $null }
    $Reader = New-Object System.IO.StreamReader($Entry.Open())
    try
    {
        $Doc = New-Object System.Xml.XmlDocument
        $Doc.LoadXml($Reader.ReadToEnd())
        return ,$Doc
    }
    finally { $Reader.Dispose() }
}

# ============================================================
# SECTION 1 - Convert XLSX to CSV
# Reads the first worksheet straight from the .xlsx file (no Excel needed).
# Merged cells: only the first cell keeps the value, the others are empty.
# Header row of the CSV = column letters (A, B, C ...).
# ============================================================

function Convert-XlsxToCsv
{
    param([string]$XlsxPath, [string]$CsvPath)

    # Open with sharing so it can be read even while open in Excel
    $Stream = [System.IO.File]::Open($XlsxPath, 'Open', 'Read', 'ReadWrite')
    $Zip = $null
    try
    {
        try   { $Zip = New-Object System.IO.Compression.ZipArchive($Stream, [System.IO.Compression.ZipArchiveMode]::Read) }
        catch { throw "Not a valid .xlsx file: $([System.IO.Path]::GetFileName($XlsxPath))" }

        # --- Locate the first worksheet ---
        $Workbook = Read-ZipXml $Zip "xl/workbook.xml"
        $Rels     = Read-ZipXml $Zip "xl/_rels/workbook.xml.rels"
        if ($null -eq $Workbook -or $null -eq $Rels) { throw "Not a valid .xlsx file (workbook part missing)." }

        $FirstSheet = $Workbook.SelectSingleNode("//*[local-name()='sheets']/*[local-name()='sheet']")
        if ($null -eq $FirstSheet) { throw "The workbook has no worksheets." }

        $RelId = ($FirstSheet.Attributes | Where-Object { $_.LocalName -eq 'id' } | Select-Object -First 1).Value
        $Rel   = $Rels.SelectSingleNode("//*[local-name()='Relationship' and @Id='$RelId']")
        if ($null -eq $Rel) { throw "The first worksheet could not be located." }

        $Target = $Rel.GetAttribute("Target")
        if ($Target.StartsWith("/")) { $SheetPath = $Target.TrimStart("/") } else { $SheetPath = "xl/" + $Target }

        $Sheet = Read-ZipXml $Zip $SheetPath
        if ($null -eq $Sheet) { throw "Worksheet part '$SheetPath' is missing." }

        # --- Shared strings ---
        $Shared = New-Object System.Collections.Generic.List[string]
        $SharedXml = Read-ZipXml $Zip "xl/sharedStrings.xml"
        if ($null -ne $SharedXml)
        {
            foreach ($Si in $SharedXml.SelectNodes("//*[local-name()='si']"))
            {
                $Parts = $Si.SelectNodes(".//*[local-name()='t' and not(ancestor::*[local-name()='rPh'])]")
                $Shared.Add((($Parts | ForEach-Object { $_.InnerText }) -join ""))
            }
        }

        # --- Read cells ---
        $Cells = @{}; $MaxRow = 0; $MaxCol = 0; $RowNo = 0

        foreach ($RowNode in $Sheet.SelectNodes("//*[local-name()='sheetData']/*[local-name()='row']"))
        {
            $RowAttr = $RowNode.GetAttribute("r")
            if ($RowAttr) { $RowNo = [int]$RowAttr } else { $RowNo++ }
            $ColNo = 0

            foreach ($C in $RowNode.SelectNodes("*[local-name()='c']"))
            {
                $Ref = $C.GetAttribute("r")
                if ($Ref -match '^([A-Za-z]+)') { $ColNo = ConvertTo-ColumnNumber $Matches[1] } else { $ColNo++ }

                $Type  = $C.GetAttribute("t")
                $VNode = $C.SelectSingleNode("*[local-name()='v']")
                $Raw   = if ($null -ne $VNode) { $VNode.InnerText } else { "" }

                switch ($Type)
                {
                    "s"         { $Value = if ($Raw -ne "") { $Shared[[int]$Raw] } else { "" } }
                    "inlineStr" { $Value = (($C.SelectNodes(".//*[local-name()='t']") | ForEach-Object { $_.InnerText }) -join "") }
                    "b"         { $Value = if ($Raw -eq "1") { "TRUE" } else { "FALSE" } }
                    default
                    {
                        $Value = $Raw
                        if ($Type -eq "" -or $Type -eq "n")
                        {
                            $D = 0.0
                            if ($Raw -ne "" -and [double]::TryParse($Raw, [System.Globalization.NumberStyles]::Float, $Invariant, [ref]$D))
                            {
                                $Value = $D.ToString("G15", $Invariant)
                            }
                        }
                    }
                }

                $Value = Get-CleanText $Value
                if ($Value -ne "")
                {
                    $Cells["$RowNo,$ColNo"] = $Value
                    if ($RowNo -gt $MaxRow) { $MaxRow = $RowNo }
                    if ($ColNo -gt $MaxCol) { $MaxCol = $ColNo }
                }
            }
        }

        if ($MaxRow -eq 0) { throw "The first worksheet is empty." }

        # --- Write CSV ---
        $Columns = @(1..$MaxCol | ForEach-Object { ConvertTo-ColumnLetters $_ })
        $Rows = New-Object System.Collections.Generic.List[hashtable]
        for ($r = 1; $r -le $MaxRow; $r++)
        {
            $Row = @{}
            for ($c = 1; $c -le $MaxCol; $c++)
            {
                $V = $Cells["$r,$c"]
                $Row[$Columns[$c - 1]] = if ($null -eq $V) { "" } else { $V }
            }
            $Rows.Add($Row)
        }
        Save-RowsAsCsv $Rows $Columns $CsvPath
    }
    finally
    {
        if ($null -ne $Zip) { $Zip.Dispose() }
        $Stream.Dispose()
    }
}

# ============================================================
# SECTION 2 - Read Report Structure (and save the cleaned CSV)
#   - Cabinet header row = the row directly above a "Panel Name" row
#     (A = cabinet name, B/C/D = unit size, E = Install Code).
#   - Section header rows: Panel Name / Stretchable Purchase Part Name /
#     Hardware Description.
#   - Rounded to one decimal: cabinet sizes, panel Width/Depth/Thickness,
#     stretchable Running Meter.
#   - Completely empty rows are removed.
#   The cleaned rows are written back to the same CSV (kept in Archive\Temp).
# Returns an ordered dictionary: "InstallCode|CabinetName" -> cabinet.
# ============================================================

function Read-ReportStructure
{
    param([string]$CsvPath, [string]$Source, [string]$QtyColumn)

    $Imported = @(Import-Csv -LiteralPath $CsvPath -Encoding UTF8)
    if ($Imported.Count -eq 0) { throw "$Source file has no rows." }
    $Columns = @($Imported[0].PSObject.Properties.Name)

    # Rows as hashtables (column letter -> value)
    $Rows = New-Object System.Collections.Generic.List[hashtable]
    foreach ($Line in $Imported)
    {
        $H = @{}
        foreach ($P in $Line.PSObject.Properties) { $H[$P.Name] = Get-CleanText $P.Value }
        $Rows.Add($H)
    }

    $Cabinets = [ordered]@{}
    $Current  = $null
    $Section  = $null
    $ItemId   = 0

    for ($i = 0; $i -lt $Rows.Count; $i++)
    {
        $Row = $Rows[$i]
        if (Test-RowEmpty $Row) { $Section = $null; continue }
        $A = [string]$Row["A"]

        # --- Cabinet header row ---
        if ($i + 1 -lt $Rows.Count -and [string]$Rows[$i + 1]["A"] -eq $PanelHeader)
        {
            foreach ($Col in $CabSizeCols) { $Row[$Col] = Format-OneDecimal ([string]$Row[$Col]) }

            $Code = [string]$Row[$CabInstallCodeCol]
            $Name = [string]$Row[$CabNameCol]
            if ($Code -eq "") { throw "$Source file: cabinet '$Name' has no Install Code in column $CabInstallCodeCol." }

            $Key = "$Code|$Name"
            if (-not $Cabinets.Contains($Key))
            {
                $Cabinets[$Key] = [pscustomobject]@{
                    Key         = $Key
                    InstallCode = $Code
                    Name        = $Name
                    UnitSize    = (($CabSizeCols | ForEach-Object { [string]$Row[$_] }) -join " x ")
                    Items       = New-Object System.Collections.Generic.List[psobject]
                }
            }
            $Current = $Cabinets[$Key]
            $Section = $null
            continue
        }

        # --- Section header rows ---
        if ($A -eq $PanelHeader)       { $Section = "Panel";       continue }
        if ($A -eq $StretchableHeader) { $Section = "Stretchable"; continue }
        if ($A -eq $HardwareHeader)    { $Section = "Hardware";    continue }

        if ($null -eq $Current -or $null -eq $Section) { continue }   # title rows etc.

        # --- Item rows ---
        if ($Section -eq "Panel")
        {
            foreach ($Col in $PanelSizeCols) { $Row[$Col] = Format-OneDecimal ([string]$Row[$Col]) }
        }
        elseif ($Section -eq "Stretchable")
        {
            $Row[$QtyColumn] = Format-OneDecimal ([string]$Row[$QtyColumn])
        }

        $ItemId++
        $Current.Items.Add([pscustomobject]@{ Id = $ItemId; Section = $Section; Row = $Row })
    }

    if ($Cabinets.Count -eq 0) { throw "$Source file: no cabinets found (no row above a '$PanelHeader' row)." }

    # Save the cleaned CSV (rounded values, no empty rows)
    $Kept = New-Object System.Collections.Generic.List[hashtable]
    foreach ($Row in $Rows) { if (-not (Test-RowEmpty $Row)) { $Kept.Add($Row) } }
    Save-RowsAsCsv $Kept $Columns $CsvPath

    return $Cabinets
}

# ============================================================
# SECTION 3 - Comparison
# Each compare function returns a list of results:
#   @{ Imos = <row or $null>; Studio = <row or $null>; Status = "..." }
# ============================================================

# ---------- 3a. Panels ----------

# Size key: smaller of Width/Depth | larger | Thickness (Width/Depth interchangeable)
function Get-PanelSizeKey
{
    param([hashtable]$Row)

    $W = [string]$Row[$PanelSizeCols[0]]; $D = [string]$Row[$PanelSizeCols[1]]; $T = [string]$Row[$PanelSizeCols[2]]
    $WN = ConvertTo-Number $W; $DN = ConvertTo-Number $D
    if ($null -ne $WN -and $null -ne $DN -and $WN -gt $DN) { $Tmp = $W; $W = $D; $D = $Tmp }
    elseif (($null -eq $WN -or $null -eq $DN) -and [string]::CompareOrdinal($W, $D) -gt 0) { $Tmp = $W; $W = $D; $D = $Tmp }
    return "$W|$D|$T"
}

# Finish: Core and Edge Band exact; Top/Bottom Surface exact but interchangeable
function Test-PanelFinish
{
    param([hashtable]$I, [hashtable]$S)

    if ([string]$I[$PanelCoreCol] -cne [string]$S[$PanelCoreCol]) { return $false }
    if ([string]$I[$PanelEdgeCol] -cne [string]$S[$PanelEdgeCol]) { return $false }

    $IT = [string]$I[$PanelTopCol]; $IB = [string]$I[$PanelBottomCol]
    $ST = [string]$S[$PanelTopCol]; $SB = [string]$S[$PanelBottomCol]
    return (($IT -ceq $ST -and $IB -ceq $SB) -or ($IT -ceq $SB -and $IB -ceq $ST))
}

function Compare-Panels
{
    param([object[]]$ImosItems, [object[]]$StudioItems)

    # Group by size key, keeping file order
    $ImosGroups = [ordered]@{}; $StudioGroups = [ordered]@{}
    foreach ($It in $ImosItems)
    {
        $K = Get-PanelSizeKey $It.Row
        if (-not $ImosGroups.Contains($K)) { $ImosGroups[$K] = New-Object System.Collections.Generic.List[psobject] }
        $ImosGroups[$K].Add($It)
    }
    foreach ($It in $StudioItems)
    {
        $K = Get-PanelSizeKey $It.Row
        if (-not $StudioGroups.Contains($K)) { $StudioGroups[$K] = New-Object System.Collections.Generic.List[psobject] }
        $StudioGroups[$K].Add($It)
    }

    $PairOfImos   = @{}    # IMOS item Id   -> Studio item
    $ImosLeft     = @{}    # IMOS item Id   -> status
    $StudioLeft   = @{}    # Studio item Id -> status

    $AllKeys = @(@($ImosGroups.Keys) + @($StudioGroups.Keys) | Select-Object -Unique)
    foreach ($K in $AllKeys)
    {
        $Ig = @(if ($ImosGroups.Contains($K))   { $ImosGroups[$K] })
        $Sg = @(if ($StudioGroups.Contains($K)) { $StudioGroups[$K] })

        if ($Sg.Count -eq 0) { foreach ($It in $Ig) { $ImosLeft[$It.Id]   = $StatusMissingStudio }; continue }
        if ($Ig.Count -eq 0) { foreach ($It in $Sg) { $StudioLeft[$It.Id] = $StatusMissingImos   }; continue }

        # The side with more panels: its first N panels are paired, its last ones are extra
        $N = [Math]::Min($Ig.Count, $Sg.Count)
        $ImosIsAnchor = ($Ig.Count -ge $Sg.Count)
        if ($ImosIsAnchor) { $Anchors = @($Ig[0..($N - 1)]); $Pool = New-Object System.Collections.ArrayList(,$Sg) }
        else               { $Anchors = @($Sg[0..($N - 1)]); $Pool = New-Object System.Collections.ArrayList(,$Ig) }

        foreach ($Anchor in $Anchors)
        {
            # Best partner: same finish (+2), same name words (+1), else first in file order
            $Best = $null; $BestScore = -1
            foreach ($Cand in $Pool)
            {
                if ($ImosIsAnchor) { $IR = $Anchor.Row; $SR = $Cand.Row } else { $IR = $Cand.Row; $SR = $Anchor.Row }
                $Score = 0
                if (Test-PanelFinish $IR $SR) { $Score += 2 }
                if ((Get-NameKey ([string]$IR[$PanelNameCol])) -eq (Get-NameKey ([string]$SR[$PanelNameCol]))) { $Score += 1 }
                if ($Score -gt $BestScore) { $Best = $Cand; $BestScore = $Score }
            }
            $Pool.Remove($Best)
            if ($ImosIsAnchor) { $PairOfImos[$Anchor.Id] = $Best } else { $PairOfImos[$Best.Id] = $Anchor }
        }

        if ($ImosIsAnchor) { for ($x = $N; $x -lt $Ig.Count; $x++) { $ImosLeft[$Ig[$x].Id]   = $StatusMismatchQty } }
        else               { for ($x = $N; $x -lt $Sg.Count; $x++) { $StudioLeft[$Sg[$x].Id] = $StatusMismatchQty } }
    }

    # Matched rows in IMOS order, then IMOS-only rows, then Studio-only rows
    $Matched = New-Object System.Collections.Generic.List[psobject]
    $Others  = New-Object System.Collections.Generic.List[psobject]

    foreach ($It in $ImosItems)
    {
        if ($PairOfImos.ContainsKey($It.Id))
        {
            $S = $PairOfImos[$It.Id]
            $Status = if (Test-PanelFinish $It.Row $S.Row) { $StatusOk } else { $StatusMismatchFinish }
            $Matched.Add([pscustomobject]@{ Imos = $It.Row; Studio = $S.Row; Status = $Status })
        }
        else
        {
            $Others.Add([pscustomobject]@{ Imos = $It.Row; Studio = $null; Status = $ImosLeft[$It.Id] })
        }
    }
    foreach ($It in $StudioItems)
    {
        if ($StudioLeft.ContainsKey($It.Id))
        {
            $Others.Add([pscustomobject]@{ Imos = $null; Studio = $It.Row; Status = $StudioLeft[$It.Id] })
        }
    }

    foreach ($O in $Others) { $Matched.Add($O) }
    return ,$Matched
}

# ---------- 3b. Stretchable parts and Hardware ----------

# Adds up rows with the same Article Code. Returns ordered dictionary
# code -> @{ Row = <first row with summed values>; Qty = <decimal or $null>; QtyText }
function Get-ArticleTotals
{
    param([object[]]$Items, [string]$QtyColumn, [string]$PriceColumn, [bool]$OneDecimal)

    $Totals = [ordered]@{}
    foreach ($It in $Items)
    {
        $Code = [string]$It.Row[$ArticleCodeCol]
        if ($Code -eq "") { $Code = "NAME:" + [string]$It.Row["A"] }

        $Qty = ConvertTo-Number ([string]$It.Row[$QtyColumn])
        if (-not $Totals.Contains($Code))
        {
            $Totals[$Code] = [pscustomobject]@{ Row = $It.Row.Clone(); Qty = $Qty; QtyText = [string]$It.Row[$QtyColumn]; Rows = 1; Price = $null }
            if ($PriceColumn) { $Totals[$Code].Price = ConvertTo-Number ([string]$It.Row[$PriceColumn]) }
        }
        else
        {
            $T = $Totals[$Code]
            $T.Rows++
            if ($null -ne $T.Qty -and $null -ne $Qty) { $T.Qty += $Qty } else { $T.Qty = $null }
            $T.QtyText += " + " + [string]$It.Row[$QtyColumn]
            if ($PriceColumn)
            {
                $P = ConvertTo-Number ([string]$It.Row[$PriceColumn])
                if ($null -ne $T.Price -and $null -ne $P) { $T.Price += $P } else { $T.Price = $null }
            }
        }
    }

    # Write the totals into the display row
    foreach ($T in $Totals.Values)
    {
        if ($T.Rows -gt 1)
        {
            if ($null -ne $T.Qty)
            {
                if ($OneDecimal) { $T.Row[$QtyColumn] = Format-OneDecimal (Format-Number $T.Qty) }
                else             { $T.Row[$QtyColumn] = Format-Number $T.Qty }
            }
            else { $T.Row[$QtyColumn] = $T.QtyText }

            if ($PriceColumn -and $null -ne $T.Price) { $T.Row[$PriceColumn] = Format-Number $T.Price }
        }
    }
    return $Totals
}

function Compare-Articles
{
    param([object[]]$ImosItems, [object[]]$StudioItems, [bool]$OneDecimal)

    $ImosTotals   = Get-ArticleTotals $ImosItems   $ImosQtyCol   ""              $OneDecimal
    $StudioTotals = Get-ArticleTotals $StudioItems $StudioQtyCol $StudioPriceCol $OneDecimal

    $Matched      = New-Object System.Collections.Generic.List[psobject]
    $ImosOnly     = New-Object System.Collections.Generic.List[psobject]
    $StudioOnly   = New-Object System.Collections.Generic.List[psobject]

    foreach ($Code in $ImosTotals.Keys)
    {
        $I = $ImosTotals[$Code]
        if ($StudioTotals.Contains($Code))
        {
            $S = $StudioTotals[$Code]
            if ($null -ne $I.Qty -and $null -ne $S.Qty)
            {
                $IQ = $I.Qty; $SQ = $S.Qty
                if ($OneDecimal)
                {
                    $IQ = [decimal]::Round($IQ, 1, [System.MidpointRounding]::AwayFromZero)
                    $SQ = [decimal]::Round($SQ, 1, [System.MidpointRounding]::AwayFromZero)
                }
                $Same = ($IQ -eq $SQ)
            }
            else { $Same = ([string]$I.Row[$ImosQtyCol] -ceq [string]$S.Row[$StudioQtyCol]) }

            $Status = if ($Same) { $StatusOk } else { $StatusMismatchQty }
            $Matched.Add([pscustomobject]@{ Imos = $I.Row; Studio = $S.Row; Status = $Status })
        }
        else
        {
            $ImosOnly.Add([pscustomobject]@{ Imos = $I.Row; Studio = $null; Status = $StatusMissingStudio })
        }
    }
    foreach ($Code in $StudioTotals.Keys)
    {
        if (-not $ImosTotals.Contains($Code))
        {
            $StudioOnly.Add([pscustomobject]@{ Imos = $null; Studio = $StudioTotals[$Code].Row; Status = $StatusMissingImos })
        }
    }

    foreach ($R in $ImosOnly)   { $Matched.Add($R) }
    foreach ($R in $StudioOnly) { $Matched.Add($R) }
    return ,$Matched
}

# ---------- 3c. Whole order ----------

function New-OutputRow
{
    param([string]$OrderNo, [string]$InstallCode, [string]$CabinetName, [string]$ImosSize, [string]$StudioSize, [psobject]$Result)

    $Out = [ordered]@{
        "Product Code"     = $OrderNo
        "Install Code"     = $InstallCode
        "Product Name"     = $CabinetName
        "IMOS_Unit Size"   = $ImosSize
        "Studio_Unit Size" = $StudioSize
    }
    foreach ($Name in $ImosOutputColumns.Keys)
    {
        $Out[$Name] = if ($null -ne $Result.Imos) { [string]$Result.Imos[$ImosOutputColumns[$Name]] } else { "" }
    }
    foreach ($Name in $StudioOutputColumns.Keys)
    {
        $Out[$Name] = if ($null -ne $Result.Studio) { [string]$Result.Studio[$StudioOutputColumns[$Name]] } else { "" }
    }
    $Out["Comparison Status"] = $Result.Status
    return [pscustomobject]$Out
}

function Compare-Reports
{
    param([string]$OrderNo, [System.Collections.Specialized.OrderedDictionary]$Imos, [System.Collections.Specialized.OrderedDictionary]$Studio)

    $Output = New-Object System.Collections.Generic.List[psobject]
    $Keys = @(@($Imos.Keys) + @($Studio.Keys) | Select-Object -Unique)

    foreach ($Key in $Keys)
    {
        $IC = if ($Imos.Contains($Key))   { $Imos[$Key] }   else { $null }
        $SC = if ($Studio.Contains($Key)) { $Studio[$Key] } else { $null }

        $Cab        = if ($IC) { $IC } else { $SC }
        $ImosSize   = if ($IC) { $IC.UnitSize } else { "" }
        $StudioSize = if ($SC) { $SC.UnitSize } else { "" }
        $IItems     = @(if ($IC) { $IC.Items })
        $SItems     = @(if ($SC) { $SC.Items })

        $IPanels = @($IItems | Where-Object { $_.Section -eq "Panel" })
        $SPanels = @($SItems | Where-Object { $_.Section -eq "Panel" -and $ExcludeStudioPanels -notcontains [string]$_.Row[$PanelNameCol] })

        $Results = New-Object System.Collections.Generic.List[psobject]
        foreach ($R in (Compare-Panels $IPanels $SPanels)) { $Results.Add($R) }
        foreach ($R in (Compare-Articles @($IItems | Where-Object { $_.Section -eq "Stretchable" }) @($SItems | Where-Object { $_.Section -eq "Stretchable" }) $true))  { $Results.Add($R) }
        foreach ($R in (Compare-Articles @($IItems | Where-Object { $_.Section -eq "Hardware" })    @($SItems | Where-Object { $_.Section -eq "Hardware" })    $false)) { $Results.Add($R) }

        foreach ($R in $Results)
        {
            $Output.Add((New-OutputRow $OrderNo $Cab.InstallCode $Cab.Name $ImosSize $StudioSize $R))
        }
    }
    return ,$Output
}

# ============================================================
# SECTION 4 - Write Output CSV (+ copy to archive)
# ============================================================

function Write-OutputCsv
{
    param([string]$OrderNo, [System.Collections.Generic.List[psobject]]$Rows)

    if ($Rows.Count -eq 0) { throw "The comparison produced no rows." }

    $BaseName   = "$($OrderNo)_OUTPUT_$RunStamp"
    $OutputPath = Get-UniquePath $OutputFolder $BaseName ".csv"

    # UTF-8 with BOM so Excel shows special characters correctly
    $Rows | Export-Csv -LiteralPath $OutputPath -NoTypeInformation -Encoding UTF8

    $ArchiveFolder = Join-Path $ArchiveOutputFolder $OrderNo
    New-FolderIfMissing $ArchiveFolder
    $ArchivePath = Get-UniquePath $ArchiveFolder ([System.IO.Path]::GetFileNameWithoutExtension($OutputPath)) ".csv"
    Copy-Item -LiteralPath $OutputPath -Destination $ArchivePath

    return $OutputPath
}

# ============================================================
# SECTION 5 - Move Input Files to Archive
# Archive\<Input folder>\<Order No>\<Order No>_<Studio|IMOS>_<date_time>.xlsx
# ============================================================

function Move-InputToArchive
{
    param([System.IO.FileInfo]$File, [string]$OrderNo, [string]$Label, [string]$ArchiveRoot)

    $Folder = Join-Path $ArchiveRoot $OrderNo
    New-FolderIfMissing $Folder
    $Target = Get-UniquePath $Folder "$($OrderNo)_$($Label)_$RunStamp" $File.Extension
    try   { Move-Item -LiteralPath $File.FullName -Destination $Target }
    catch { throw "Could not move $Label file '$($File.Name)' to the archive (is it open in Excel?): $($_.Exception.Message)" }
    return $Target
}

# ============================================================
# Pre-checks
# ============================================================

foreach ($Folder in @($StudioInputFolder, $ImosInputFolder))
{
    if (!(Test-Path -LiteralPath $Folder))
    {
        Write-Host "ERROR: Input folder not found: $Folder" -ForegroundColor Red
        Write-Host "       Check the FILE LOCATIONS at the top of the script." -ForegroundColor Red
        exit 1
    }
}
foreach ($Folder in @($OutputFolder, $TempFolder, $ArchiveStudioFolder, $ArchiveImosFolder, $ArchiveOutputFolder))
{
    New-FolderIfMissing $Folder
}

# ============================================================
# Pair Studio and IMOS Files by Order Number
# ============================================================

function Get-InputFiles
{
    param([string]$Folder, [string]$Suffix, [string]$Label)

    $Map = [ordered]@{}
    foreach ($F in @(Get-ChildItem -LiteralPath $Folder -File))
    {
        if ($F.Name.StartsWith('~$')) { continue }   # Excel lock file
        if ($F.Extension -ne ".xlsx")
        {
            $IgnoredFiles.Add("$Label : $($F.Name) (only .xlsx files are processed)")
            continue
        }

        $Base = $F.BaseName
        if ($Suffix -ne "")
        {
            if (-not $Base.EndsWith($Suffix, [System.StringComparison]::OrdinalIgnoreCase))
            {
                $IgnoredFiles.Add("$Label : $($F.Name) (name does not end with '$Suffix')")
                continue
            }
            $Base = $Base.Substring(0, $Base.Length - $Suffix.Length)
        }
        $Map[$Base.Trim().ToUpper()] = $F
    }
    return $Map
}

$StudioFiles = Get-InputFiles $StudioInputFolder ""              "Studio"
$ImosFiles   = Get-InputFiles $ImosInputFolder   $ImosFileSuffix "IMOS"
$AllOrders   = @(@($StudioFiles.Keys) + @($ImosFiles.Keys) | Sort-Object -Unique)

Write-Host "==================================="
Write-Host " Studio Vs IMOS Comparison - $RunStamp"
Write-Host "==================================="

if ($AllOrders.Count -eq 0) { Write-Host "No .xlsx files found in the input folders." -ForegroundColor Yellow }

# ============================================================
# Process Each Order
# ============================================================

$PairCount = 0

foreach ($Key in $AllOrders)
{
    $StudioFile = $StudioFiles[$Key]
    $ImosFile   = $ImosFiles[$Key]

    if ($null -eq $StudioFile) { $UnmatchedFiles.Add("IMOS   : $($ImosFile.Name) - no Studio file '$Key.xlsx'"); continue }
    if ($null -eq $ImosFile)   { $UnmatchedFiles.Add("Studio : $($StudioFile.Name) - no IMOS file '$Key$ImosFileSuffix.xlsx'"); continue }

    $PairCount++
    $OrderNo = $StudioFile.BaseName.Trim()
    $Step    = ""

    Write-Host ""
    Write-Host "Processing $OrderNo ..."

    try
    {
        $Step = "[1] Convert to CSV"
        $OrderTemp = Join-Path $TempFolder $OrderNo
        New-FolderIfMissing $OrderTemp
        $StudioCsv = Get-UniquePath $OrderTemp "$($OrderNo)_Studio_$RunStamp" ".csv"
        $ImosCsv   = Get-UniquePath $OrderTemp "$($OrderNo)_IMOS_$RunStamp"   ".csv"
        Convert-XlsxToCsv $StudioFile.FullName $StudioCsv
        Convert-XlsxToCsv $ImosFile.FullName   $ImosCsv
        Write-Host "  $Step : OK" -ForegroundColor Green

        $Step = "[2] Read structure"
        $Studio = Read-ReportStructure $StudioCsv "Studio" $StudioQtyCol
        $Imos   = Read-ReportStructure $ImosCsv   "IMOS"   $ImosQtyCol
        Write-Host "  $Step : OK (IMOS $($Imos.Count) cabinets, Studio $($Studio.Count) cabinets)" -ForegroundColor Green

        $Step = "[3] Compare"
        $Rows = Compare-Reports $OrderNo $Imos $Studio
        $NotOk = @($Rows | Where-Object { $_.'Comparison Status' -ne $StatusOk }).Count
        Write-Host "  $Step : OK ($($Rows.Count) rows, $NotOk not Ok)" -ForegroundColor Green

        $Step = "[4] Write output"
        $OutputPath = Write-OutputCsv $OrderNo $Rows
        Write-Host "  $Step : $([System.IO.Path]::GetFileName($OutputPath))" -ForegroundColor Green

        $Step = "[5] Archive inputs"
        [void](Move-InputToArchive $StudioFile $OrderNo "Studio" $ArchiveStudioFolder)
        [void](Move-InputToArchive $ImosFile   $OrderNo "IMOS"   $ArchiveImosFolder)
        Write-Host "  $Step : OK" -ForegroundColor Green

        $SuccessOrders.Add("$OrderNo -> $([System.IO.Path]::GetFileName($OutputPath)) ($NotOk rows not Ok)")
    }
    catch
    {
        $FailedOrders.Add($OrderNo)
        $ErrorLog.Add("$OrderNo -> $Step : $($_.Exception.Message)")
        Write-Host "  $Step : FAILED - $($_.Exception.Message)" -ForegroundColor Red
    }
}

# ============================================================
# Final Summary
# ============================================================

Write-Host ""
Write-Host "==================================="
Write-Host " SUMMARY"
Write-Host "==================================="
Write-Host "Pairs found : $PairCount"
Write-Host "Successful  : $($SuccessOrders.Count)" -ForegroundColor Green
foreach ($S in $SuccessOrders) { Write-Host "   + $S" -ForegroundColor Green }

$FailColor = if ($FailedOrders.Count -gt 0) { "Red" } else { "Green" }
Write-Host "Failed      : $($FailedOrders.Count) (left in the input folders)" -ForegroundColor $FailColor
foreach ($E in $ErrorLog) { Write-Host "   - $E" -ForegroundColor Red }

$UnmatchedColor = if ($UnmatchedFiles.Count -gt 0) { "Yellow" } else { "Green" }
Write-Host "Unmatched   : $($UnmatchedFiles.Count) (left in the input folders)" -ForegroundColor $UnmatchedColor
foreach ($U in $UnmatchedFiles) { Write-Host "   ? $U" -ForegroundColor Yellow }

if ($IgnoredFiles.Count -gt 0)
{
    Write-Host "Ignored     : $($IgnoredFiles.Count)" -ForegroundColor Yellow
    foreach ($I in $IgnoredFiles) { Write-Host "   ! $I" -ForegroundColor Yellow }
}

Write-Host "==================================="
Write-Host "Output folder  : $OutputFolder"
Write-Host "Archive folder : $(Split-Path -Parent $ArchiveOutputFolder)"
Write-Host "==================================="

if ($FailedOrders.Count -gt 0 -or $UnmatchedFiles.Count -gt 0) { exit 1 }
