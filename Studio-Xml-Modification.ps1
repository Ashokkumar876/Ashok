# ============================================================
# Studio XML Modification Script
# Version : 2.0
# Author  : Ashok
# ============================================================
#
# PURPOSE
#   Reads every *.xml file in "Studio Xml File Input", finds the matching row
#   in "File Input Name.csv" (XML file name without extension = CSV
#   'File Name'), applies the corrections below and writes the result to
#   "Studio Xml File Output". The original input file is never modified; a
#   backup copy is also kept in "Processed File\<yyyy-MM-dd>".
#
# CSV COLUMNS USED (verified against the sample CSV)
#   File Name | IMOS Order Name | Project ID | Client Name | Room ID | Room Name
#
# CORRECTIONS (each one is an independent numbered section/function)
#   1. Order Number   : <Order ... No="">          <- CSV 'IMOS Order Name'
#   2. Article Number : <ARTICLENO></ARTICLENO>    <- CSV 'Project ID'
#                       (v1.0 wrote this into <COMM>. The Studio XML already
#                       contains an empty <ARTICLENO>, so it is filled and
#                       <COMM> is left untouched. If a file has no
#                       <ARTICLENO>, its <COMM> element is renamed to
#                       <ARTICLENO> instead, so a duplicate is never created.)
#   3. Customer       : <CUSTOMER></CUSTOMER>      <- CSV 'Client Name'
#                       (v1.0 wrote into <CLIENT>, which is now left untouched)
#   4. Room Name      : <TEXT_LONG></TEXT_LONG>    <- CSV 'Room Name'
#                       (v1.0 wrote into <PROGRAM>, which is now left untouched)
#   5. Room ID        : <TEXT_SHORT></TEXT_SHORT>  <- CSV 'Room ID'
#   6. Merge Article  : in every line item's <PVarString>, the value of
#                       ___MERGEARTICLE is set to that line's installCode.
#   7. PVarString clean-up (existing v1.0 behaviour, can be switched off with
#      $EnablePVarCleanup): removes fit / isEdited / remark and re-orders the
#      remaining keys. It changes no values.
#
# OTHER FIXES COMPARED TO v1.0
#   - 'continue' inside ForEach-Object stopped the whole loop at the first
#     unmatched file; a foreach statement is used now.
#   - 'No=""' was replaced everywhere in the file; only the <Order> attribute
#     is changed now.
#   - CSV values are XML-escaped (&, <, >, ") and '$' in values no longer breaks
#     the regex replacement.
#   - Files are read and written as UTF-8 explicitly (Windows PowerShell 5.1
#     would otherwise read them as ANSI).
#   - The result is checked to be well-formed XML before it is saved. A file
#     with any error is not written to the output folder.
#   - A summary of successful files, failed files and errors is printed at the end.
#
# USAGE
#   .\Studio-Xml-Modification.ps1
#   .\Studio-Xml-Modification.ps1 -BasePath "D:\Some\Other\Folder"
# ============================================================

