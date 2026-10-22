#!/usr/bin/env bash
# Safely replace an unpacked Memchat Chrome extension from a verified release ZIP.
set -eu

INDEX_URL='https://raw.githubusercontent.com/xtalia/memchat-dist/main/memchat-update.txt'
MAX_INDEX=65536
MAX_ARCHIVE=20971520
MAX_EXTRACTED=52428800
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
TARGET="$SCRIPT_DIR/chrome-extension"
OFFLINE_INDEX=''
OFFLINE_ARCHIVE=''

fail() { printf 'Memchat updater: %s\n' "$*" >&2; exit 1; }
usage() { printf 'Usage: %s [--target PATH] [--offline-index PATH --offline-archive PATH]\n' "$0"; }
while [ "$#" -gt 0 ]; do
    case "$1" in
        --target) [ "$#" -ge 2 ] || fail 'missing --target value'; TARGET=$2; shift 2 ;;
        --offline-index) [ "$#" -ge 2 ] || fail 'missing --offline-index value'; OFFLINE_INDEX=$2; shift 2 ;;
        --offline-archive) [ "$#" -ge 2 ] || fail 'missing --offline-archive value'; OFFLINE_ARCHIVE=$2; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) fail "unknown option: $1" ;;
    esac
done
if { [ -n "$OFFLINE_INDEX" ] && [ -z "$OFFLINE_ARCHIVE" ]; } || { [ -z "$OFFLINE_INDEX" ] && [ -n "$OFFLINE_ARCHIVE" ]; }; then fail 'offline index and archive must be supplied together'; fi

case "$TARGET" in
    ''|/|.|..|*/) fail 'unsafe target path' ;;
