import { SourceRegistry } from '../sources/SourceRegistry.js';
import { statePath } from '../display/Daemon.js';

export const SHELLS = ['zsh', 'bash'];

// Values completed from the library: saved search queries (newest first, one per spelling, since --query
// ignores case) and tags (most used first). The scripts run these with the sqlite3 CLI, and the hidden
// `backdrop complete-values <kind>` (slower: a Node start per Tab) without it.
export const COMPLETION_SQL = {
  queries: 'SELECT query FROM searches GROUP BY query COLLATE NOCASE ORDER BY MAX(id) DESC',
  tags: 'SELECT tag FROM media_tags GROUP BY tag ORDER BY COUNT(*) DESC, tag'
};

// Value completions by "<command>:<option or argument>" first, then by option alone, in a shell-neutral
// form: a word list, a helper (monitors, resolutions), files matching a pattern, or directories.
// Anything not listed completes nothing (zsh shows the argument name).
function valueSpecs(sources) {
  return {
    '--monitor': { helper: 'monitors' },
    '--resolution': { helper: 'resolutions' },
    // Values may hold spaces, so bash takes them one per line
    '--query': { helper: 'queries', lines: true },
    '--tag': { helper: 'tags', lines: true },
    '--source': { words: sources },
    'list-images:--source': { words: [...sources, 'local'] },
    'list-videos:--source': { words: [...sources, 'local'] },
    '--type': { words: ['images', 'videos', 'both'] },
    '--orientation': { words: ['landscape', 'portrait', 'square'] },
    '--min-size': { words: ['large', 'medium', 'small'] },
    '--status': { words: ['new', 'kept', 'skipped'] },
    '--rated': { words: ['landscape', 'portrait', 'any'] },
    '--min-rating': { words: ['1', '2', '3'] },
    '--playlist': { files: 'm3u' },
    'mode:mode': { words: ['video', 'image', 'toggle'] },
    'keep:rating': { words: ['1', '2', '3'] },
    'speed:value': { words: ['reset', '0.5', '0.8', '1', '+0.1', '-0.1'] },
    'dim:value': { words: ['reset', '0', '20', '40', '+10', '-10'] },
    'bounce:value': { words: ['on', 'off', 'toggle', 'reset'] },
    'import:dirs': { directories: true },
    'completion:shell': { words: SHELLS },
    'visualizer:action': { words: ['reload', 'preset'] },
    'menu:--style': { words: ['panel', 'minimal'] }
  };
}

function zshAction(spec) {
  if (spec.words) return `(${spec.words.join(' ')})`;
  if (spec.helper) return `_backdrop_${spec.helper}`;
  if (spec.files) return `_files -g '*.${spec.files}(-.)'`;
  return '_directories';
}

// Sets COMPREPLY for the word being completed ($cur)
function bashAction(spec) {
  if (spec.words) return `COMPREPLY=($(compgen -W ${quote(spec.words.join(' '))} -- "$cur"))`;
  if (spec.lines) return `local IFS=$'\\n'; COMPREPLY=($(compgen -W "$(_backdrop_${spec.helper})" -- "$cur")); (( \${#COMPREPLY[@]} )) && COMPREPLY=($(printf '%q\\n' "\${COMPREPLY[@]}"))`;
  if (spec.helper) return `COMPREPLY=($(compgen -W "$(_backdrop_${spec.helper})" -- "$cur"))`;
  if (spec.files) return `compopt -o filenames 2>/dev/null; COMPREPLY=($(compgen -d -- "$cur") $(compgen -f -X '!*.${spec.files}' -- "$cur"))`;
  return 'compopt -o filenames 2>/dev/null; COMPREPLY=($(compgen -d -- "$cur"))';
}

function specFor(specs, command, name) {
  return specs[`${command.name()}:${name}`] ?? specs[name] ?? null;
}

// Single-quotes a word for zsh and bash

function quote(text) {
  return `'${String(text).replace(/'/g, "'\\''")}'`;
}

