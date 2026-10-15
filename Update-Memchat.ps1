[CmdletBinding()]
param(
    [string]$TargetDirectory = (Join-Path $PSScriptRoot 'chrome-extension'),
    [string]$OfflineIndex,
    [string]$OfflineArchive
)

$ErrorActionPreference = 'Stop'
$script:IndexUrl = 'https://raw.githubusercontent.com/xtalia/memchat-dist/main/memchat-update.txt'
$script:MaxArchiveBytes = 20MB
$script:MaxExtractedBytes = 50MB
$script:RequiredFiles = @('build-info.json', 'config.js', 'content.js', 'controls.js', 'manifest.json', 'worker.js')
$script:OptionalRootFiles = @('Update-Memchat.ps1', 'Update-Memchat.cmd', 'update-memchat.sh', 'Update-Memchat.command', 'README.md')
$script:LockPath = $null
$script:LockOwned = $false
$script:StagePath = $null
$script:BackupPath = $null
$script:TargetPath = $null

function Stop-Updater([string]$Message) {
    throw $Message
}

function Get-Sha256Bytes([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-Sha256File([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
}

function Get-HttpBytes([string]$Url, [long]$Limit) {
    $currentUrl = $Url
    for ($redirect = 0; $redirect -le 5; $redirect++) {
        if (-not $currentUrl.StartsWith('https://', [StringComparison]::OrdinalIgnoreCase)) { Stop-Updater 'Only HTTPS downloads and redirects are permitted.' }
        $request = [System.Net.HttpWebRequest]::Create($currentUrl)
        $request.Method = 'GET'
        $request.AllowAutoRedirect = $false
        $request.Timeout = 30000
        $request.ReadWriteTimeout = 30000
        $request.UserAgent = 'Memchat-Updater/1'
        $response = $null
        $inputStream = $null
        $output = New-Object System.IO.MemoryStream
        try {
            $response = $request.GetResponse()
            $status = [int]$response.StatusCode
            if ($status -ge 300 -and $status -lt 400) {
                $location = $response.GetResponseHeader('Location')
                if (-not $location) { Stop-Updater 'A download redirect did not include a destination.' }
                $nextUri = New-Object System.Uri($response.ResponseUri, $location)
                if ($nextUri.Scheme -ne 'https') { Stop-Updater 'A download redirected away from HTTPS.' }
                if ($redirect -eq 5) { Stop-Updater 'Too many download redirects.' }
                $currentUrl = $nextUri.AbsoluteUri
                continue
            }
            if ($status -lt 200 -or $status -ge 300) { Stop-Updater 'A download returned an unsuccessful HTTP status.' }
            if ($response.ContentLength -gt $Limit) { Stop-Updater 'A download exceeded its permitted size.' }
            $inputStream = $response.GetResponseStream()
            $buffer = New-Object byte[] 65536
            while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                if (($output.Length + $read) -gt $Limit) { Stop-Updater 'A download exceeded its permitted size.' }
                $output.Write($buffer, 0, $read)
            }
            return ,$output.ToArray()
        }
        finally {
            if ($inputStream) { $inputStream.Dispose() }
            if ($response) { $response.Dispose() }
            $output.Dispose()
        }
    }
    Stop-Updater 'Too many download redirects.'
}

function Parse-UpdateIndex([string]$Text) {
    $lines = $Text -split "`n"
    if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines = $lines[0..($lines.Count - 2)] }
    if ($lines.Count -gt 0) { $lines[0] = $lines[0].TrimEnd("`r") }
    if ($lines.Count -ne 10) { Stop-Updater 'The update index has an invalid number of lines.' }
    if ($lines[0] -cne 'MEMCHAT_UPDATE_V1') { Stop-Updater 'The update index header is invalid.' }
    $values = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::Ordinal)
    for ($i = 1; $i -lt $lines.Count; $i++) {
        $line = $lines[$i].TrimEnd("`r")
        $separator = $line.IndexOf('=')
        if ($separator -le 0) { Stop-Updater 'The update index contains a malformed line.' }
        $key = $line.Substring(0, $separator)
        $value = $line.Substring($separator + 1)
        if ($values.ContainsKey($key)) { Stop-Updater ('Duplicate update index key: ' + $key) }
        $values[$key] = $value
    }
    $expected = @('version', 'sha256', 'url') + @($script:RequiredFiles | ForEach-Object { 'file.' + $_ })
    if ($values.Count -ne $expected.Count) { Stop-Updater 'The update index contains missing or unknown keys.' }
    foreach ($key in $expected) { if (-not $values.ContainsKey($key)) { Stop-Updater ('Missing update index key: ' + $key) } }
    if ($values['version'] -cnotmatch '^\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5}$') { Stop-Updater 'The update version is invalid.' }
    $parts = @($values['version'].Split('.') | ForEach-Object { [int]$_ })
    foreach ($part in $parts) { if ($part -gt 65535) { Stop-Updater 'A version component exceeds 65535.' } }
    if ($values['sha256'] -cnotmatch '^[0-9a-fA-F]{64}$') { Stop-Updater 'The archive SHA-256 is invalid.' }
    foreach ($name in $script:RequiredFiles) {
        if ($values['file.' + $name] -cnotmatch '^[0-9a-fA-F]{64}$') { Stop-Updater ('Invalid SHA-256 for ' + $name) }
    }
    $expectedUrl = 'https://github.com/xtalia/memchat-dist/releases/download/chrome-v' + $values['version'] + '/memchat-chrome.zip'
    if ($values['url'] -cne $expectedUrl) { Stop-Updater 'The archive URL does not match the approved release URL.' }
    return $values
}

