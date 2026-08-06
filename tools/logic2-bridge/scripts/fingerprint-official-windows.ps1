param(
  [Parameter(Mandatory = $true)]
  [string]$PackageUrl,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Invoke-CheckedProcess {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [Parameter(Mandatory = $true)]
    [string[]]$ArgumentList,

    [int[]]$SuccessCodes = @(0)
  )

  $process = Start-Process -FilePath $FilePath `
    -ArgumentList $ArgumentList `
    -Wait `
    -NoNewWindow `
    -PassThru
  if ($SuccessCodes -notcontains $process.ExitCode) {
    throw "$FilePath exited with code $($process.ExitCode)"
  }
}

function Find-GraphServer {
  param([string[]]$Roots)

  foreach ($root in $Roots | Select-Object -Unique) {
    if (-not $root -or -not (Test-Path -LiteralPath $root)) {
      continue
    }
    $graph = Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Name -in @('graph_server_shared.dll', 'libgraph_server_shared.dll')
      } |
      Select-Object -First 1
    if ($graph) {
      return $graph
    }
  }
  return $null
}

$workRoot = Join-Path $env:RUNNER_TEMP 'logic2-4-46-windows-fingerprint'
$extractRoot = Join-Path $workRoot 'extracted'
$adminRoot = Join-Path $workRoot 'administrative-image'
$installRoot = Join-Path $workRoot 'installed'
$installer = Join-Path $workRoot 'Logic-2.4.46-windows-x64.exe'

New-Item -ItemType Directory -Force -Path $workRoot, $extractRoot, $adminRoot, $installRoot |
  Out-Null
Invoke-WebRequest -Uri $PackageUrl -OutFile $installer

$searchRoots = @($extractRoot, $adminRoot)
try {
  Invoke-CheckedProcess -FilePath $installer -ArgumentList @('/extract', $extractRoot)
  $msi = Get-ChildItem -LiteralPath $extractRoot -Recurse -File -Filter *.msi |
    Select-Object -First 1
  if ($msi) {
    Invoke-CheckedProcess -FilePath 'msiexec.exe' `
      -ArgumentList @('/a', $msi.FullName, '/qn', "TARGETDIR=$adminRoot") `
      -SuccessCodes @(0, 3010)
  } else {
    Write-Warning 'Advanced Installer /extract did not produce an MSI; trying a silent temporary install'
  }
} catch {
  Write-Warning "Administrative extraction failed: $($_.Exception.Message)"
}

$graph = Find-GraphServer -Roots $searchRoots
if (-not $graph) {
  Invoke-CheckedProcess -FilePath $installer `
    -ArgumentList @('/exenoui', '/qn', "APPDIR=$installRoot") `
    -SuccessCodes @(0, 3010)
  $searchRoots += @(
    $installRoot,
    (Join-Path $env:LOCALAPPDATA 'Programs'),
    (Join-Path $env:LOCALAPPDATA 'Saleae Inc'),
    $env:ProgramFiles
  )
  $graph = Find-GraphServer -Roots $searchRoots
}

if (-not $graph) {
  Write-Host 'Files produced while extracting the installer:'
  foreach ($root in $searchRoots | Select-Object -Unique) {
    if (Test-Path -LiteralPath $root) {
      Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
        Select-Object -First 200 -ExpandProperty FullName
    }
  }
  throw 'GraphServer DLL was not found in the extracted or installed Logic package'
}

Write-Host "GraphServer: $($graph.FullName)"
& node tools/logic2-bridge/scripts/fingerprint-binary.cjs $graph.FullName |
  Tee-Object -FilePath $OutputPath
if ($LASTEXITCODE -ne 0) {
  throw "fingerprint-binary.cjs exited with code $LASTEXITCODE"
}
