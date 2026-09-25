export interface PreparedCommand { program: string; args: string[]; display: string }

/** A literal argument grammar, not a shell. No expansions or compound commands. */
export function parseCommand(command: string): string[] {
  if (command.length > 8192 || /[\0\r\n]/.test(command)) throw new Error("Command is too long or contains control characters.");
  const tokens: string[] = [];
  let token = "", quote = "", active = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = ""; else token += char;
    } else if (quote === '"') {
      if (char === '"') quote = "";
      else if (char === "\\") {
        const next = command[++i];
        if (next === undefined) throw new Error("Incomplete quoted argument.");
        token += next;
      } else if (char === "$" || char === "`") throw new Error("Shell expansions are not supported.");
      else token += char;
    } else if (/\s/.test(char)) {
      if (active) { tokens.push(token); token = ""; active = false; }
    } else if (char === "'" || char === '"') { quote = char; active = true; }
    else if (";&|<>$`(){}*?[]~\\".includes(char)) throw new Error("Use one command with literal arguments; shell operators and expansions are not supported.");
    else { token += char; active = true; }
  }
  if (quote) throw new Error("Unclosed quoted argument.");
  if (active) tokens.push(token);
  return tokens;
}

export function quoteArgument(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,~^-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

export function prepareCommand(name: string, input: Record<string, unknown>): PreparedCommand {
  const tokens = name === "run_command"
    ? parseCommand(typeof input.command === "string" ? input.command : "")
    : [input.program, ...(Array.isArray(input.args) ? input.args : [undefined])];
  if (!tokens.length || tokens.some(token => typeof token !== "string" || /[\0\r\n]/.test(token))) {
    throw new Error("Expected a program and literal string arguments.");
  }
  const [program, ...args] = tokens as string[];
  if (!/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(program)) throw new Error("Use an executable name from PATH, not a path, assignment, or shell expression.");
  if (["sudo", "su", "doas", "pkexec", "runas"].includes(program.toLowerCase().replace(/\.(?:exe|com)$/, ""))) throw new Error("Elevation wrappers are unavailable in Safe list.");
  const display = [program, ...args].map(quoteArgument).join(" ");
  if (display.length > 8192) throw new Error("Command is too long.");
  return { program, args, display };
}