// Escapes text inside an _arguments spec: brackets end the description, colons separate fields
function specText(text) {
  return String(text ?? '').replace(/\\/g, '\\\\').replace(/([[\]:])/g, '\\$1');
}

// The --help option Commander adds to every command but does not list in .options
const HELP = { short: '-h', long: '--help', description: 'display help for command', help: true };

export class CompletionCommand {
  constructor(config, database, logger, { sources } = {}) {
    this.config = config;
    this.database = database;
    this.sources = sources ?? new SourceRegistry(config);
  }

  // `backdrop complete-values <kind>`: the scripts' fallback without sqlite3, one value per line
  values(kind) {
    const sql = COMPLETION_SQL[kind];
    if (!sql) throw new Error(`Unknown completion values: ${kind} (available: ${Object.keys(COMPLETION_SQL).join(', ')})`);
    return this.database.db.prepare(sql).all().map(row => Object.values(row)[0]);
  }

  printValues(kind) {
    const values = this.values(kind);
    if (values.length) process.stdout.write(`${values.join('\n')}\n`);
  }

  generate(shell, program, version) {
    if (!SHELLS.includes(shell)) throw new Error(`Unsupported shell: ${shell} (available: ${SHELLS.join(', ')})`);
    return shell === 'bash' ? this.bash(program, version) : this.zsh(program, version);
  }

  print(shell, program, version) {
    process.stdout.write(this.generate(shell, program, version));
  }

