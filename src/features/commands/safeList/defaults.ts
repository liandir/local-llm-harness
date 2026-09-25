/** Whole-command patterns. Filesystem containment is independently enforced. */
export const DEFAULT_SAFE_PATTERNS = [
  "(?:grep|rg)(?: -(?:n|i|v|l|c|E|F|r|H)| --(?:line-number|ignore-case|files|hidden))* .+",
  "mkdir(?: -p)?(?: --)? (?!-)(?:\\S+|'[^']*')(?: (?!-)(?:\\S+|'[^']*'))*",
  "rmdir(?: --)? (?!-)(?:\\S+|'[^']*')(?: (?!-)(?:\\S+|'[^']*'))*",
  "rm(?: --)? (?!-)(?:\\S+|'[^']*')(?: (?!-)(?:\\S+|'[^']*'))*",
  "git status(?: --short| --porcelain| -sb)?",
  "git diff(?: --(?:cached|staged|stat|name-only|name-status))*(?: -- .+)?",
  "git log(?: --oneline)?(?: -[0-9]+)?",
  "git show(?: --stat)?(?: [A-Za-z0-9_./~^:-]+)?",
  "git ls-files(?: -- .+)?",
  "git branch(?: -a| -r| --list)?"
];
