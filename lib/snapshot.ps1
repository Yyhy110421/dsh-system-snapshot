param(
  [Parameter(Mandatory = $true)][string]$RequestFile
)

# 和 window-sweeper 一样：Node 捕获 stdout 时 Windows PowerShell 5.1 会按 ANSI 写，
# 所以统一把 JSON 里的非 ASCII 字符转成 \uXXXX，管道里永远是纯 ASCII。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function ConvertTo-AsciiJson($value) {
  $json = $value | ConvertTo-Json -Compress -Depth 20
  if ($null -eq $json) { return 'null' }
  return [regex]::Replace($json, '[^\u0000-\u007F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
}

function Write-Result($value) {
  ConvertTo-AsciiJson $value
  exit 0
}

function Write-Failure([string]$message) {
  ConvertTo-AsciiJson ([ordered]@{ ok = $false; error = $message })
  exit 1
}

function Convert-RegValue($raw, [string]$kind) {
  if ($null -eq $raw) { return $null }
  if ($raw -is [byte[]]) { return [Convert]::ToBase64String($raw) }
  if ($raw -is [array]) { return @($raw | ForEach-Object { [string]$_ }) }
  if ($raw -is [int] -or $raw -is [long]) { return $raw }
  return [string]$raw
}

function Read-RegKey([string]$spec) {
  $parts = $spec -split '\\', 2
  if ($parts.Count -lt 2) { throw "注册表键不完整：$spec" }
  $hive = $parts[0].ToUpperInvariant()
  if ($hive -eq 'HKCU') { $base = [Microsoft.Win32.Registry]::CurrentUser }
  elseif ($hive -eq 'HKLM') { $base = [Microsoft.Win32.Registry]::LocalMachine }
  else { throw "不支持的注册表根：$hive" }

  $key = $base.OpenSubKey($parts[1], $false)
  if ($null -eq $key) {
    return [pscustomobject]@{ exists = $false; values = @(); subKeys = @() }
  }
  try {
    $values = @()
    foreach ($name in @($key.GetValueNames())) {
      $kind = 'Unknown'
      try { $kind = $key.GetValueKind($name).ToString() } catch { }
      $raw = $null
      try {
        $raw = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      } catch {
        $raw = $null
      }
      $values += [pscustomobject]@{
        name = [string]$name
        kind = [string]$kind
        value = Convert-RegValue $raw $kind
      }
    }
    $subKeys = @($key.GetSubKeyNames() | ForEach-Object { [string]$_ })
    return [pscustomobject]@{ exists = $true; values = @($values); subKeys = @($subKeys) }
  } finally {
    $key.Close()
  }
}

function Read-Env([string]$scope) {
  $vars = [Environment]::GetEnvironmentVariables($scope)
  $items = @()
  foreach ($entry in ($vars.GetEnumerator() | Sort-Object Name)) {
    $items += [pscustomobject]@{
      name = [string]$entry.Key
      value = [string]$entry.Value
    }
  }
  return @($items)
}

function Read-Hosts {
  $path = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
  if (-not (Test-Path -LiteralPath $path)) {
    return [pscustomobject]@{ path = $path; exists = $false; sha256 = ''; content = '' }
  }
  $content = [System.IO.File]::ReadAllText($path)
  $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  return [pscustomobject]@{ path = $path; exists = $true; sha256 = $hash; content = $content }
}

function Read-Services {
  try {
    $items = @(
      Get-Service -ErrorAction Stop | Sort-Object Name | ForEach-Object {
        [pscustomobject]@{
          name = [string]$_.Name
          displayName = [string]$_.DisplayName
          status = [string]$_.Status
          startType = [string]$_.StartType
        }
      }
    )
    return [pscustomobject]@{ available = $true; items = @($items) }
  } catch {
    return [pscustomobject]@{ available = $false; error = $_.Exception.Message; items = @() }
  }
}

function Read-Firewall {
  try {
    $items = @(
      Get-NetFirewallRule -PolicyStore ActiveStore -ErrorAction Stop | Sort-Object Name | ForEach-Object {
        [pscustomobject]@{
          name = [string]$_.Name
          displayName = [string]$_.DisplayName
          enabled = [string]$_.Enabled
          direction = [string]$_.Direction
          action = [string]$_.Action
          profile = [string]$_.Profile
        }
      }
    )
    return [pscustomobject]@{ available = $true; items = @($items) }
  } catch {
    return [pscustomobject]@{ available = $false; error = $_.Exception.Message; items = @() }
  }
}

function Read-ScheduledTasks {
  try {
    $items = @(
      Get-ScheduledTask -ErrorAction Stop | Sort-Object TaskPath, TaskName | ForEach-Object {
        [pscustomobject]@{
          path = [string]$_.TaskPath
          name = [string]$_.TaskName
          state = [string]$_.State
        }
      }
    )
    return [pscustomobject]@{ available = $true; items = @($items) }
  } catch {
    return [pscustomobject]@{ available = $false; error = $_.Exception.Message; items = @() }
  }
}

