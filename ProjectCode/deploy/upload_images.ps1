<#
.SYNOPSIS
  Upload the catalogued images to Cloudflare R2 with rclone.

.DESCRIPTION
  Uploads exactly the images that are in Supabase (public.images.relative_path)
  to r2:<R2_BUCKET>, using each relative_path as the object key. Images come
  from two folders, chosen by their source_dataset: the city's 2023 export
  (WCMC_raw_2023: WCMC_raw_images_2023_and_others\) and the runs exported
  from the FlowCam VBD files (FlowCam_VBD: vbd_export\, written by
  Flowcam_VBD_File_Format\export_all.py). Raw folders dropped by the catalog,
  the IMPORT TEST folders, __MACOSX, "._" files and non-image files are never
  in that list, so they are never uploaded. Run import_to_supabase.py first.

  Credentials come from ProjectCode\.env and reach rclone only as
  RCLONE_CONFIG_R2_* environment variables for this run: no rclone config file
  holds secrets, and the variables are removed again when the script ends.

  Re-runs skip images already in R2 (--update --use-server-modtime: an object
  uploaded after the local file was last modified is up to date), so only new
  or changed images count against R2's free 1M writes per month. Deciding
  from the bucket listing alone avoids one extra request per stored image.

  After the images it builds the dashboard's measurement filter files
  (build_filter_data.py) and uploads them to _filters/<version>/, then
  _filters/current.json last, so visitors only ever see a complete version.

  After an upload, the script compares R2's object count with the database and
  checks 20 random images from each folder byte for byte.

  -Prune deletes the objects in R2 that are no longer in the database (images
  the catalog dropped, and filter files older than the version current.json
  names) instead of uploading; with -DryRun it only lists them.
  It refuses if the database returns no keys, or if more than 20% of the
  bucket would go, so a failed export can't empty R2. The local copies are
  kept, so anything pruned can be uploaded again.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\upload_images.ps1 -DryRun
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\upload_images.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\upload_images.ps1 -VerifyOnly
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\upload_images.ps1 -Prune -DryRun
#>
[CmdletBinding()]
param(
    # Show what would be uploaded (or, with -Prune, deleted); change nothing.
    [switch]$DryRun,
    # Skip the upload; only compare R2 with the database and spot-check 20 images.
    [switch]$VerifyOnly,
    # Delete objects that are no longer in the database instead of uploading.
    [switch]$Prune
)

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
# Each source_dataset's images live in their own folder, under the same
# "<folder>\<file>" layout, so the object key works for both.
$Sources = @(
    @{ Tag = 'WCMC_raw_2023'; Root = (Join-Path $ProjectDir 'WCMC_raw_images_2023_and_others') },
    @{ Tag = 'FlowCam_VBD';   Root = (Join-Path $ProjectDir 'vbd_export') }
)
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
$Remote = "r2:$($config['R2_BUCKET'])"
$KeyList = Join-Path $env:TEMP 'water-sample-r2-keys.txt'
$SourceList = Join-Path $env:TEMP 'water-sample-r2-source-keys.txt'
$SampleList = Join-Path $env:TEMP 'water-sample-r2-sample.txt'
$DryRunLog = Join-Path $env:TEMP 'water-sample-r2-dry-run.log'
$PruneList = Join-Path $env:TEMP 'water-sample-r2-prune.txt'
$BuildFilters = Join-Path $PSScriptRoot 'build_filter_data.py'
$FilterDir = Join-Path $ProjectDir 'catalog_output\filter_data'

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

    # Which folders hold images, and how many each.
    $active = @()
    $covered = 0
    foreach ($source in $Sources) {
        Invoke-Native 'python' @($ExportKeys, '--out', $SourceList, '--source', $source.Tag)
        $count = Get-LineCount $SourceList
        $covered += $count
        if ($count -eq 0) { continue }
        if (-not (Test-Path -LiteralPath $source.Root)) {
            throw "$($count.ToString('N0')) images come from $($source.Tag), but $($source.Root) is missing."
        }
        $active += @{ Tag = $source.Tag; Root = $source.Root; Count = $count }
    }
    if ($covered -ne $expected) {
        Write-Warning "$(($expected - $covered).ToString('N0')) images have a source_dataset this script has no folder for; they're skipped."
    }

    # --- Prune --------------------------------------------------------------------
    if ($Prune) {
        if ($expected -eq 0) { throw 'The database returned no image keys; refusing to prune.' }
        Write-Host "Listing the objects in $Remote ..."
        # Object keys can hold any character in a folder name: read rclone's output as UTF-8.
        $savedEncoding = [Console]::OutputEncoding
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        try { $stored = @(Invoke-Native 'rclone' @('lsf', $Remote, '-R', '--files-only', '--fast-list')) }
        finally { [Console]::OutputEncoding = $savedEncoding }
        $keep = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
        foreach ($key in [System.IO.File]::ReadAllLines($KeyList)) { [void]$keep.Add($key) }
        # Filter files: keep the version visitors use now (as R2 says, not this
        # laptop); older ones go. If R2 has no current.json, keep all of them.
        $live = $null
        if ($stored -contains '_filters/current.json') {
            $live = ((Invoke-Native 'rclone' @('cat', "$Remote/_filters/current.json")) -join '' | ConvertFrom-Json).version
        }
        $extra = @($stored | Where-Object {
            $_ -and -not $keep.Contains($_) -and $_ -ne '_filters/current.json' -and
            -not ($_.StartsWith('_filters/') -and ($null -eq $live -or $_.StartsWith("_filters/$live/")))
        })
        Write-Host "  R2: $($stored.Count.ToString('N0')) objects; $($extra.Count.ToString('N0')) are no longer in the database."
        if ($extra.Count -eq 0) { return }
        if ($extra.Count -gt 0.2 * $stored.Count) {
            throw "Refusing to delete $($extra.Count.ToString('N0')) of $($stored.Count.ToString('N0')) objects (over 20%). Check the database first."
        }
        $extra | Select-Object -First 10 | ForEach-Object { Write-Host "    $_" }
        if ($extra.Count -gt 10) { Write-Host "    ... and $(($extra.Count - 10).ToString('N0')) more" }
        if ($DryRun) {
            Write-Host 'Dry run: nothing was deleted.'
            return
        }
        [System.IO.File]::WriteAllLines($PruneList, [string[]]$extra, (New-Object System.Text.UTF8Encoding $false))
        Write-Host "Deleting $($extra.Count.ToString('N0')) objects ..."
        Invoke-Native 'rclone' @('delete', $Remote, '--files-from-raw', $PruneList, '--checkers', '32')
    }

    # --- Upload -------------------------------------------------------------------
    if (-not $VerifyOnly -and -not $Prune) {
        $wouldCopy = 0
        foreach ($source in $active) {
            Invoke-Native 'python' @($ExportKeys, '--out', $SourceList, '--source', $source.Tag)
            $copyArgs = @('copy', $source.Root, $Remote, '--files-from-raw', $SourceList,
                          '--transfers', '32', '--checkers', '32', '--fast-list', '--progress',
                          '--update', '--use-server-modtime')
            if ($DryRun) {
                # One NOTICE line per file would flood the console; keep them in a log.
                Remove-Item -LiteralPath $DryRunLog -ErrorAction SilentlyContinue
                $copyArgs += @('--dry-run', '--log-file', $DryRunLog)
                Write-Host "Dry run: checking $($source.Count.ToString('N0')) $($source.Tag) images from $($source.Root) ..."
            } else {
                Write-Host "Uploading up to $($source.Count.ToString('N0')) $($source.Tag) images from $($source.Root) (already-uploaded ones are skipped) ..."
            }
            Invoke-Native 'rclone' $copyArgs

            if ($DryRun) {
                $n = (Select-String -LiteralPath $DryRunLog -SimpleMatch 'Skipped copy as --dry-run' |
                      Measure-Object).Count
                $wouldCopy += $n
                Write-Host "  $($source.Tag): $($n.ToString('N0')) of $($source.Count.ToString('N0')) would be uploaded."
            }
        }

        # The dashboard's measurement filter files: the version's folder first,
        # current.json (which points visitors at it) last.
        Write-Host 'Building the measurement filter files ...'
        Invoke-Native 'python' @($BuildFilters)
        $version = (Get-Content -Raw -LiteralPath (Join-Path $FilterDir 'current.json') | ConvertFrom-Json).version
        $filterArgs = @('copy', (Join-Path $FilterDir $version), "$Remote/_filters/$version", '--fast-list')
        $currentArgs = @('copyto', (Join-Path $FilterDir 'current.json'), "$Remote/_filters/current.json")
        if ($DryRun) {
            $filterArgs += @('--dry-run', '--log-file', $DryRunLog)
            $currentArgs += @('--dry-run', '--log-file', $DryRunLog)
        }
        Write-Host "Uploading the filter files (version $version) ..."
        Invoke-Native 'rclone' $filterArgs
        Invoke-Native 'rclone' $currentArgs

        if ($DryRun) {
            Write-Host ''
            Write-Host "Dry run: $($wouldCopy.ToString('N0')) of $($expected.ToString('N0')) images would be uploaded;"
            Write-Host "$(($expected - $wouldCopy).ToString('N0')) are already in R2. Nothing was uploaded."
            return
        }
    }

    # --- Verify -------------------------------------------------------------------
    Write-Host ''
    Write-Host "Counting objects in $Remote ..."
    $size = (Invoke-Native 'rclone' @('size', $Remote, '--fast-list', '--json', '--exclude', '_filters/**')) -join '' | ConvertFrom-Json
    $gib = [math]::Round($size.bytes / 1GB, 2)
    Write-Host "  R2: $($size.count.ToString('N0')) images, $gib GiB (not counting the filter files)"
    Write-Host "  database: $($expected.ToString('N0')) images"
    if ($size.count -eq $expected) {
        Write-Host '  Counts match.'
    } elseif ($size.count -gt $expected) {
        Write-Warning "R2 has $($size.count - $expected) more objects than the database (left over from earlier catalogs?)."
    } else {
        Write-Warning "R2 is missing $($expected - $size.count) images. Re-run this script to upload them."
    }

    foreach ($source in $active) {
        Write-Host "Checking 20 random $($source.Tag) images byte for byte ..."
        Invoke-Native 'python' @($ExportKeys, '--out', $SampleList, '--sample', '20', '--source', $source.Tag)
        Invoke-Native 'rclone' @('check', $source.Root, $Remote, '--files-from-raw', $SampleList, '--one-way')
        Write-Host "  All sampled $($source.Tag) images are in R2 under their database key and match the local files."
    }
}
finally {
    foreach ($name in $RcloneEnvNames) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $KeyList, $SourceList, $SampleList, $PruneList -ErrorAction SilentlyContinue
}