function Compare-Version([string]$Left, [string]$Right) {
    $a = @($Left.Split('.') | ForEach-Object { [int]$_ })
    $b = @($Right.Split('.') | ForEach-Object { [int]$_ })
    for ($i = 0; $i -lt 4; $i++) {
        if ($a[$i] -gt $b[$i]) { return 1 }
        if ($a[$i] -lt $b[$i]) { return -1 }
    }
    return 0
}

function New-OwnedDirectory([string]$Path) {
    if (-not ('MemchatUpdaterNativeDirectory' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class MemchatUpdaterNativeDirectory {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool CreateDirectoryW(string path, IntPtr securityAttributes);
    public static void Create(string path) {
        if (!CreateDirectoryW(path, IntPtr.Zero)) {
            int error = Marshal.GetLastWin32Error();
            throw new Win32Exception(error, "Could not atomically claim directory: " + path);
        }
    }
}
'@
    }
    [MemchatUpdaterNativeDirectory]::Create($Path)
}

function Assert-SafeTarget([string]$Path) {
    $root = [System.IO.Path]::GetPathRoot($Path)
    if (-not $root -or $Path.TrimEnd([char[]]@('\', '/')) -eq $root.TrimEnd([char[]]@('\', '/'))) {
        Stop-Updater 'The target cannot be a filesystem root.'
    }
    if (Test-Path -LiteralPath $Path) {
        $attributes = [System.IO.File]::GetAttributes($Path)
        if (($attributes -band [System.IO.FileAttributes]::Directory) -eq 0) { Stop-Updater 'The target exists but is not a directory.' }
        if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Updater 'The target directory is a reparse point or symbolic link.' }
        $manifestPath = Join-Path $Path 'manifest.json'
        $buildInfoPath = Join-Path $Path 'build-info.json'
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or -not (Test-Path -LiteralPath $buildInfoPath -PathType Leaf)) {
            Stop-Updater 'The existing target is not a recognisable Memchat installation.'
        }
        try {
            $installedManifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $installedBuild = Get-Content -LiteralPath $buildInfoPath -Raw -Encoding UTF8 | ConvertFrom-Json
        } catch { Stop-Updater 'The existing Memchat manifest or build-info is invalid.' }
        if (-not $installedManifest.name -or -not $installedManifest.name.EndsWith('Memchat', [StringComparison]::OrdinalIgnoreCase)) {
            Stop-Updater 'The existing target does not identify itself as Memchat.'
        }
        if ($installedBuild.source -cne 'js/memchat.user.js') { Stop-Updater 'The existing target is not a recognised Memchat build.' }
        if ($installedManifest.version -notmatch '^\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5}$') { Stop-Updater 'The installed version is invalid.' }
        foreach ($part in ($installedManifest.version.Split('.') | ForEach-Object { [int]$_ })) {
            if ($part -gt 65535) { Stop-Updater 'An installed version component exceeds 65535.' }
        }
    }
}

function Assert-ZipAndStage([byte[]]$ArchiveBytes, [hashtable]$Index, [string]$Stage) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $memory = New-Object System.IO.MemoryStream(,$ArchiveBytes)
    $zip = $null
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $allowed = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($name in $script:RequiredFiles) { [void]$allowed.Add('chrome-extension/' + $name) }
    foreach ($name in $script:OptionalRootFiles) { [void]$allowed.Add($name) }
    [void]$allowed.Add('chrome-extension/')
    $entries = New-Object 'System.Collections.Generic.Dictionary[string,System.Object]' ([StringComparer]::Ordinal)
    [long]$total = 0
    try {
        $zip = New-Object System.IO.Compression.ZipArchive($memory, [System.IO.Compression.ZipArchiveMode]::Read, $true)
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName
            if (-not $name -or $name.Contains('\') -or $name.StartsWith('/') -or $name -match '^[A-Za-z]:') { Stop-Updater 'The archive contains an unsafe entry path.' }
            foreach ($segment in $name.Split('/')) { if ($segment -eq '.' -or $segment -eq '..') { Stop-Updater 'The archive contains a traversal path.' } }
            if (-not $seen.Add($name)) { Stop-Updater ('The archive contains a duplicate entry: ' + $name) }
            if (-not $allowed.Contains($name)) { Stop-Updater ('The archive contains an unknown entry: ' + $name) }
            if ($name -ne 'chrome-extension/' -and $name.EndsWith('/')) { Stop-Updater 'Unexpected directory entry in archive.' }
            if ($name -ne 'chrome-extension/' -and $entry.Length -gt 0) {
                $total += $entry.Length
                if ($total -gt $script:MaxExtractedBytes) { Stop-Updater 'The extracted archive exceeds 50 MB.' }
            }
            $entries.Add($name, $entry)
        }
        foreach ($file in $script:RequiredFiles) {
            $entryName = 'chrome-extension/' + $file
            if (-not $entries.ContainsKey($entryName)) { Stop-Updater ('Missing archive file: ' + $entryName) }
        }
        if ($entries.Count -lt $script:RequiredFiles.Count) { Stop-Updater 'The archive is incomplete.' }
        foreach ($name in $script:RequiredFiles) {
            $entry = $entries['chrome-extension/' + $name]
            $destination = Join-Path $Stage $name
            $input = $entry.Open()
            $output = [System.IO.File]::Create($destination)
            $hash = [System.Security.Cryptography.SHA256]::Create()
            try {
                $buffer = New-Object byte[] 65536
                [long]$written = 0
                while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $written += $read
                    if ($written -gt $script:MaxExtractedBytes) { Stop-Updater 'An extracted file exceeded the size limit.' }
                    $output.Write($buffer, 0, $read)
                    [void]$hash.TransformBlock($buffer, 0, $read, $buffer, 0)
                }
                [void]$hash.TransformFinalBlock((New-Object byte[] 0), 0, 0)
                $actual = ([BitConverter]::ToString($hash.Hash)).Replace('-', '').ToLowerInvariant()
                if ($actual -cne $Index['file.' + $name].ToLowerInvariant()) { Stop-Updater ('Checksum mismatch for ' + $name) }
                if ($written -ne $entry.Length) { Stop-Updater ('Size mismatch for ' + $name) }
            }
            finally { $hash.Dispose(); $output.Dispose(); $input.Dispose() }
        }
    }
    finally { if ($zip) { $zip.Dispose() }; $memory.Dispose() }
    try {
        $manifest = Get-Content -LiteralPath (Join-Path $Stage 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $buildInfo = Get-Content -LiteralPath (Join-Path $Stage 'build-info.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch { Stop-Updater 'The downloaded manifest or build-info.json is invalid.' }
    if ($manifest.manifest_version -ne 3) { Stop-Updater 'The downloaded manifest is not MV3.' }
    if (-not $manifest.name -or -not $manifest.name.EndsWith('Memchat', [StringComparison]::OrdinalIgnoreCase)) { Stop-Updater 'The downloaded manifest name must end with Memchat.' }
    if ($manifest.background.service_worker -cne 'worker.js') { Stop-Updater 'The downloaded background worker must be worker.js.' }
    if ($manifest.version -cne $Index['version']) { Stop-Updater 'The manifest version does not match the update index.' }
    if ($buildInfo.source -cne 'js/memchat.user.js') { Stop-Updater 'The build-info source is not recognised.' }
}

try {
    if (($OfflineIndex -and -not $OfflineArchive) -or ($OfflineArchive -and -not $OfflineIndex)) {
        Stop-Updater 'OfflineIndex and OfflineArchive must be supplied together.'
    }
    if (($OfflineIndex -or $OfflineArchive) -and (-not (Test-Path -LiteralPath $OfflineIndex -PathType Leaf) -or -not (Test-Path -LiteralPath $OfflineArchive -PathType Leaf))) {
        Stop-Updater 'The offline index and archive must both exist as files.'
    }
    if (($TargetDirectory -replace '/', '\\') -match '(^|\\)\.{1,2}$') { Stop-Updater 'The target cannot be the current or parent directory.' }
    $TargetPath = [System.IO.Path]::GetFullPath($TargetDirectory)
    $parent = [System.IO.Path]::GetDirectoryName($TargetPath)
    if (-not $parent -or -not (Test-Path -LiteralPath $parent -PathType Container)) { Stop-Updater 'The target parent directory must already exist.' }
    $baseName = [System.IO.Path]::GetFileName($TargetPath)
    if (-not $baseName -or $baseName -eq '.' -or $baseName -eq '..') { Stop-Updater 'The target directory name is unsafe.' }
    $script:LockPath = Join-Path $parent ('.' + $baseName + '.memchat-updater.lock')
    New-OwnedDirectory $script:LockPath
    $script:LockOwned = $true

    if ($OfflineIndex) {
        $archiveInfo = New-Object System.IO.FileInfo([System.IO.Path]::GetFullPath($OfflineArchive))
        if ($archiveInfo.Length -gt $script:MaxArchiveBytes) { Stop-Updater 'The archive exceeds 20 MB.' }
        $indexText = [System.IO.File]::ReadAllText([System.IO.Path]::GetFullPath($OfflineIndex), [System.Text.Encoding]::ASCII)
        $archiveBytes = [System.IO.File]::ReadAllBytes([System.IO.Path]::GetFullPath($OfflineArchive))
        if ($archiveBytes.LongLength -gt $script:MaxArchiveBytes) { Stop-Updater 'The archive exceeds 20 MB.' }
    } else {
        $cacheBust = [DateTime]::UtcNow.Ticks
        $indexBytes = Get-HttpBytes ($script:IndexUrl + '?_=' + $cacheBust) 65536
        $indexText = [System.Text.Encoding]::ASCII.GetString($indexBytes)
    }
    $index = Parse-UpdateIndex $indexText
    if (-not $OfflineArchive) {
        $archiveBytes = Get-HttpBytes $index['url'] $script:MaxArchiveBytes
    }
    if ((Get-Sha256Bytes $archiveBytes) -cne $index['sha256'].ToLowerInvariant()) { Stop-Updater 'The archive checksum does not match the update index.' }

    $script:StagePath = Join-Path $parent ('.' + $baseName + '.memchat-stage-' + [Guid]::NewGuid().ToString('N'))
    [System.IO.Directory]::CreateDirectory($script:StagePath) | Out-Null
    Assert-ZipAndStage $archiveBytes $index $script:StagePath
    Assert-SafeTarget $TargetPath
    if (Test-Path -LiteralPath $TargetPath) {
        $currentManifest = Get-Content -LiteralPath (Join-Path $TargetPath 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ((Compare-Version $currentManifest.version $index['version']) -gt 0) { Stop-Updater 'Refusing to downgrade a newer Memchat installation.' }
        if ((Compare-Version $currentManifest.version $index['version']) -eq 0) {
            $allMatch = $true
            foreach ($name in $script:RequiredFiles) {
                $existingFile = Join-Path $TargetPath $name
                if (-not (Test-Path -LiteralPath $existingFile -PathType Leaf) -or (Get-Sha256File $existingFile) -cne $index['file.' + $name].ToLowerInvariant()) { $allMatch = $false }
            }
            if ($allMatch) {
                Write-Output ('Memchat ' + $index['version'] + ' is up to date; no changes made.')
                exit 0
            }
        }
    }

    if (Test-Path -LiteralPath $TargetPath) {
        $script:BackupPath = Join-Path $parent ($baseName + '.backup-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N'))
        [System.IO.Directory]::CreateDirectory($script:BackupPath) | Out-Null
        [System.IO.Directory]::Move($TargetPath, (Join-Path $script:BackupPath 'chrome-extension'))
    }
    try {
        [System.IO.Directory]::Move($script:StagePath, $TargetPath)
        $script:StagePath = $null
    } catch {
        if (-not (Test-Path -LiteralPath $TargetPath) -and $script:BackupPath -and (Test-Path -LiteralPath (Join-Path $script:BackupPath 'chrome-extension'))) {
            [System.IO.Directory]::Move((Join-Path $script:BackupPath 'chrome-extension'), $TargetPath)
        }
        throw
    }
    if ($script:BackupPath) { Write-Output ('Previous installation preserved at: ' + (Join-Path $script:BackupPath 'chrome-extension')) }
    Write-Output ('Installed Memchat ' + $index['version'] + ' to: ' + $TargetPath)
    Write-Output 'Reload the extension at chrome://extensions and refresh affected tabs.'
    exit 0
}
catch {
    [Console]::Error.WriteLine(('Memchat updater: ' + $_.Exception.Message))
    exit 1
}
finally {
    if ($script:StagePath -and (Test-Path -LiteralPath $script:StagePath)) {
        try { [System.IO.Directory]::Delete($script:StagePath, $true) } catch { }
    }
    if ($script:LockOwned -and $script:LockPath -and (Test-Path -LiteralPath $script:LockPath)) {
        try { [System.IO.Directory]::Delete($script:LockPath, $true) } catch { }
    }
}
