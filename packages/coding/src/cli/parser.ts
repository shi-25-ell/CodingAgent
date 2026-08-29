import { type CliCommand, type CliRunOverrides, CliUsageError } from "./contracts.js";

interface MutableOverrides {
  provider?: string;
  model?: string;
  permissionMode?: "safe" | "autonomous";
  maxModelTurns?: number;
  maxModelAttempts?: number;
  maxRetries?: number;
  tools: string[];
  extensions: string[];
  skills: string[];
  structured: boolean;
}

function valueAfter(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new CliUsageError(`${flag} 需要参数`);
  return value;
}

function boundedInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CliUsageError(`${flag} 必须是正整数`);
  }
  return parsed;
}

function addCsv(target: string[], value: string, flag: string): void {
  const items = value.split(",").map((item) => item.trim());
  if (items.some((item) => item.length === 0)) throw new CliUsageError(`${flag} 包含空 ID`);
  target.push(...items);
}

function parseOverrides(argv: readonly string[]): {
  overrides: CliRunOverrides;
  positional: string[];
} {
  const mutable: MutableOverrides = {
    tools: [],
    extensions: [],
    skills: [],
    structured: false,
  };
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    switch (argument) {
      case "--json":
        mutable.structured = true;
        break;
      case "--provider":
        mutable.provider = valueAfter(argv, index++, argument);
        break;
      case "--model":
        mutable.model = valueAfter(argv, index++, argument);
        break;
      case "--permission": {
        const value = valueAfter(argv, index++, argument);
        if (value !== "safe" && value !== "autonomous") {
          throw new CliUsageError("--permission 只接受 safe 或 autonomous");
        }
        mutable.permissionMode = value;
        break;
      }
      case "--max-model-turns":
        mutable.maxModelTurns = boundedInteger(valueAfter(argv, index++, argument), argument);
        break;
      case "--max-model-attempts":
        mutable.maxModelAttempts = boundedInteger(valueAfter(argv, index++, argument), argument);
        break;
      case "--max-retries":
        mutable.maxRetries = boundedInteger(valueAfter(argv, index++, argument), argument);
        break;
      case "--tools":
        addCsv(mutable.tools, valueAfter(argv, index++, argument), argument);
        break;
      case "--extension":
        mutable.extensions.push(valueAfter(argv, index++, argument));
        break;
      case "--skill":
        mutable.skills.push(valueAfter(argv, index++, argument));
        break;
      default:
        throw new CliUsageError(`未知 flag: ${argument}`);
    }
  }
  const unique = (values: readonly string[], label: string): readonly string[] => {
    if (new Set(values).size !== values.length) throw new CliUsageError(`${label} 不能重复`);
    return Object.freeze([...values]);
  };
  return {
    overrides: Object.freeze({
      ...(mutable.provider ? { provider: mutable.provider } : {}),
      ...(mutable.model ? { model: mutable.model } : {}),
      ...(mutable.permissionMode ? { permissionMode: mutable.permissionMode } : {}),
      ...(mutable.maxModelTurns ? { maxModelTurns: mutable.maxModelTurns } : {}),
      ...(mutable.maxModelAttempts ? { maxModelAttempts: mutable.maxModelAttempts } : {}),
      ...(mutable.maxRetries ? { maxRetries: mutable.maxRetries } : {}),
      tools: unique(mutable.tools, "tool override"),
      extensions: unique(mutable.extensions, "extension override"),
      skills: unique(mutable.skills, "skill override"),
      structured: mutable.structured,
    }),
    positional,
  };
}

function requireOne(values: readonly string[], usage: string): string {
  if (values.length !== 1 || !values[0]) throw new CliUsageError(usage);
  return values[0];
}

export function parseCli(argv: readonly string[]): CliCommand {
  if (argv.length === 0) {
    return { type: "interactive", overrides: parseOverrides([]).overrides };
  }
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") return { type: "help" };
  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
    return { type: "version" };
  }
  if (argv[0] === "--runtime-diagnostic") return { type: "runtime_diagnostic" };

  if (argv[0] === "--print") {
    const { overrides, positional } = parseOverrides(argv.slice(1));
    if (positional.length > 1) throw new CliUsageError("--print 最多接受一个 Coding Task");
    return { type: "print", ...(positional[0] ? { task: positional[0] } : {}), overrides };
  }

  const command = argv[0];
  const subcommand = argv[1];
  if (command === "doctor") {
    const { overrides, positional } = parseOverrides(argv.slice(1));
    if (positional.length > 0) throw new CliUsageError("doctor 只接受 --json");
    return { type: "doctor", structured: overrides.structured };
  }
  const { overrides, positional } = parseOverrides(argv.slice(2));
  const structured = overrides.structured;
  if (command === "models" && subcommand === "list" && positional.length === 0) {
    return { type: "models_list", structured };
  }
  if (command === "skills" && subcommand === "list" && positional.length === 0) {
    return { type: "skills_list", structured };
  }
  if (
    command === "extensions" &&
    (subcommand === "list" || subcommand === "diagnose") &&
    positional.length === 0
  ) {
    return { type: subcommand === "list" ? "extensions_list" : "extensions_diagnose", structured };
  }
  if (command === "session") {
    if (subcommand === "list" && positional.length === 0)
      return { type: "session_list", structured };
    if (subcommand === "new" && positional.length === 0) return { type: "session_new", overrides };
    if ((subcommand === "open" || subcommand === "resume") && positional.length === 1) {
      return { type: "session_resume", sessionId: positional[0] as string, overrides };
    }
    if (subcommand === "branch") {
      const sessionId = requireOne(positional.slice(0, 1), "session branch 需要 Session ID");
      if (positional.length > 2)
        throw new CliUsageError("session branch 最多接受 Session ID 和 Branch ID");
      return {
        type: "session_branch",
        sessionId,
        ...(positional[1] ? { fromBranchId: positional[1] } : {}),
        overrides,
      };
    }
  }
  throw new CliUsageError(`未知 command: ${argv.join(" ")}`);
}