esac
case "$TARGET" in /*) ;; *) TARGET="$PWD/$TARGET" ;; esac
if [ -L "$TARGET" ]; then fail 'target must not be a symbolic link'; fi
PARENT=$(dirname "$TARGET")
BASE=$(basename "$TARGET")
[ -n "$BASE" ] && [ "$BASE" != . ] && [ "$BASE" != .. ] || fail 'unsafe target basename'
mkdir -p "$PARENT" || fail 'cannot create target parent'
PARENT=$(CDPATH= cd -- "$PARENT" && pwd)
TARGET="$PARENT/$BASE"
LOCK="$PARENT/.$BASE.memchat-updater.lock"
mkdir "$LOCK" 2>/dev/null || fail "another updater holds lock $LOCK"
OWN_LOCK=1
WORK=''
BACKUP_CONTAINER=''
OLD_MOVED=0
cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    if [ "$status" -ne 0 ] && [ "$OLD_MOVED" -eq 1 ] && [ ! -e "$TARGET" ] && [ -d "$BACKUP_CONTAINER/chrome-extension" ]; then
        mv "$BACKUP_CONTAINER/chrome-extension" "$TARGET" || printf 'Memchat updater: failed to restore backup at %s\n' "$BACKUP_CONTAINER" >&2
    fi
    if [ -n "$WORK" ] && [ -d "$WORK" ]; then rm -rf "$WORK"; fi
    if [ "${OWN_LOCK:-0}" -eq 1 ] && [ -d "$LOCK" ]; then rmdir "$LOCK" 2>/dev/null || :; fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

WORK=$(mktemp -d "$PARENT/.memchat-update.XXXXXX") || fail 'cannot create staging directory'
INDEX="$WORK/index.txt"
ARCHIVE="$WORK/memchat.zip"
if [ -n "$OFFLINE_INDEX" ]; then
    [ -f "$OFFLINE_INDEX" ] && [ ! -L "$OFFLINE_INDEX" ] || fail 'offline index is not a regular file'
    [ -f "$OFFLINE_ARCHIVE" ] && [ ! -L "$OFFLINE_ARCHIVE" ] || fail 'offline archive is not a regular file'
    cp "$OFFLINE_INDEX" "$INDEX" || fail 'cannot copy offline index'
    cp "$OFFLINE_ARCHIVE" "$ARCHIVE" || fail 'cannot copy offline archive'
else
    command -v curl >/dev/null 2>&1 || fail 'curl is required'
    download_bounded() {
        url=$1
        destination=$2
        limit=$3
        label=$4
        set +e
        set -o pipefail
        curl --fail --silent --show-error --location --connect-timeout 15 --max-time "$5" --proto '=https' --proto-redir '=https' "$url" | head -c "$((limit + 1))" > "$destination"
        download_status=$?
        set -e
        received=$(wc -c < "$destination" | tr -d ' ')
        [ "$received" -le "$limit" ] || fail "$label exceeds download limit"
        [ "$download_status" -eq 0 ] || fail "could not download $label"
    }
    download_bounded "$INDEX_URL" "$INDEX" "$MAX_INDEX" 'update index' 90
fi

# Strictly validate the descriptor; never source or evaluate it.
awk '
BEGIN { valid=1 }
NR == 1 { sub(/\r$/, "", $0); v2=($0 == "MEMCHAT_UPDATE_V2"); if ($0 != "MEMCHAT_UPDATE_V1" && !v2) valid=0; next }
{
  sub(/\r$/, "", $0)
  key=substr($0,1,index($0,"=")-1); value=substr($0,index($0,"=")+1)
  if (!(key == "version" || key == "sha256" || key == "url" || key == "file.build-info.json" || key == "file.config.js" || key == "file.content.js" || key == "file.controls.js" || key == "file.manifest.json" || key == "file.worker.js" || (v2 && key == "file.icon.png")) || seen[key]++) { valid=0; next }
  if (key == "version") {
    n=split(value,a,"."); if (n != 4) valid=0
    for (i=1;i<=n;i++) if (a[i] !~ /^[0-9]+$/ || length(a[i]) > 5 || a[i]+0 > 65535) valid=0
  } else if (key == "url") { if (substr(value,1,8) != "https://") valid=0 }
  else if (value !~ /^[0-9a-fA-F]+$/ || length(value) != 64) valid=0
}
END {
  if (NR != 10 + v2) valid=0
  split("version sha256 url file.build-info.json file.config.js file.content.js file.controls.js file.manifest.json file.worker.js",required," ")
  for (i=1;i<=9;i++) if (!seen[required[i]]) valid=0
  if (v2 && !seen["file.icon.png"]) valid=0
  exit !valid
}' "$INDEX" || fail 'invalid update index'

get_value() { awk -v wanted="$1" '{ sub(/\r$/, "", $0); if (index($0,"=") && substr($0,1,index($0,"=")-1)==wanted) print substr($0,index($0,"=")+1) }' "$INDEX"; }
REQUIRED_FILES='build-info.json config.js content.js controls.js manifest.json worker.js'
if [ -n "$(get_value file.icon.png)" ]; then REQUIRED_FILES="$REQUIRED_FILES icon.png"; fi
VERSION=$(get_value version)
EXPECTED_URL="https://github.com/xtalia/memchat-dist/releases/download/chrome-v$VERSION/memchat-chrome.zip"
[ "$(get_value url)" = "$EXPECTED_URL" ] || fail 'update URL does not match the publisher release URL'
if [ -z "$OFFLINE_ARCHIVE" ]; then
    download_bounded "$EXPECTED_URL" "$ARCHIVE" "$MAX_ARCHIVE" 'update archive' 180
fi
[ -f "$ARCHIVE" ] && [ ! -L "$ARCHIVE" ] || fail 'archive is not a regular file'
ARCHIVE_SIZE=$(wc -c < "$ARCHIVE" | tr -d ' ')
[ "$ARCHIVE_SIZE" -le "$MAX_ARCHIVE" ] || fail 'archive exceeds 20 MiB limit'
sha_file() {
    if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print tolower($1)}'
    elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print tolower($1)}'
    else fail 'shasum or sha256sum is required'; fi
}
[ "$(sha_file "$ARCHIVE")" = "$(get_value sha256 | tr 'A-F' 'a-f')" ] || fail 'archive SHA-256 mismatch'

# Compare four numeric components without relying on shell integer width.
compare_versions() {
    awk -v left="$1" -v right="$2" 'BEGIN {
      split(left,a,"."); split(right,b,".");
      for (i=1;i<=4;i++) { x=a[i]+0; y=b[i]+0; if (x>y) exit 1; if (x<y) exit 2 }
      exit 0
    }'
}
read_identity() {
    awk '
    /"manifest_version"[[:space:]]*:[[:space:]]*3([,[:space:]]|$)/ { mv++ }
    /"name"[[:space:]]*:[[:space:]]*"[^"]*Memchat"[[:space:]]*,?/ { name++ }
    /"version"[[:space:]]*:[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+"[[:space:]]*,?/ {
      v++; line=$0; sub(/^.*"version"[[:space:]]*:[[:space:]]*"/,"",line); sub(/".*$/,"",line); version=line
    }
    /"service_worker"[[:space:]]*:[[:space:]]*"worker\.js"[[:space:]]*,?/ { worker++ }
    END { if (mv!=1 || name!=1 || v!=1 || worker!=1) exit 1; print version }
    ' "$1"
}

if [ -e "$TARGET" ]; then
    [ -d "$TARGET" ] && [ ! -L "$TARGET" ] || fail 'existing target must be a real directory'
    [ -f "$TARGET/manifest.json" ] && [ -f "$TARGET/build-info.json" ] || fail 'refusing to replace an unrecognized target'
    CURRENT=$(read_identity "$TARGET/manifest.json") || fail 'existing target manifest is not recognized as Memchat'
    awk 'BEGIN {ok=0} /"source"[[:space:]]*:[[:space:]]*"js\/memchat\.user\.js"/ {n++} END {if(n==1)exit 0;exit 1}' "$TARGET/build-info.json" || fail 'existing target build info is not recognized as Memchat'
    case "$CURRENT" in *.*.*.*) ;; *) fail 'existing target version is invalid' ;; esac
    cmp=0
    compare_versions "$CURRENT" "$VERSION" || cmp=$?
    if [ "$cmp" -eq 1 ]; then fail "refusing downgrade from $CURRENT to $VERSION"; fi
    # Compare exit codes: 1 means current is newer; 2 means the release is newer.
    if [ "$cmp" -eq 0 ]; then
        match=1
        for name in $REQUIRED_FILES; do
            expected=$(get_value "file.$name" | tr 'A-F' 'a-f')
            if [ ! -f "$TARGET/$name" ] || [ "$(sha_file "$TARGET/$name")" != "$expected" ]; then match=0; fi
        done
        if [ "$match" -eq 1 ]; then printf 'Memchat %s is up to date.\n' "$VERSION"; exit 0; fi
    fi
fi

# Validate every archive path before extracting only the six allowlisted members.
command -v unzip >/dev/null 2>&1 || fail 'unzip is required'
LIST="$WORK/zip-list.txt"
unzip -Z1 "$ARCHIVE" > "$LIST" || fail 'cannot list ZIP archive'
awk '
BEGIN {valid=1}
{
  name=$0
  if (name ~ /\\/ || name ~ /^\// || name ~ /(^|\/)\.\.(\/|$)/ || name ~ /(^|\/)\.($|\/)/) valid=0
  if (name == "chrome-extension/") {if (seen[name]++) valid=0; next}
  if (name ~ /^chrome-extension\/(build-info\.json|config\.js|content\.js|controls\.js|manifest\.json|worker\.js|icon\.png)$/ || name ~ /^(Update-Memchat\.ps1|Update-Memchat\.cmd|update-memchat\.sh|Update-Memchat\.command|README\.md)$/) {if (seen[name]++) valid=0; next}
  valid=0
}
END {exit !valid}' "$LIST" || fail 'ZIP contains an unknown, duplicate, or unsafe path'
for name in $REQUIRED_FILES; do
    grep -Fqx "chrome-extension/$name" "$LIST" || fail "ZIP is missing chrome-extension/$name"
done

EXT="$WORK/chrome-extension"
mkdir "$EXT" || fail 'cannot create extraction staging directory'
TOTAL=0
for name in $REQUIRED_FILES; do
    remaining=$((MAX_EXTRACTED - TOTAL))
    limit=$((remaining + 1))
    set +e
    set -o pipefail
    unzip -p "$ARCHIVE" "chrome-extension/$name" 2> "$WORK/unzip.err" | head -c "$limit" > "$EXT/$name"
    extract_status=$?
    set -e
    size=$(wc -c < "$EXT/$name" | tr -d ' ')
    [ "$size" -le "$remaining" ] || fail 'extracted files exceed 50 MiB limit'
    [ "$extract_status" -eq 0 ] || fail "cannot extract $name"
    TOTAL=$((TOTAL + size))
    expected=$(get_value "file.$name" | tr 'A-F' 'a-f')
    [ "$(sha_file "$EXT/$name")" = "$expected" ] || fail "SHA-256 mismatch for $name"
    chmod 644 "$EXT/$name"
done
NEW_VERSION=$(read_identity "$EXT/manifest.json") || fail 'downloaded manifest is not a valid Memchat manifest'
[ "$NEW_VERSION" = "$VERSION" ] || fail 'downloaded manifest version does not match index'
awk 'BEGIN {ok=0} /"source"[[:space:]]*:[[:space:]]*"js\/memchat\.user\.js"/ {n++} END {if(n==1)exit 0;exit 1}' "$EXT/build-info.json" || fail 'downloaded build info is not a Memchat build'

if [ -e "$TARGET" ]; then
    n=0
    while :; do
        BACKUP_CONTAINER="$PARENT/.memchat-backup-$(date +%Y%m%d%H%M%S)-$$-$n"
        if mkdir "$BACKUP_CONTAINER" 2>/dev/null; then break; fi
        n=$((n+1)); [ "$n" -lt 100 ] || fail 'cannot create unique backup container'
    done
    mv "$TARGET" "$BACKUP_CONTAINER/chrome-extension" || fail 'cannot move current extension into backup'
    OLD_MOVED=1
fi
mv "$EXT" "$TARGET" || fail 'cannot install staged extension'
OLD_MOVED=0
printf 'Installed Memchat %s at %s.\n' "$VERSION" "$TARGET"
if [ -n "$BACKUP_CONTAINER" ]; then printf 'Previous extension preserved at %s/chrome-extension.\n' "$BACKUP_CONTAINER"; fi
