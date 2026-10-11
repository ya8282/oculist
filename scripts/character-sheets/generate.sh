#!/bin/zsh
# Generate character-sheet PNGs for the second Halloween pack through `codex exec`'s
# image_generation tool. One sheet at a time, each run a single foreground-bounded child.
#
#   scripts/character-sheets/generate.sh --list
#   scripts/character-sheets/generate.sh --dry-run ghost-sweep
#   scripts/character-sheets/generate.sh ghost-sweep spider-drop
#   scripts/character-sheets/generate.sh --all
#
# Env: OUT_DIR (default ../artifacts/character-sheets next to the repo), VERSION (default v1),
#      MAX_SECONDS per sheet (default 600).
emulate -L zsh
setopt err_return no_unset pipe_fail

HERE=${0:A:h}
OUT_DIR=${OUT_DIR:-${HERE:h:h:h}/artifacts/character-sheets}
VERSION=${VERSION:-v1}
MAX_SECONDS=${MAX_SECONDS:-600}
child=""

cleanup() {
  if [[ -n $child ]] && kill -0 $child 2>/dev/null; then
    kill -TERM $child 2>/dev/null || true
    sleep 1
    kill -KILL $child 2>/dev/null || true
  fi
  child=""
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM HUP

build_prompt() {
  local name=$1 out=$2
  cat <<EOP
Use your image generation tool to create exactly one image, then save it as a PNG at
this exact path: $out
Create the parent directory if needed. Do not edit any other file. Do not write code.
When done, reply with the saved path and nothing else.

$(<$HERE/style.md)

--- CHARACTER BRIEF ---
$(<$HERE/sheets/$name.md)
EOP
}

run_one() {
  local name=$1 dry=$2
  [[ -f $HERE/sheets/$name.md ]] || { print -u2 "unknown sheet: $name"; return 2 }
  local out=$OUT_DIR/$name-$VERSION.png
  if (( dry )); then build_prompt $name $out; return 0; fi

  mkdir -p $OUT_DIR
  print "== $name -> $out"
  build_prompt $name $out | codex exec --ephemeral --skip-git-repo-check -s workspace-write \
    -C $OUT_DIR -o $OUT_DIR/.$name.last.txt - >/dev/null 2>$OUT_DIR/.$name.err.txt &
  child=$!

  local waited=0
  while kill -0 $child 2>/dev/null; do
    if (( waited >= MAX_SECONDS )); then
      print -u2 "timeout after ${MAX_SECONDS}s: $name"; cleanup; return 124
    fi
    sleep 2; (( waited += 2 ))
  done
  wait $child || { print -u2 "codex failed for $name (see $OUT_DIR/.$name.err.txt)"; child=""; return 1 }
  child=""
  [[ -s $out ]] || { print -u2 "no image written for $name"; return 1 }
  print "   ok ($(file -b $out | cut -c1-40))"
}

dry=0; names=()
for a in "$@"; do
  case $a in
    --list) print -l ${HERE}/sheets/*.md(:t:r); exit 0 ;;
    --dry-run) dry=1 ;;
    --all) names=(${HERE}/sheets/*.md(:t:r)) ;;
    -*) print -u2 "unknown flag $a"; exit 2 ;;
    *) names+=$a ;;
  esac
done
(( $#names )) || { print -u2 "usage: $0 [--list|--dry-run] (--all | name...)"; exit 2 }

fail=0
for n in $names; do run_one $n $dry || fail=1; done
exit $fail
