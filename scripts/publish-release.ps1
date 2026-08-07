param(
  [string]$ReleaseDir = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
if (-not $ReleaseDir) {
  $ReleaseDir = Join-Path $Root "artifacts"
}
$ReleaseDir = [System.IO.Path]::GetFullPath($ReleaseDir)
$UploadToken = $env:TONGPIN_RELEASE_UPLOAD_TOKEN
$SecureUploadBaseUrl = "https://notify.samhubs.com/internal/releases"
$PublicReleaseBaseUrl = "https://notify.samhubs.com/releases"
$PartBytes = 5 * 1024 * 1024
$MaxAttempts = 10

if ([string]::IsNullOrWhiteSpace($UploadToken)) {
  throw "TONGPIN_RELEASE_UPLOAD_TOKEN is required."
}

& node (Join-Path $PSScriptRoot "publish-release.mjs") --verify-only
if ($LASTEXITCODE -ne 0) {
  throw "Local release verification failed."
}

$Package = Get-Content -Raw -Encoding UTF8 (Join-Path $Root "package.json") |
  ConvertFrom-Json
$Version = [string]$Package.version
$InstallerName = "Tongpin-Setup-$Version.exe"
$BlockmapName = "$InstallerName.blockmap"
$InstallerPath = Join-Path $ReleaseDir $InstallerName
$BlockmapPath = Join-Path $ReleaseDir $BlockmapName
$ManifestPath = Join-Path $ReleaseDir "latest.yml"
$Authorization = "Bearer $UploadToken"

function Get-ResponseStatus($ErrorRecord) {
  if ($ErrorRecord.Exception.Response) {
    return [int]$ErrorRecord.Exception.Response.StatusCode
  }
  return 0
}

function Test-RetryableStatus([int]$Status) {
  return $Status -eq 0 -or
    $Status -eq 401 -or
    $Status -eq 403 -or
    $Status -eq 404 -or
    $Status -eq 408 -or
    $Status -eq 425 -or
    $Status -eq 429 -or
    $Status -ge 500
}

function Invoke-RetryableBinaryPut {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][byte[]]$Body
  )

  for ($Attempt = 1; $Attempt -le $MaxAttempts; $Attempt += 1) {
    try {
      return Invoke-RestMethod `
        -Method Put `
        -Uri $Uri `
        -Headers @{
          Authorization = $Authorization
          "Content-Length" = [string]$Body.Length
        } `
        -ContentType "application/octet-stream" `
        -Body $Body `
        -TimeoutSec 120
    } catch {
      $Status = Get-ResponseStatus $_
      if (
        $Attempt -eq $MaxAttempts -or
        -not (Test-RetryableStatus $Status)
      ) {
        throw
      }
      Write-Host "Transient upload failure on attempt $Attempt; retrying."
      Start-Sleep -Seconds ([Math]::Min(5, $Attempt))
    }
  }
}

