#Requires -Version 7.4
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('prepare', 'receive')][string]$Command,
    [Parameter(Mandatory = $true)][string]$StateDirectory,
    [string]$EnvelopePath
)

# This tool never prints plaintext, private keys, or nested exception details.
# No network calls, clipboard operations, environment secrets, or cookie access.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$sourceOrigin = 'https://proxy-pals-hub.lovable.app'
$targetOrigin = 'https://umbra.mafiatrafa.com'
$entropy = [Text.Encoding]::UTF8.GetBytes('Umbra key transfer vault v1')
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$currentSid = $null
$rsa = $null
$clearPrivate = $null
$rawSecret = $null
$plaintext = $null
$transportKey = $null
$proofKey = $null
$proofPlain = $null

function Fail { throw [InvalidOperationException]::new('Key transfer validation failed.') }

function Assert-PlainPath([string]$Path, [bool]$MustExist) {
    if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path.StartsWith('\\')) { Fail }
    $full = [IO.Path]::GetFullPath($Path)
    if ($full.TrimEnd([IO.Path]::DirectorySeparatorChar) -eq [IO.Path]::GetPathRoot($full).TrimEnd([IO.Path]::DirectorySeparatorChar)) { Fail }
    if ($MustExist -and -not (Test-Path -LiteralPath $full)) { Fail }
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.LinkType) { Fail }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    return $full
}

function Assert-VaultAcl([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    if ($acl.Owner -ne $currentSid.Value -and $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $currentSid.Value) { Fail }
    $hasOwner = $false
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        $identity = $rule.IdentityReference.Value
        if ($identity -notin @($currentSid.Value, 'S-1-5-18') -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { Fail }
        if ($identity -eq $currentSid.Value -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $hasOwner = $true }
    }
    if (-not $hasOwner) { Fail }
}

function Write-NewBytes([string]$Path, [byte[]]$Bytes) {
    $stream = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    Assert-VaultAcl $Path
}

function Read-SmallBytes([string]$Path, [int]$Maximum) {
    $safe = Assert-PlainPath $Path $true
    $item = Get-Item -LiteralPath $safe -Force
    if ($item.PSIsContainer -or $item.Length -le 0 -or $item.Length -gt $Maximum) { Fail }
    $stream = [IO.FileStream]::new($safe, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -ne $item.Length -or $stream.Length -gt $Maximum) { Fail }
        $bytes = [byte[]]::new([int]$stream.Length)
        $stream.ReadExactly($bytes)
        return ,$bytes
    } finally { $stream.Dispose() }
}

function Assert-JsonObject([Text.Json.JsonElement]$Element) {
    if ($Element.ValueKind -ne [Text.Json.JsonValueKind]::Object) { Fail }
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($property in $Element.EnumerateObject()) {
        if (-not $names.Add($property.Name)) { Fail }
        if ($property.Value.ValueKind -eq [Text.Json.JsonValueKind]::Object) { Assert-JsonObject $property.Value }
        if ($property.Value.ValueKind -eq [Text.Json.JsonValueKind]::Array) { Fail }
    }
}

function Parse-StrictJson([byte[]]$Bytes) {
    $text = $utf8.GetString($Bytes)
    $options = [Text.Json.JsonDocumentOptions]::new()
    $options.MaxDepth = 5
    $document = [Text.Json.JsonDocument]::Parse($text, $options)
    try {
        Assert-JsonObject $document.RootElement
        return Convert-JsonElement $document.RootElement
    } finally { $document.Dispose() }
}

function Convert-JsonElement([Text.Json.JsonElement]$Element) {
    if ($Element.ValueKind -eq [Text.Json.JsonValueKind]::String) { return $Element.GetString() }
    if ($Element.ValueKind -ne [Text.Json.JsonValueKind]::Object) { Fail }
    $result = [Collections.Specialized.OrderedDictionary]::new([StringComparer]::Ordinal)
    foreach ($property in $Element.EnumerateObject()) { $result.Add($property.Name, (Convert-JsonElement $property.Value)) }
    return $result
}

function Assert-Keys([Collections.IDictionary]$Value, [string[]]$Names) {
    if ($Value.Count -ne $Names.Count) { Fail }
    foreach ($name in $Names) { if (-not $Value.Contains($name)) { Fail } }
}

function Required-String([Collections.IDictionary]$Value, [string]$Name, [int]$Maximum = 4096) {
    if (-not $Value.Contains($Name) -or $Value[$Name] -isnot [string] -or $Value[$Name].Length -lt 1 -or $Value[$Name].Length -gt $Maximum) { Fail }
    return $Value[$Name]
}

function Decode-Base64([string]$Value, [int]$Maximum) {
    if ($Value.Length -gt $Maximum * 2) { Fail }
    $bytes = [Convert]::FromBase64String($Value)
    if ($bytes.Length -le 0 -or $bytes.Length -gt $Maximum -or [Convert]::ToBase64String($bytes) -cne $Value) { Fail }
    return ,$bytes
}

