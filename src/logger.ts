// Préfixe chaque console.log/warn/error d'un horodatage HH:MM:SS.
// À importer une seule fois (dans index.ts) : s'applique ensuite à tout le programme.

const original = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

console.log = (...args: unknown[]) => original.log(`[${timestamp()}]`, ...args);
console.warn = (...args: unknown[]) => original.warn(`[${timestamp()}]`, ...args);
console.error = (...args: unknown[]) => original.error(`[${timestamp()}]`, ...args);