param(
    [string]$BasePath = "O:\DECORIA\Ashok\Studio Xml Validation"
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$InputFolder     = Join-Path $BasePath "Studio Xml File Input"
$OutputFolder    = Join-Path $BasePath "Studio Xml File Output"
$ProcessedFolder = Join-Path $BasePath "Processed File"
$CsvFile         = Join-Path $BasePath "File Input Name.csv"

# Set to $false to switch off Section 7 (the v1.0 PVarString clean-up/re-order)
$EnablePVarCleanup = $true

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# ============================================================
# Helper Functions (shared by the sections)
# ============================================================

# Returns a trimmed CSV value, or throws a clear error if it is empty/missing.
function Get-CsvValue
{
    param([psobject]$Row, [string]$Column)

    $Value = $Row.$Column
    if ([string]::IsNullOrWhiteSpace($Value))
    {
        throw "CSV value '$Column' is empty for File Name '$($Row.'File Name')'."
    }
    return $Value.Trim()
}

# Escapes text so it is safe inside an XML element or attribute.
function ConvertTo-XmlText
{
    param([string]$Text)
    return [System.Security.SecurityElement]::Escape($Text)
}

# Escapes '$' so a value can be used as a regex replacement string.
function ConvertTo-RegexReplacement
{
    param([string]$Text)
    return $Text.Replace('$', '$$')
}

# Sets the text of a single XML element, e.g. <CUSTOMER>...</CUSTOMER>.
# Handles both <TAG></TAG> and <TAG/>. Throws if the element is not found.
function Set-XmlElementValue
{
    param([string]$Content, [string]$TagName, [string]$Value)

    $Escaped     = ConvertTo-RegexReplacement (ConvertTo-XmlText $Value)
    $Tag         = [regex]::Escape($TagName)
    $PairPattern = "(?s)<$Tag>.*?</$Tag>"
    $EmptyPattern = "<$Tag\s*/>"

    if ([regex]::IsMatch($Content, $PairPattern))
    {
        $Regex = New-Object System.Text.RegularExpressions.Regex($PairPattern)
        return $Regex.Replace($Content, "<$TagName>$Escaped</$TagName>", 1)
    }
    if ([regex]::IsMatch($Content, $EmptyPattern))
    {
        $Regex = New-Object System.Text.RegularExpressions.Regex($EmptyPattern)
        return $Regex.Replace($Content, "<$TagName>$Escaped</$TagName>", 1)
    }
    throw "XML element <$TagName> was not found."
}

# ============================================================
# SECTION 1 - Order Number
# <Order ... No="">  <-  CSV 'IMOS Order Name'
# ============================================================

function Update-OrderNumber
{
    param([string]$Content, [psobject]$Row)

    $Value   = Get-CsvValue $Row 'IMOS Order Name'
    $Pattern = '(<Order\b[^>]*?\sNo=")[^"]*(")'

    if (-not [regex]::IsMatch($Content, $Pattern))
    {
        throw "Attribute No=`"`" was not found on the <Order> element."
    }

    $Escaped = ConvertTo-RegexReplacement (ConvertTo-XmlText $Value)
    $Regex   = New-Object System.Text.RegularExpressions.Regex($Pattern)
    return $Regex.Replace($Content, '${1}' + $Escaped + '${2}', 1)
}

# ============================================================
# SECTION 2 - Article Number
# <ARTICLENO></ARTICLENO>  <-  CSV 'Project ID'
# ============================================================

function Update-ArticleNumber
{
    param([string]$Content, [psobject]$Row)

    $Value = Get-CsvValue $Row 'Project ID'

    $HasArticleNo = [regex]::IsMatch($Content, '<ARTICLENO\s*/?>')
    $HasComm      = [regex]::IsMatch($Content, '<COMM\s*/?>')

    if (-not $HasArticleNo)
    {
        if (-not $HasComm)
        {
            throw "Neither <ARTICLENO> nor <COMM> was found."
        }

        # No <ARTICLENO> in this file: rename <COMM> to <ARTICLENO>
        $Regex   = New-Object System.Text.RegularExpressions.Regex('(?s)<COMM>.*?</COMM>|<COMM\s*/>')
        $Content = $Regex.Replace($Content, '<ARTICLENO></ARTICLENO>', 1)
    }

    return Set-XmlElementValue $Content 'ARTICLENO' $Value
}

# ============================================================
# SECTION 3 - Customer
# <CUSTOMER></CUSTOMER>  <-  CSV 'Client Name'
# ============================================================

function Update-Customer
{
    param([string]$Content, [psobject]$Row)

    $Value = Get-CsvValue $Row 'Client Name'
    return Set-XmlElementValue $Content 'CUSTOMER' $Value
}

# ============================================================
# SECTION 4 - Room Name
# <TEXT_LONG></TEXT_LONG>  <-  CSV 'Room Name'
# ============================================================

function Update-RoomName
{
    param([string]$Content, [psobject]$Row)

    $Value = Get-CsvValue $Row 'Room Name'
    return Set-XmlElementValue $Content 'TEXT_LONG' $Value
}

# ============================================================
# SECTION 5 - Room ID
# <TEXT_SHORT></TEXT_SHORT>  <-  CSV 'Room ID'
# ============================================================

function Update-RoomId
{
    param([string]$Content, [psobject]$Row)

    $Value = Get-CsvValue $Row 'Room ID'
    return Set-XmlElementValue $Content 'TEXT_SHORT' $Value
}

# ============================================================
# SECTION 6 - Merge Article
# In every <PVarString>: ___MERGEARTICLE := installCode of the same line
# ============================================================

function Update-MergeArticle
{
    param([string]$Content, [psobject]$Row)

    $Matches6 = [regex]::Matches($Content, '(?s)<PVarString>(.*?)</PVarString>')
    if ($Matches6.Count -eq 0)
    {
        throw "No <PVarString> line items were found."
    }

    $Builder   = New-Object System.Text.StringBuilder
    $LastIndex = 0
    $Missing   = New-Object System.Collections.Generic.List[string]
    $LineNo    = 0

    foreach ($Match in $Matches6)
    {
        $LineNo++
        $PVarData = $Match.Groups[1].Value
        $Items    = $PVarData -split '\|'

        $InstallCode = $null
        foreach ($Item in $Items)
        {
            if ($Item -match '^\s*installCode:=(.*)$')
            {
                $InstallCode = $Matches[1].Trim()
                break
            }
        }

        if ([string]::IsNullOrWhiteSpace($InstallCode))
        {
            $Missing.Add("PVarString #$LineNo")
            $NewPVarData = $PVarData
        }
        else
        {
            $Found = $false
            for ($i = 0; $i -lt $Items.Count; $i++)
            {
                if ($Items[$i] -match '^\s*___MERGEARTICLE:=')
                {
                    $Items[$i] = "___MERGEARTICLE:=$InstallCode"
                    $Found = $true
                }
            }

            $NewPVarData = $Items -join '|'
            if (-not $Found)
            {
                $NewPVarData = $NewPVarData.TrimEnd('|') + "|___MERGEARTICLE:=$InstallCode"
            }
        }

        [void]$Builder.Append($Content, $LastIndex, $Match.Groups[1].Index - $LastIndex)
        [void]$Builder.Append($NewPVarData)
        $LastIndex = $Match.Groups[1].Index + $Match.Groups[1].Length
    }
    [void]$Builder.Append($Content, $LastIndex, $Content.Length - $LastIndex)

    if ($Missing.Count -gt 0)
    {
        throw "installCode is missing in: $($Missing -join ', ')."
    }

    return $Builder.ToString()
}

# ============================================================
# SECTION 7 - PVarString Clean-up (existing v1.0 behaviour)
# Removes fit / isEdited / remark and re-orders the keys. No values change.
# ============================================================

function Update-PVarCleanup
{
    param([string]$Content, [psobject]$Row)

    $RemoveKeys  = @('fit', 'isEdited', 'remark')
    $OrderedKeys = @(
        "offset", "___MERGEARTICLE", "installCode", "CabinetName", "PaintAddOn",
        "WIDTH", "DEPTH", "HEIGHT", "PM_MAT", "PM_SUR_TOP", "PM_SUR_BOT", "PM_EDGE"
    )

    $Evaluator = {
        param($Match)

        $Fields = [ordered]@{}
        foreach ($Item in ($Match.Groups[2].Value -split '\|'))
        {
            if ([string]::IsNullOrWhiteSpace($Item)) { continue }

            $Parts = $Item -split ':=', 2
            if ($Parts.Count -lt 2) { continue }

            $Key = $Parts[0].Trim()
            if ($RemoveKeys -contains $Key) { continue }

            $Fields[$Key] = $Parts[1]
        }

        $Result = New-Object System.Collections.Generic.List[string]
        $Used   = @{}

        # Fixed order first
        foreach ($Key in $OrderedKeys)
        {
            if ($Fields.Contains($Key))
            {
                $Result.Add($Key + ":=" + $Fields[$Key])
                $Used[$Key] = $true
            }
        }
        # Remaining PM_* keys (sorted), then everything else (sorted)
        foreach ($Key in ($Fields.Keys | Where-Object { $_ -like 'PM_*' } | Sort-Object))
        {
            if (-not $Used.ContainsKey($Key)) { $Result.Add($Key + ":=" + $Fields[$Key]); $Used[$Key] = $true }
        }
        foreach ($Key in ($Fields.Keys | Sort-Object))
        {
            if (-not $Used.ContainsKey($Key)) { $Result.Add($Key + ":=" + $Fields[$Key]) }
        }

        return $Match.Groups[1].Value + ($Result -join '|') + $Match.Groups[3].Value
    }.GetNewClosure()

    return [regex]::Replace($Content, '(?s)(<PVarString>)(.*?)(</PVarString>)', $Evaluator)
}

# ============================================================
# Correction Registry
# Add, remove or re-order sections here. Each one runs independently:
# an error in one section is reported but does not stop the others.
# ============================================================

$Corrections = @(
    @{ No = 1; Name = "Order Number";   Action = ${function:Update-OrderNumber} }
    @{ No = 2; Name = "Article Number"; Action = ${function:Update-ArticleNumber} }
    @{ No = 3; Name = "Customer";       Action = ${function:Update-Customer} }
    @{ No = 4; Name = "Room Name";      Action = ${function:Update-RoomName} }
    @{ No = 5; Name = "Room ID";        Action = ${function:Update-RoomId} }
    @{ No = 6; Name = "Merge Article";  Action = ${function:Update-MergeArticle} }
)

if ($EnablePVarCleanup)
{
    $Corrections += @{ No = 7; Name = "PVarString Clean-up"; Action = ${function:Update-PVarCleanup} }
}

# ============================================================
# Pre-checks: folders and CSV
# ============================================================

$SuccessFiles = New-Object System.Collections.Generic.List[string]
$FailedFiles  = New-Object System.Collections.Generic.List[string]
$ErrorLog     = New-Object System.Collections.Generic.List[string]

if (!(Test-Path -LiteralPath $InputFolder))
{
    Write-Host "ERROR: Input folder not found: $InputFolder" -ForegroundColor Red
    exit 1
}
if (!(Test-Path -LiteralPath $CsvFile))
{
    Write-Host "ERROR: CSV file not found: $CsvFile" -ForegroundColor Red
    exit 1
}

foreach ($Folder in @($OutputFolder, $ProcessedFolder))
{
    if (!(Test-Path -LiteralPath $Folder))
    {
        New-Item -ItemType Directory -Path $Folder -Force | Out-Null
    }
}

$Today = Get-Date -Format "yyyy-MM-dd"
$ProcessedDateFolder = Join-Path $ProcessedFolder $Today
if (!(Test-Path -LiteralPath $ProcessedDateFolder))
{
    New-Item -ItemType Directory -Path $ProcessedDateFolder -Force | Out-Null
}

# ============================================================
# Load CSV Data
# ============================================================

try
{
    $CsvData = @(Import-Csv -LiteralPath $CsvFile -Encoding UTF8)
}
catch
{
    Write-Host "ERROR: Could not read CSV '$CsvFile': $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

if ($CsvData.Count -eq 0)
{
    Write-Host "ERROR: CSV '$CsvFile' has no data rows." -ForegroundColor Red
    exit 1
}

$RequiredColumns = @('File Name', 'IMOS Order Name', 'Project ID', 'Client Name', 'Room ID', 'Room Name')
$CsvColumns      = @($CsvData[0].PSObject.Properties.Name)
$MissingColumns  = @($RequiredColumns | Where-Object { $CsvColumns -notcontains $_ })

if ($MissingColumns.Count -gt 0)
{
    Write-Host "ERROR: CSV is missing column(s): $($MissingColumns -join ', ')" -ForegroundColor Red
    Write-Host "       Columns found: $($CsvColumns -join ', ')" -ForegroundColor Red
    exit 1
}

# ============================================================
# Process XML Files
# ============================================================

$XmlFiles = @(Get-ChildItem -LiteralPath $InputFolder -Filter "*.xml" -File)

if ($XmlFiles.Count -eq 0)
{
    Write-Host "No XML files found in $InputFolder" -ForegroundColor Yellow
}

foreach ($XmlFile in $XmlFiles)
{
    $FileNameWithoutExt = [System.IO.Path]::GetFileNameWithoutExtension($XmlFile.Name)
    $FileErrors = New-Object System.Collections.Generic.List[string]

    Write-Host ""
    Write-Host "Processing $($XmlFile.Name)..."

    try
    {
        # ----------------------------------------------------
        # Find Matching CSV Row (case-insensitive, trimmed)
        # ----------------------------------------------------
        $Rows = @($CsvData | Where-Object {
            $_.'File Name' -and $_.'File Name'.Trim() -eq $FileNameWithoutExt
        })

        if ($Rows.Count -eq 0)
        {
            throw "No CSV row with File Name '$FileNameWithoutExt'."
        }
        if ($Rows.Count -gt 1)
        {
            throw "$($Rows.Count) CSV rows have File Name '$FileNameWithoutExt'; expected exactly one."
        }
        $Row = $Rows[0]

        # ----------------------------------------------------
        # Backup Original XML (copy only, the input is not changed)
        # ----------------------------------------------------
        Copy-Item -LiteralPath $XmlFile.FullName `
                  -Destination (Join-Path $ProcessedDateFolder $XmlFile.Name) `
                  -Force

        # ----------------------------------------------------
        # Read XML as UTF-8 text (keeps formatting/line endings)
        # ----------------------------------------------------
        $Content = [System.IO.File]::ReadAllText($XmlFile.FullName, [System.Text.Encoding]::UTF8)

        # ----------------------------------------------------
        # Apply each numbered correction independently
        # ----------------------------------------------------
        foreach ($Correction in $Corrections)
        {
            try
            {
                $Content = & $Correction.Action $Content $Row
                Write-Host "  [$($Correction.No)] $($Correction.Name) : OK" -ForegroundColor Green
            }
            catch
            {
                $Message = "[$($Correction.No)] $($Correction.Name) : $($_.Exception.Message)"
                $FileErrors.Add($Message)
                Write-Host "  $Message" -ForegroundColor Red
            }
        }

        if ($FileErrors.Count -gt 0)
        {
            throw "$($FileErrors.Count) correction(s) failed; output file not written."
        }

        # ----------------------------------------------------
        # Check the result is still well-formed XML
        # ----------------------------------------------------
        try
        {
            $Check = New-Object System.Xml.XmlDocument
            $Check.LoadXml($Content)
        }
        catch
        {
            throw "Result is not valid XML: $($_.Exception.Message)"
        }

        # ----------------------------------------------------
        # Save Output XML (separate folder, UTF-8 without BOM)
        # ----------------------------------------------------
        $OutputFile = Join-Path $OutputFolder $XmlFile.Name
        [System.IO.File]::WriteAllText($OutputFile, $Content, $Utf8NoBom)

        $SuccessFiles.Add($XmlFile.Name)
        Write-Host "Completed : $($XmlFile.Name)" -ForegroundColor Green
    }
    catch
    {
        $FailedFiles.Add($XmlFile.Name)
        foreach ($E in $FileErrors) { $ErrorLog.Add("$($XmlFile.Name) -> $E") }
        $ErrorLog.Add("$($XmlFile.Name) -> $($_.Exception.Message)")
        Write-Host "FAILED    : $($XmlFile.Name) - $($_.Exception.Message)" -ForegroundColor Red
    }
}

# ============================================================
# Final Summary
# ============================================================

Write-Host ""
Write-Host "==================================="
Write-Host " SUMMARY"
Write-Host "==================================="
Write-Host "Total files : $($XmlFiles.Count)"
Write-Host "Successful  : $($SuccessFiles.Count)" -ForegroundColor Green
foreach ($F in $SuccessFiles) { Write-Host "   + $F" -ForegroundColor Green }

$FailColor = if ($FailedFiles.Count -gt 0) { "Red" } else { "Green" }
Write-Host "Failed      : $($FailedFiles.Count)" -ForegroundColor $FailColor
foreach ($F in $FailedFiles) { Write-Host "   - $F" -ForegroundColor Red }

if ($ErrorLog.Count -gt 0)
{
    Write-Host ""
    Write-Host "Errors:" -ForegroundColor Red
    foreach ($E in $ErrorLog) { Write-Host "   $E" -ForegroundColor Red }
}

Write-Host "==================================="
Write-Host "Output folder : $OutputFolder"
Write-Host "Backup folder : $ProcessedDateFolder"
Write-Host "==================================="

if ($FailedFiles.Count -gt 0) { exit 1 }