function Parse-Time([string]$Value) {
    if ($Value -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') { Fail }
    return [DateTimeOffset]::ParseExact($Value, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
}

function Hex-Sha256([byte[]]$Bytes) { return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant() }

try {
    if (-not $IsWindows) { Fail }
    Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class UmbraVaultDirectory {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CreateDirectory(string path, IntPtr securityAttributes);
}
'@
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $state = Assert-PlainPath $StateDirectory $false
    $parent = [IO.Path]::GetDirectoryName($state)
    if (-not [IO.Directory]::Exists($parent)) { Fail }
    $manifestPath = [IO.Path]::Combine($state, 'public-manifest.json')
    $privatePath = [IO.Path]::Combine($state, 'private.dpapi')
    $secretPath = [IO.Path]::Combine($state, 'app-key.dpapi')
    if ($Command -eq 'prepare') {
        if ($EnvelopePath -or (Test-Path -LiteralPath $state)) { Fail }
        # Win32 CreateDirectory is exclusive: ERROR_ALREADY_EXISTS also rejects
        # a concurrent creator. No keys exist until the protected ACL is set.
        if (-not [UmbraVaultDirectory]::CreateDirectory($state, [IntPtr]::Zero)) { Fail }
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetOwner($currentSid)
        $acl.SetAccessRuleProtection($true, $false)
        $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        foreach ($sid in @($currentSid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
            $acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $state -AclObject $acl
        Assert-VaultAcl $state
        $rsa = [Security.Cryptography.RSA]::Create(3072)
        $public = $rsa.ExportSubjectPublicKeyInfo()
        $clearPrivate = $rsa.ExportPkcs8PrivateKey()
        $protected = [Security.Cryptography.ProtectedData]::Protect($clearPrivate, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        Write-NewBytes $privatePath $protected
        $now = [DateTimeOffset]::UtcNow
        $manifest = [ordered]@{
            format = 'umbra-key-transfer-request-v1'
            transferId = [Guid]::NewGuid().ToString('D')
            keyId = Hex-Sha256 $public
            sourceOrigin = $sourceOrigin
            targetOrigin = $targetOrigin
            createdAt = $now.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
            expiresAt = $now.AddMinutes(30).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
            publicKeySpki = [Convert]::ToBase64String($public)
        }
        $manifestBytes = $utf8.GetBytes((ConvertTo-Json -InputObject $manifest -Compress))
        Write-NewBytes $manifestPath $manifestBytes
        [Console]::WriteLine('Protected transfer request prepared. Only public-manifest.json may be shared.')
    } else {
        if (-not $EnvelopePath -or -not [IO.Directory]::Exists($state) -or (Test-Path -LiteralPath $secretPath)) { Fail }
        [void](Assert-PlainPath $state $true)
        Assert-VaultAcl $state
        foreach ($file in @($manifestPath, $privatePath)) { [void](Assert-PlainPath $file $true); Assert-VaultAcl $file }
        $manifest = Parse-StrictJson (Read-SmallBytes $manifestPath 8192)
        Assert-Keys $manifest @('format', 'transferId', 'keyId', 'sourceOrigin', 'targetOrigin', 'createdAt', 'expiresAt', 'publicKeySpki')
        if ($manifest.format -cne 'umbra-key-transfer-request-v1' -or $manifest.sourceOrigin -cne $sourceOrigin -or $manifest.targetOrigin -cne $targetOrigin) { Fail }
        $transferId = Required-String $manifest 'transferId' 36
        if ($transferId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') { Fail }
        $keyId = Required-String $manifest 'keyId' 64
        if ($keyId -cnotmatch '^[a-f0-9]{64}$') { Fail }
        $created = Parse-Time (Required-String $manifest 'createdAt' 24)
        $expires = Parse-Time (Required-String $manifest 'expiresAt' 24)
        $now = [DateTimeOffset]::UtcNow
        if ($created -gt $now.AddMinutes(1) -or $expires -le $now -or $expires -le $created -or $expires -gt $created.AddHours(24)) { Fail }
        $public = Decode-Base64 (Required-String $manifest 'publicKeySpki' 2048) 1024
        if ((Hex-Sha256 $public) -cne $keyId) { Fail }
        $protected = Read-SmallBytes $privatePath 8192
        $clearPrivate = [Security.Cryptography.ProtectedData]::Unprotect($protected, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $rsa = [Security.Cryptography.RSA]::Create()
        $used = 0
        $rsa.ImportPkcs8PrivateKey($clearPrivate, [ref]$used)
        if ($used -ne $clearPrivate.Length -or $rsa.KeySize -ne 3072 -or (Hex-Sha256 $rsa.ExportSubjectPublicKeyInfo()) -cne $keyId) { Fail }
        $envelope = Parse-StrictJson (Read-SmallBytes $EnvelopePath 262144)
        Assert-Keys $envelope @('format', 'transferId', 'keyId', 'sourceOrigin', 'targetOrigin', 'issuedAt', 'expiresAt', 'wrappedKey', 'iv', 'tag', 'ciphertext')
        if ($envelope.format -cne 'umbra-key-transfer-v1' -or $envelope.transferId -cne $transferId -or $envelope.keyId -cne $keyId -or $envelope.sourceOrigin -cne $sourceOrigin -or $envelope.targetOrigin -cne $targetOrigin) { Fail }
        $issued = Parse-Time (Required-String $envelope 'issuedAt' 24)
        $envelopeExpires = Parse-Time (Required-String $envelope 'expiresAt' 24)
        if ($issued -lt $created.AddMinutes(-1) -or $issued -gt $now.AddMinutes(1) -or $envelopeExpires -le $now -or $envelopeExpires -le $issued -or $envelopeExpires -gt $expires) { Fail }
        $aadValues = @($envelope.format, $transferId, $keyId, $sourceOrigin, $targetOrigin, $envelope.issuedAt, $envelope.expiresAt)
        $aad = $utf8.GetBytes((ConvertTo-Json -InputObject $aadValues -Compress))
        $wrapped = Decode-Base64 (Required-String $envelope 'wrappedKey' 1024) 384
        $iv = Decode-Base64 (Required-String $envelope 'iv' 32) 12
        $tag = Decode-Base64 (Required-String $envelope 'tag' 32) 16
        $ciphertext = Decode-Base64 (Required-String $envelope 'ciphertext' 196608) 131072
        if ($wrapped.Length -ne 384 -or $iv.Length -ne 12 -or $tag.Length -ne 16) { Fail }
        $transportKey = $rsa.Decrypt($wrapped, [Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)
        if ($transportKey.Length -ne 32) { Fail }
        $plaintext = [byte[]]::new($ciphertext.Length)
        $gcm = [Security.Cryptography.AesGcm]::new($transportKey, 16)
        try { $gcm.Decrypt($iv, $ciphertext, $tag, $plaintext, $aad) } finally { $gcm.Dispose() }
        $payload = Parse-StrictJson $plaintext
        Assert-Keys $payload @('secretName', 'secret', 'canary')
        if ($payload.secretName -cne 'APP_ENCRYPTION_KEY') { Fail }
        $secret = Required-String $payload 'secret' 65536
        if ($payload.canary -isnot [Collections.IDictionary]) { Fail }
        Assert-Keys $payload.canary @('plain', 'encrypted')
        $expectedPlain = Required-String $payload.canary 'plain' 512
        if ($expectedPlain.Length -lt 16) { Fail }
        $encryptedProof = Required-String $payload.canary 'encrypted' 4096
        $parts = $encryptedProof.Split('.')
        if ($parts.Count -ne 3) { Fail }
        $proofIv = Decode-Base64 $parts[0] 12
        $proofTag = Decode-Base64 $parts[1] 16
        $proofCiphertext = Decode-Base64 $parts[2] 2048
        if ($proofIv.Length -ne 12 -or $proofTag.Length -ne 16) { Fail }
        # Do not Trim() or normalize raw APP_ENCRYPTION_KEY; existing ciphertext
        # uses SHA256 over its exact UTF-8 bytes.
        $rawSecret = $utf8.GetBytes($secret)
        $proofKey = [Security.Cryptography.SHA256]::HashData($rawSecret)
        $proofPlain = [byte[]]::new($proofCiphertext.Length)
        $proofGcm = [Security.Cryptography.AesGcm]::new($proofKey, 16)
        try { $proofGcm.Decrypt($proofIv, $proofCiphertext, $proofTag, $proofPlain) } finally { $proofGcm.Dispose() }
        $expectedBytes = $utf8.GetBytes($expectedPlain)
        if (-not [Security.Cryptography.CryptographicOperations]::FixedTimeEquals($proofPlain, $expectedBytes)) { Fail }
        $protectedSecret = [Security.Cryptography.ProtectedData]::Protect($rawSecret, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        Write-NewBytes $secretPath $protectedSecret
        [Console]::WriteLine('Encrypted transfer verified and saved in the local protected vault. No remote service changed.')
    }
    exit 0
} catch {
    # A nested exception can contain input, filesystem details, or provider data.
    [Console]::Error.WriteLine('Key transfer failed safely. No secret was printed or remotely changed.')
    exit 1
} finally {
    foreach ($bytes in @($clearPrivate, $rawSecret, $plaintext, $transportKey, $proofKey, $proofPlain)) {
        if ($bytes -is [byte[]]) { [Array]::Clear($bytes, 0, $bytes.Length) }
    }
    if ($rsa) { $rsa.Dispose() }
}
