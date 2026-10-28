# Prints the matches zsh offers for a command line, one per line.
# usage: zsh -f zsh-capture.zsh <fpath dir> <command line> <output file>
zmodload zsh/zpty
zpty z zsh -f -i
zpty -w z "PROMPT=''; fpath=(${(q)1} \$fpath); autoload -Uz compinit; compinit -u -D"
zpty -w z "compadd() { builtin compadd -O __hits \"\$@\"; print -l -- \${__hits} >> ${(q)3}; builtin compadd \"\$@\" }"
zpty -w z "bindkey '^I' complete-word"
zpty -n -w z "$2"$'\t'
for i in {1..50}; do [[ -s $3 ]] && break; sleep 0.1; done
sleep 0.2
zpty -d z