function Wait-UploadToken {
  for ($Attempt = 1; $Attempt -le 30; $Attempt += 1) {
    try {
      Invoke-WebRequest `
        -UseBasicParsing `
        -Method Post `
        -Uri "$SecureUploadBaseUrl/multipart/start" `
        -Headers @{ Authorization = $Authorization } `
        -ContentType "application/json" `
        -Body '{"key":"invalid.tmp"}' `
        -TimeoutSec 20 | Out-Null
      $Status = 200
    } catch {
      $Status = Get-ResponseStatus $_
    }
    if ($Status -eq 400) {
      Start-Sleep -Seconds 5
      return
    }
    Start-Sleep -Seconds 2
  }
  throw "The temporary Cloudflare upload token did not propagate in 60 seconds."
}

function Send-SmallObject {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Key
  )

  $Body = [System.IO.File]::ReadAllBytes($Path)
  $Uri = "$SecureUploadBaseUrl/object?key=$([uri]::EscapeDataString($Key))"
  Invoke-RetryableBinaryPut -Uri $Uri -Body $Body | Out-Null
}

function Send-MultipartInstaller {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Key
  )

  $Size = (Get-Item -LiteralPath $Path).Length
  $PartCount = [Math]::Ceiling($Size / $PartBytes)
  $Started = Invoke-RestMethod `
    -Method Post `
    -Uri "$SecureUploadBaseUrl/multipart/start" `
    -Headers @{ Authorization = $Authorization } `
    -ContentType "application/json" `
    -Body (@{ key = $Key } | ConvertTo-Json -Compress) `
    -TimeoutSec 30
  $UploadId = [string]$Started.uploadId
  $Parts = New-Object "System.Collections.Generic.List[object]"
  $Stream = [System.IO.File]::Open(
    $Path,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::Read
  )

  try {
    $Offset = [int64]0
    $PartNumber = 1
    while ($Offset -lt $Size) {
      $Length = [int][Math]::Min($PartBytes, $Size - $Offset)
      $Buffer = New-Object byte[] $Length
      $ReadTotal = 0
      while ($ReadTotal -lt $Length) {
        $Read = $Stream.Read($Buffer, $ReadTotal, $Length - $ReadTotal)
        if ($Read -le 0) {
          throw "Installer part read ended early."
        }
        $ReadTotal += $Read
      }

      Write-Host "Uploading installer part $PartNumber/$PartCount"
      $PartUri =
        "$SecureUploadBaseUrl/multipart/part" +
        "?key=$([uri]::EscapeDataString($Key))" +
        "&uploadId=$([uri]::EscapeDataString($UploadId))" +
        "&partNumber=$PartNumber"
      $Part = Invoke-RetryableBinaryPut -Uri $PartUri -Body $Buffer
      $Parts.Add(
        [pscustomobject]@{
          partNumber = [int]$Part.partNumber
          etag = [string]$Part.etag
        }
      )
      $Offset += $Length
      $PartNumber += 1
    }

    $CompleteBody = @{
      key = $Key
      uploadId = $UploadId
      parts = $Parts.ToArray()
    } | ConvertTo-Json -Depth 6 -Compress
    Invoke-RestMethod `
      -Method Post `
      -Uri "$SecureUploadBaseUrl/multipart/complete" `
      -Headers @{ Authorization = $Authorization } `
      -ContentType "application/json" `
      -Body $CompleteBody `
      -TimeoutSec 60 | Out-Null
  } catch {
    try {
      Invoke-WebRequest `
        -UseBasicParsing `
        -Method Post `
        -Uri "$SecureUploadBaseUrl/multipart/abort" `
        -Headers @{ Authorization = $Authorization } `
        -ContentType "application/json" `
        -Body (@{
          key = $Key
          uploadId = $UploadId
        } | ConvertTo-Json -Compress) `
        -TimeoutSec 30 | Out-Null
    } catch {
      Write-Warning "Could not confirm the incomplete R2 upload was aborted."
    }
    throw
  } finally {
    $Stream.Dispose()
  }

  return @{
    size = $Size
    parts = $Parts.Count
  }
}

Wait-UploadToken
$InstallerResult = Send-MultipartInstaller `
  -Path $InstallerPath `
  -Key $InstallerName

Write-Host "Uploading $BlockmapName"
Send-SmallObject -Path $BlockmapPath -Key $BlockmapName

# Publish the manifest last so clients never see an incomplete release.
Write-Host "Uploading latest.yml"
Send-SmallObject -Path $ManifestPath -Key "latest.yml"

$CacheBust = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$RemoteInstaller = Invoke-WebRequest `
  -UseBasicParsing `
  -Method Head `
  -Uri "$PublicReleaseBaseUrl/$InstallerName`?verify=$CacheBust" `
  -TimeoutSec 30
if ([int64]$RemoteInstaller.Headers["Content-Length"] -ne $InstallerResult.size) {
  throw "Remote installer size does not match the local installer."
}
$RemoteManifestResponse = Invoke-WebRequest `
  -UseBasicParsing `
  -Uri "$PublicReleaseBaseUrl/latest.yml?verify=$CacheBust" `
  -TimeoutSec 30
$RemoteManifest = [System.Text.Encoding]::UTF8.GetString(
  [byte[]]$RemoteManifestResponse.Content
)
if ($RemoteManifest -notmatch "version:\s*$([regex]::Escape($Version))") {
  throw "Remote latest.yml does not point to version $Version."
}

[pscustomobject]@{
  version = $Version
  installer = $InstallerName
  installerBytes = $InstallerResult.size
  parts = $InstallerResult.parts
  remoteStatus = [int]$RemoteInstaller.StatusCode
  verified = $true
} | ConvertTo-Json -Compress