function Set-RegValue($key, [string]$name, $entry) {
  $kind = [string]$entry.kind
  $value = $entry.value
  switch ($kind) {
    'String' {
      $key.SetValue($name, [string]$value, [Microsoft.Win32.RegistryValueKind]::String)
      return
    }
    'ExpandString' {
      $key.SetValue($name, [string]$value, [Microsoft.Win32.RegistryValueKind]::ExpandString)
      return
    }
    'DWord' {
      $key.SetValue($name, [int]$value, [Microsoft.Win32.RegistryValueKind]::DWord)
      return
    }
    'QWord' {
      $key.SetValue($name, [long]$value, [Microsoft.Win32.RegistryValueKind]::QWord)
      return
    }
    'MultiString' {
      $array = @($value | ForEach-Object { [string]$_ })
      $key.SetValue($name, [string[]]$array, [Microsoft.Win32.RegistryValueKind]::MultiString)
      return
    }
    'Binary' {
      $bytes = [Convert]::FromBase64String([string]$value)
      $key.SetValue($name, $bytes, [Microsoft.Win32.RegistryValueKind]::Binary)
      return
    }
    default {
      throw "不支持的注册表类型：$kind"
    }
  }
}

function Invoke-Create($request) {
  $settings = $request.settings
  if ($null -eq $settings) { throw '请求缺少 settings。' }
  $outFile = [string]$request.outFile
  if ($outFile -eq '') { throw '请求缺少 outFile。' }
  $outDir = Split-Path -Parent $outFile
  if (-not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  }

  $registryKeys = [ordered]@{}
  foreach ($spec in @($settings.registryKeys)) {
    $normalized = [string]$spec
    if ($normalized -eq '') { continue }
    try {
      $registryKeys[$normalized] = Read-RegKey $normalized
    } catch {
      $registryKeys[$normalized] = [pscustomobject]@{
        exists = $false
        values = @()
        subKeys = @()
        error = $_.Exception.Message
      }
    }
  }

  $hosts = $null
  if ($settings.includeHosts -ne $false) {
    $hosts = Read-Hosts
  } else {
    $hosts = [pscustomobject]@{ enabled = $false; path = ''; exists = $false; sha256 = ''; content = '' }
  }

  if ($settings.includeEnvUser -ne $false) {
    $envUser = [pscustomobject]@{ enabled = $true; values = @(Read-Env 'User') }
  } else {
    $envUser = [pscustomobject]@{ enabled = $false; values = @() }
  }

  if ($settings.includeEnvMachine -ne $false) {
    $envMachine = [pscustomobject]@{ enabled = $true; values = @(Read-Env 'Machine') }
  } else {
    $envMachine = [pscustomobject]@{ enabled = $false; values = @() }
  }

  if ($settings.includeServices -ne $false) {
    $services = Read-Services
  } else {
    $services = [pscustomobject]@{ enabled = $false; available = $true; items = @() }
  }

  if ($settings.includeFirewall -ne $false) {
    $firewall = Read-Firewall
  } else {
    $firewall = [pscustomobject]@{ enabled = $false; available = $true; items = @() }
  }

  if ($settings.includeScheduledTasks -ne $false) {
    $scheduledTasks = Read-ScheduledTasks
  } else {
    $scheduledTasks = [pscustomobject]@{ enabled = $false; available = $true; items = @() }
  }

  $registryValues = 0
  foreach ($entry in $registryKeys.Values) {
    if ($entry.values) { $registryValues += @($entry.values).Count }
  }
  $hostsLines = 0
  if ($hosts -and $hosts.content) {
    $hostsLines = @([regex]::Split([string]$hosts.content, '\r?\n')).Count
  }

  $categories = [ordered]@{
    registry = [ordered]@{ keys = $registryKeys }
    hosts = $hosts
    envUser = $envUser
    envMachine = $envMachine
    services = $services
    firewall = $firewall
    scheduledTasks = $scheduledTasks
  }
  $counts = [ordered]@{
    registryKeys = $registryKeys.Count
    registryValues = $registryValues
    hostsLines = $hostsLines
    envUser = @($envUser.values).Count
    envMachine = @($envMachine.values).Count
    services = @($services.items).Count
    firewall = @($firewall.items).Count
    scheduledTasks = @($scheduledTasks.items).Count
  }

  $payload = [ordered]@{ categories = $categories; counts = $counts }
  $json = $payload | ConvertTo-Json -Depth 20 -Compress
  [System.IO.File]::WriteAllText($outFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Result ([ordered]@{ ok = $true; outFile = $outFile; counts = $counts })
}

function Invoke-Restore($request) {
  $snapshot = $request.snapshot
  if ($null -eq $snapshot) { throw '请求缺少快照内容。' }
  $categories = @($request.categories)
  $restored = @()
  $skipped = @()
  $errors = @()

  if ($categories -contains 'registry') {
    $keys = $snapshot.categories.registry.keys
    foreach ($prop in $keys.PSObject.Properties) {
      $spec = [string]$prop.Name
      $entry = $prop.Value
      if (-not $entry.exists) {
        $skipped += "注册表键在快照中不存在：$spec"
        continue
      }
      $parts = $spec -split '\\', 2
      if ($parts.Count -lt 2) {
        $errors += "注册表键不完整：$spec"
        continue
      }
      $hive = $parts[0].ToUpperInvariant()
      if ($hive -eq 'HKCU') { $base = [Microsoft.Win32.Registry]::CurrentUser }
      elseif ($hive -eq 'HKLM') { $base = [Microsoft.Win32.Registry]::LocalMachine }
      else {
        $errors += "不支持的注册表根：$hive"
        continue
      }
      try {
        $key = $base.CreateSubKey($parts[1], $true)
        if ($null -eq $key) { throw 'CreateSubKey 返回空。' }
        $desired = New-Object 'System.Collections.Generic.HashSet[string]'
        foreach ($valueEntry in @($entry.values)) {
          $name = [string]$valueEntry.name
          [void]$desired.Add($name)
          try {
            Set-RegValue $key $name $valueEntry
          } catch {
            $errors += "注册表值 $spec::$name：$($_.Exception.Message)"
          }
        }
        foreach ($name in @($key.GetValueNames())) {
          $textName = [string]$name
          if (-not $desired.Contains($textName)) {
            try { $key.DeleteValue($textName, $false) } catch {
              $errors += "删除注册表值 $spec::$textName：$($_.Exception.Message)"
            }
          }
        }
        $key.Close()
        $restored += "注册表：$spec"
      } catch {
        $errors += "注册表键 $spec：$($_.Exception.Message)"
      }
    }
  }

  if ($categories -contains 'hosts') {
    $hosts = $snapshot.categories.hosts
    if ($null -eq $hosts -or -not $hosts.exists) {
      $skipped += 'hosts：快照中没有可恢复内容'
    } else {
      $path = [string]$hosts.path
      if ($path -eq '') { $path = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts' }
      try {
        if (Test-Path -LiteralPath $path) {
          $backup = $path + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
          Copy-Item -LiteralPath $path -Destination $backup -Force
          $restored += "hosts 备份：$backup"
        }
        [System.IO.File]::WriteAllText($path, [string]$hosts.content, (New-Object System.Text.UTF8Encoding($false)))
        $restored += 'hosts 文件'
      } catch {
        $errors += "hosts：$($_.Exception.Message)"
      }
    }
  }

  if ($categories -contains 'envUser') {
    $envSnapshot = $snapshot.categories.envUser
    if ($null -eq $envSnapshot) {
      $skipped += '用户环境变量：快照中没有内容'
    } else {
      $desired = New-Object 'System.Collections.Generic.HashSet[string]'
      $current = [Environment]::GetEnvironmentVariables('User')
      foreach ($item in @($envSnapshot.values)) {
        $name = [string]$item.name
        if ($name -eq '') { continue }
        [void]$desired.Add($name)
        try {
          [Environment]::SetEnvironmentVariable($name, [string]$item.value, 'User')
          $restored += "用户环境变量：$name"
        } catch {
          $errors += "用户环境变量 $name：$($_.Exception.Message)"
        }
      }
      foreach ($name in @($current.Keys)) {
        $textName = [string]$name
        if (-not $desired.Contains($textName)) {
          try {
            [Environment]::SetEnvironmentVariable($textName, $null, 'User')
            $restored += "删除用户环境变量：$textName"
          } catch {
            $errors += "删除用户环境变量 $textName：$($_.Exception.Message)"
          }
        }
      }
    }
  }

  foreach ($readonly in @('envMachine', 'services', 'firewall', 'scheduledTasks')) {
    if ($categories -contains $readonly) {
      $skipped += "只读类别，未恢复：$readonly"
    }
  }

  Write-Result ([ordered]@{
    ok = $true
    partial = ($errors.Count -gt 0)
    restored = @($restored)
    skipped = @($skipped)
    errors = @($errors)
  })
}

try {
  if (-not (Test-Path -LiteralPath $RequestFile)) { throw "请求文件不存在：$RequestFile" }
  $raw = [System.IO.File]::ReadAllText($RequestFile, [System.Text.Encoding]::UTF8)
  $request = $raw | ConvertFrom-Json
  $action = [string]$request.action
  if ($action -eq 'create') { Invoke-Create $request }
  elseif ($action -eq 'restore') { Invoke-Restore $request }
  else { throw "未知动作：$action" }
} catch {
  Write-Failure $_.Exception.Message
}
