/**
 * `claim(name)` is `name`, or `name2`, `name3`, ... when it's taken, and marks
 * the result taken. Remembers each name's next suffix, so thousands of
 * colliding names don't rescan from 2 every time.
 */
export function uniqueNames(reserved: string[]): { claim: (name: string) => string } {
  const taken = new Set(reserved);
  const nextSuffix = new Map<string, number>();
  function claim(name: string): string {
    let unique = name;
    let suffix = nextSuffix.get(name) ?? 2;
    while (taken.has(unique)) unique = `${name}${suffix++}`;
    nextSuffix.set(name, suffix);
    taken.add(unique);
    return unique;
  }
  return { claim };
}

export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

export function pascalCase(text: string): string {
  return text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

/** PascalCase that's a valid identifier: `_` before a leading digit. */
export function typeName(text: string): string {
  const name = pascalCase(text);
  return /^\d/.test(name) ? `_${name}` : name;
}

export function camelCase(text: string): string {
  const name = typeName(text);
  return name.charAt(0).toLowerCase() + name.slice(1);
}

export function snakeCase(text: string): string {
  const name = words(text)
    .map((word) => word.toLowerCase())
    .join("_");
  return /^\d/.test(name) ? `_${name}` : name;
}

// Keywords, and names a package can't usefully have: `main` makes a command,
// `init` can't be imported, `documentation` is ignored by the go tool, and a
// predeclared identifier would shadow the builtin in every file importing it.
const GO_RESERVED = new Set([
  "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func",
  "go", "goto", "if", "import", "interface", "map", "package", "range", "return", "select", "struct",
  "switch", "type", "var", "main", "init", "documentation",
  "any", "bool", "byte", "comparable", "complex64", "complex128", "error", "float32", "float64", "int",
  "int8", "int16", "int32", "int64", "rune", "string", "uint", "uint8", "uint16", "uint32", "uint64",
  "uintptr", "true", "false", "iota", "nil", "append", "cap", "clear", "close", "complex", "copy",
  "delete", "imag", "len", "make", "max", "min", "new", "panic", "print", "println", "real", "recover",
]);

/** The Go package a registry generates into: lowercase letters and digits, never a keyword. */
export function goPackageName(name: string): string {
  const pkg = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return /^\d/.test(pkg) || GO_RESERVED.has(pkg) ? `x${pkg}` : pkg;
}

export const PYTHON_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def",
  "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is",
  "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

/** The Python module a registry generates into, importable as `webhooks.<module>`. */
export function pythonModuleName(name: string): string {
  const module = snakeCase(name);
  return PYTHON_KEYWORDS.has(module) ? `${module}_` : module;
}
