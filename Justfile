# backdrop: install puts the command on PATH from this checkout.

bindir := env_var_or_default("XDG_BIN_HOME", env_var("HOME") / ".local/bin")

# list recipes
default:
    @just --list

# dependencies from the lock file (npm ci, dev ones too: this checkout is also where tests run), then ~/.local/bin/backdrop -> src/index.js; refuses to replace anything that is not a symlink
install:
    #!/usr/bin/env bash
    set -euo pipefail
    npm ci --no-audit --no-fund
    src="$(pwd -P)/src/index.js"
    dest="{{ bindir }}/backdrop"
    mkdir -p "${dest%/*}"
    if [[ -e "$dest" && ! -L "$dest" ]]; then
      echo "install: $dest exists and is not a symlink; remove it first" >&2
      exit 1
    fi
    ln -sfn "$src" "$dest"
    echo "$dest -> $src"
    # A daemon or backdrop web on an older version keeps running it until restarted; without an X display (a deploy
    # over ssh) a daemon could not start again, so it only says so then
    if [[ -n "${DISPLAY:-}" ]]; then
      "$dest" restart --if-stale || echo "install: restart failed; run backdrop restart" >&2
    else
      echo "install: no X display; run backdrop restart --if-stale from the desktop if the daemon runs"
    fi

# exit 1 when the link or the dependencies are missing (deploy reinstalls then)
install-check:
    #!/usr/bin/env bash
    set -euo pipefail
    [[ $(readlink -f "{{ bindir }}/backdrop") == "$(pwd -P)/src/index.js" ]]
    [[ -d node_modules ]]

# ~/.shell's test-progress runs npm test with mocha's TAP reporter, shows the run live and keeps
# it (~/.local/state/test-progress); without it, plain npm test
tpnpm := if path_exists(env_var("HOME") / ".shell/scripts/test-progress") == "true" { env_var("HOME") / ".shell/scripts/test-progress -C " + quote(justfile_directory()) } else { "npm test" }

# the test suite
test:
    {{ tpnpm }}
