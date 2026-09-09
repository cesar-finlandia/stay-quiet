// Requirement IDs: RES-REU-01, TRN-06, UI-REU-02 | DP-A §9.1 / DP-B §6.6
// Lazy Node-builtin resolution for isomorphic resilience code.
//
// The curated barrel (index.ts) is imported by src/platform/ui (isDegraded →
// isDegradedResult) and therefore by browser bundles. Static `import ... from
// "node:fs"` anywhere in that graph crashes browser builds at module
// evaluation (Vite externalizes node builtins and their shim throws on any
// property access). process.getBuiltinModule (Node ≥22.3) resolves the same
// stdlib module synchronously WITHOUT a static import statement, so bundlers
// never see it. Outside Node it returns null and callers degrade gracefully —
// matching §7.4 "never throws" semantics.

/** Resolve a Node builtin at call time; null outside Node (browser-safe). */
export function nodeBuiltin<T>(id: string): T | null {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  try {
    return proc?.getBuiltinModule ? ((proc.getBuiltinModule(id) ?? null) as T | null) : null;
  } catch {
    return null;
  }
}

/** True only in a real Node runtime (process.versions.node present). */
export function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && !!process.versions?.node;
}