  optionSpecs(command, specs) {
    return [...command.options.filter(option => !option.hidden), HELP].map(option => {
      const names = [option.short, option.long].filter(Boolean);
      const exclusive = option.help ? '(- *)' : names.length > 1 ? `(${names.join(' ')})` : '';
      const repeat = option.variadic ? '*' : '';
      const flags = names.length > 1 ? `{${names.join(',')}}` : names[0];
      let value = '';
      if (option.required || option.optional) {
        const name = /[<[]([^>\]]+?)(\.\.\.)?[>\]]/.exec(option.flags)?.[1] ?? 'value';
        const spec = specFor(specs, command, option.long);
        const action = spec ? zshAction(spec) : ' ';
        value = `${option.optional ? '::' : ':'}${specText(name)}:${action}`;
      }
      const rest = `[${specText(option.description)}]${value}`;
      // Brace expansion has to stay outside the quotes so zsh expands it into one spec per flag
      return names.length > 1 ? `${quote(`${repeat}${exclusive}`)}${flags}${quote(rest)}` : quote(`${repeat}${exclusive}${flags}${rest}`);
    });
  }

  argumentSpecs(command, specs) {
    return command.registeredArguments.map(argument => {
      const spec = specs[`${command.name()}:${argument.name()}`];
      const action = spec ? zshAction(spec) : ' ';
      const prefix = argument.variadic ? '*' : '';
      const colons = argument.required || argument.variadic ? ':' : '::';
      return quote(`${prefix}${colons}${specText(argument.name())}:${action}`);
    });
  }

  zsh(program, version) {
    const specs = valueSpecs(this.sources.names());
    const commands = program.commands.filter(command => !command._hidden);
    const describe = commands.map(command => `    ${quote(`${command.name().replace(/:/g, '\\:')}:${command.description()}`)}`);
    const cases = commands.map(command => {
      const lines = [...this.optionSpecs(command, specs), ...this.argumentSpecs(command, specs)];
      return `        ${command.name()})\n          _arguments -s \\\n            ${lines.join(' \\\n            ')}\n          ;;`;
    });
    const state = statePath(this.config.get().paths.runtime);
    const { database } = this.config.get().paths;

    return `#compdef backdrop
# zsh completion for backdrop ${version}, generated by \`backdrop completion zsh\`.
# Regenerate after upgrading backdrop. Install with either of:
#   backdrop completion zsh > "\${fpath[1]}/_backdrop"     (then restart zsh)
#   source <(backdrop completion zsh)                      (in ~/.zshrc, after compinit)

# Monitors the running daemon drives, else the active X monitors
_backdrop_monitors() {
  local state=${quote(state)}
  local -a monitors
  if [[ -r $state ]]; then
    monitors=(\${(f)"$(grep -o '"name": *"[^"]*"' $state 2>/dev/null | sed 's/.*"\\([^"]*\\)"$/\\1/')"})
  fi
  if (( ! \${#monitors} )) && (( \${+commands[xrandr]} )); then
    monitors=(\${(f)"$(xrandr --current --listactivemonitors 2>/dev/null | awk 'NR > 1 { print $NF }')"})
  fi
  _wanted monitors expl monitor compadd -a monitors
}

# WIDTHxHEIGHT of the active X monitors
_backdrop_resolutions() {
  local -a sizes
  if (( \${+commands[xrandr]} )); then
    sizes=(\${(f)"$(xrandr --current --listactivemonitors 2>/dev/null | awk 'NR > 1 { split($3, g, /[x+]/); split(g[1], w, "/"); split(g[2], h, "/"); print w[1] "x" h[1] }' | sort -u)"})
  fi
  _wanted resolutions expl 'resolution (WIDTHxHEIGHT)' compadd -a sizes
}

# Saved search queries or library tags (_backdrop_library_values queries|tags), from the database
_backdrop_library_values() {
  local database=${quote(database)}
  local -A sql=(queries ${quote(COMPLETION_SQL.queries)} tags ${quote(COMPLETION_SQL.tags)})
  if (( \${+commands[sqlite3]} )); then
    [[ -r $database ]] && sqlite3 -readonly -batch -noheader -cmd '.timeout 500' $database "$sql[$1]" 2>/dev/null
  elif (( \${+commands[backdrop]} )); then
    backdrop complete-values $1 2>/dev/null
  fi
}

_backdrop_queries() {
  local -a queries=(\${(f)"$(_backdrop_library_values queries)"})
  _wanted queries expl 'saved search query' compadd -a queries
}

_backdrop_tags() {
  local -a tags=(\${(f)"$(_backdrop_library_values tags)"})
  _wanted tags expl tag compadd -a tags
}

_backdrop_commands() {
  local -a backdrop_commands=(
${describe.join('\n')}
  )
  _describe -t commands 'backdrop command' backdrop_commands
}

_backdrop() {
  local curcontext="$curcontext" state line expl
  typeset -A opt_args

  _arguments -C \\
    '(- *)'{-V,--version}'[output the version number]' \\
    '(- *)'{-h,--help}'[display help for command]' \\
    '1: :_backdrop_commands' \\
    '*:: :->args'

  case $state in
    args)
      curcontext="\${curcontext%:*:*}:backdrop-$words[1]:"
      case $words[1] in
${cases.join('\n')}
      esac
      ;;
  esac
}

if [[ $funcstack[1] == _backdrop ]]; then
  _backdrop "$@"
else
  compdef _backdrop backdrop
fi
`;
  }
  // One function per command; options that take a value complete it after the option, positional
  // arguments complete by position (a variadic argument for every later position)
  bashCommand(command, specs) {
    const options = [...command.options.filter(option => !option.hidden), HELP];
    const words = options.flatMap(option => [option.short, option.long].filter(Boolean));
    const valued = options.filter(option => option.required || option.optional);
    const optionCases = valued.flatMap(option => {
      const spec = specFor(specs, command, option.long);
      const names = [option.short, option.long].filter(Boolean).join('|');
      return [`    ${names}) ${spec ? bashAction(spec) : 'COMPREPLY=()'}; return ;;`];
    });
    const argumentCases = command.registeredArguments.map((argument, index) => {
      const spec = specs[`${command.name()}:${argument.name()}`];
      const position = argument.variadic ? '*' : String(index + 1);
      return `    ${position}) ${spec ? bashAction(spec) : 'COMPREPLY=()'} ;;`;
    });
    const name = `_backdrop_cmd_${command.name().replace(/[^A-Za-z0-9_]/g, '_')}`;
    return {
      // Options whose next word is their value, so it is not counted as a positional argument
      valued: valued.filter(option => option.required).flatMap(option => [option.short, option.long].filter(Boolean)),
      body: `${name}() {
  local cur=$1 prev=$2 position=$3
  case $prev in
${optionCases.join('\n') || '    *) ;;'}
  esac
  if [[ $cur == -* ]]; then
    COMPREPLY=($(compgen -W ${quote(words.join(' '))} -- "$cur"))
    return
  fi
  case $position in
${argumentCases.join('\n') || '    *) ;;'}
  esac
}`,
      name
    };
  }

  bash(program, version) {
    const specs = valueSpecs(this.sources.names());
    const commands = program.commands.filter(command => !command._hidden);
    const built = commands.map(command => ({ command, ...this.bashCommand(command, specs) }));
    const state = statePath(this.config.get().paths.runtime);
    const { database } = this.config.get().paths;
    const dispatch = built.map(({ command, name, valued }) =>
      `    ${command.name()}) valued=${quote(` ${valued.join(' ')} `)}; handler=${name} ;;`);

    return `# bash completion for backdrop ${version}, generated by \`backdrop completion bash\`.
# Regenerate after upgrading backdrop. Install with either of:
#   backdrop completion bash > ~/.local/share/bash-completion/completions/backdrop
#   source <(backdrop completion bash)                       (in ~/.bashrc)

# Monitors the running daemon drives, else the active X monitors
_backdrop_monitors() {
  local state=${quote(state)} names=
  [[ -r $state ]] && names=$(grep -o '"name": *"[^"]*"' "$state" 2>/dev/null | sed 's/.*"\\([^"]*\\)"$/\\1/')
  if [[ -z $names ]] && command -v xrandr >/dev/null; then
    names=$(xrandr --current --listactivemonitors 2>/dev/null | awk 'NR > 1 { print $NF }')
  fi
  printf '%s\\n' "$names"
}

# WIDTHxHEIGHT of the active X monitors
_backdrop_resolutions() {
  command -v xrandr >/dev/null || return
  xrandr --current --listactivemonitors 2>/dev/null | awk 'NR > 1 { split($3, g, /[x+]/); split(g[1], w, "/"); split(g[2], h, "/"); print w[1] "x" h[1] }' | sort -u
}

# Saved search queries or library tags (_backdrop_library_values queries|tags), from the database
_backdrop_library_values() {
  local database=${quote(database)} sql
  case $1 in
    queries) sql=${quote(COMPLETION_SQL.queries)} ;;
    tags) sql=${quote(COMPLETION_SQL.tags)} ;;
  esac
  if command -v sqlite3 >/dev/null; then
    [[ -r $database ]] && sqlite3 -readonly -batch -noheader -cmd '.timeout 500' "$database" "$sql" 2>/dev/null
  elif command -v backdrop >/dev/null; then
    backdrop complete-values "$1" 2>/dev/null
  fi
}

_backdrop_queries() { _backdrop_library_values queries; }
_backdrop_tags() { _backdrop_library_values tags; }

${built.map(({ body }) => body).join('\n\n')}

_backdrop() {
  local cur=\${COMP_WORDS[COMP_CWORD]} prev=\${COMP_WORDS[COMP_CWORD-1]}
  local i command= start=0
  for ((i = 1; i < COMP_CWORD; i++)); do
    if [[ \${COMP_WORDS[i]} != -* ]]; then
      command=\${COMP_WORDS[i]}
      start=$i
      break
    fi
  done
  if [[ -z $command ]]; then
    COMPREPLY=($(compgen -W ${quote(['-h', '--help', '-V', '--version', ...commands.map(command => command.name())].join(' '))} -- "$cur"))
    return
  fi

  local valued= handler=
  case $command in
${dispatch.join('\n')}
    *) return ;;
  esac

  # Position of the word being completed among the command's arguments, skipping options and their values
  local position=1 word
  for ((i = start + 1; i < COMP_CWORD; i++)); do
    word=\${COMP_WORDS[i]}
    if [[ $word == -* ]]; then
      [[ $valued == *" $word "* ]] && ((i++))
    else
      ((position++))
    fi
  done
  "$handler" "$cur" "$prev" "$position"
}

complete -F _backdrop backdrop
`;
  }
}
