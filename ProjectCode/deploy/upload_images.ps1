<#
.SYNOPSIS
  Upload the catalogued images to Cloudflare R2 with rclone.

.DESCRIPTION
  Uploads exactly the images that are in Supabase (public.images.relative_path)
  from WCMC_raw_images_2023_and_others\ to r2:<R2_BUCKET>, using each
  relative_path as the object key. Raw folders dropped by the catalog, the
  IMPORT TEST folders, __MACOSX, "._" files and non-image files are never in
  that list, so they are never uploaded. Run import_to_supabase.py first.

  Credentials come from ProjectCode\.env and reach rclone only as
  RCLONE_CONFIG_R2_* environment variables for this run: no rclone config file
  holds secrets, and the variables are removed again when the script ends.

  Re-runs skip images already in R2 (--update --use-server-modtime: an object
  uploaded after the local file was last modified is up to date), so only new
  or changed images count against R2's free 1M writes per month. Deciding
  from the bucket listing alone avoids one extra request per stored image.

  After an upload, the script compares R2's object count with the database and
  checks 20 random images byte for byte.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\upload_images.ps1 -DryRun
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\upload_images.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\upload_images.ps1 -VerifyOnly
#>
[CmdletBinding()]
param(
    # Show what would be uploaded; upload nothing.
    [switch]$DryRun,
    # Skip the upload; only compare R2 with the database and spot-check 20 images.
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$ImageRoot = Join-Path $ProjectDir 'WCMC_raw_images_2023_and_others'
$EnvFile = Join-Path $ProjectDir '.env'
$ExportKeys = Join-Path $PSScriptRoot 'export_image_keys.py'
$RcloneEnvNames = @('TYPE', 'PROVIDER', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'ENDPOINT',
                    'REGION', 'ACL', 'NO_CHECK_BUCKET') | ForEach-Object { "RCLONE_CONFIG_R2_$_" }

function Read-DotEnv([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "$Path not found. Copy .env.example to .env and fill it in."
    }
    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        $text = $line.Trim()
        if ($text -eq '' -or $text.StartsWith('#')) { continue }
        $eq = $text.IndexOf('=')
        if ($eq -lt 1) { continue }
        $value = $text.Substring($eq + 1).Trim()
        if ($value.Length -ge 2 -and $value[0] -eq $value[-1] -and '"', "'" -contains $value[0]) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $values[$text.Substring(0, $eq).Trim()] = $value
    }
    return $values
}

# Run a native program; stream its output and fail on a non-zero exit code.
# (rclone logs to stderr, which Windows PowerShell would otherwise turn into
# terminating errors under $ErrorActionPreference = 'Stop'.)
function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Exe @Arguments } finally { $ErrorActionPreference = $saved }
    if ($LASTEXITCODE -ne 0) { throw "$Exe $($Arguments[0]) failed (exit code $LASTEXITCODE)." }
}

function Get-LineCount([string]$Path) {
    return [System.IO.File]::ReadAllLines($Path).Length
}

# --- Settings -----------------------------------------------------------------
$config = Read-DotEnv $EnvFile
foreach ($name in 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'SUPABASE_DB_URL') {
    if (-not $config[$name] -or $config[$name] -match '<') {
        throw "$name is not set in $EnvFile."
    }
}
if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) { throw 'rclone is not on PATH.' }
if (-not (Test-Path -LiteralPath $ImageRoot)) { throw "Image folder not found: $ImageRoot" }

$Remote = "r2:$($config['R2_BUCKET'])"
$KeyList = Join-Path $env:TEMP 'water-sample-r2-keys.txt'
$SampleList = Join-Path $env:TEMP 'water-sample-r2-sample.txt'
$DryRunLog = Join-Path $env:TEMP 'water-sample-r2-dry-run.log'

try {
    $env:RCLONE_CONFIG_R2_TYPE = 's3'
    $env:RCLONE_CONFIG_R2_PROVIDER = 'Cloudflare'
    $env:RCLONE_CONFIG_R2_ACCESS_KEY_ID = $config['R2_ACCESS_KEY_ID']
    $env:RCLONE_CONFIG_R2_SECRET_ACCESS_KEY = $config['R2_SECRET_ACCESS_KEY']
    $env:RCLONE_CONFIG_R2_ENDPOINT = "https://$($config['R2_ACCOUNT_ID']).r2.cloudflarestorage.com"
    $env:RCLONE_CONFIG_R2_REGION = 'auto'
    $env:RCLONE_CONFIG_R2_ACL = 'private'
    # Bucket-scoped R2 tokens can't check or create buckets; the bucket already exists.
    $env:RCLONE_CONFIG_R2_NO_CHECK_BUCKET = 'true'

    Write-Host 'Exporting the image list from Supabase ...'
    Invoke-Native 'python' @($ExportKeys, '--out', $KeyList)
    $expected = Get-LineCount $KeyList

    # --- Upload -------------------------------------------------------------------
    if (-not $VerifyOnly) {
        $copyArgs = @('copy', $ImageRoot, $Remote, '--files-from-raw', $KeyList,
                      '--transfers', '32', '--checkers', '32', '--fast-list', '--progress',
                      '--update', '--use-server-modtime')
        if ($DryRun) {
            # One NOTICE line per file would flood the console; keep them in a log.
            Remove-Item -LiteralPath $DryRunLog -ErrorAction SilentlyContinue
            $copyArgs += @('--dry-run', '--log-file', $DryRunLog)
            Write-Host "Dry run: checking $($expected.ToString('N0')) images against $Remote ..."
        } else {
            Write-Host "Uploading up to $($expected.ToString('N0')) images to $Remote (already-uploaded ones are skipped) ..."
        }
        Invoke-Native 'rclone' $copyArgs

        if ($DryRun) {
            $wouldCopy = (Select-String -LiteralPath $DryRunLog -SimpleMatch 'Skipped copy as --dry-run' |
                          Measure-Object).Count
            Write-Host ''
            Write-Host "Dry run: $($wouldCopy.ToString('N0')) of $($expected.ToString('N0')) images would be uploaded;"
            Write-Host "$(($expected - $wouldCopy).ToString('N0')) are already in R2. Nothing was uploaded."
            Write-Host "Per-file details: $DryRunLog"
            return
        }
    }

    # --- Verify -------------------------------------------------------------------
    Write-Host ''
    Write-Host "Counting objects in $Remote ..."
    $size = (Invoke-Native 'rclone' @('size', $Remote, '--fast-list', '--json')) -join '' | ConvertFrom-Json
    $gib = [math]::Round($size.bytes / 1GB, 2)
    Write-Host "  R2: $($size.count.ToString('N0')) objects, $gib GiB"
    Write-Host "  database: $($expected.ToString('N0')) images"
    if ($size.count -eq $expected) {
        Write-Host '  Counts match.'
    } elseif ($size.count -gt $expected) {
        Write-Warning "R2 has $($size.count - $expected) more objects than the database (left over from earlier catalogs?)."
    } else {
        Write-Warning "R2 is missing $($expected - $size.count) images. Re-run this script to upload them."
    }

    Write-Host 'Checking 20 random images byte for byte ...'
    Invoke-Native 'python' @($ExportKeys, '--out', $SampleList, '--sample', '20')
    Invoke-Native 'rclone' @('check', $ImageRoot, $Remote, '--files-from-raw', $SampleList, '--one-way')
    Write-Host 'All 20 sampled images are in R2 under their database key and match the local files.'
}
finally {
    foreach ($name in $RcloneEnvNames) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $KeyList, $SampleList -ErrorAction SilentlyContinue
}
