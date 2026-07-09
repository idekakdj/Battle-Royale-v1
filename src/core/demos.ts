/**
 * Demo registry (BLUEPRINT §14, "Shared demo-flag convention").
 *
 * `main.ts` reads `?demo=<name>` from the URL and runs the matching demo instead
 * of the lobby. Each work package registers its own demo from its own module via
 * {@link registerDemo}, so packages never need to edit `main.ts`.
 *
 * A demo receives the shared root element and may return a teardown function.
 */

export type DemoFn = (root: HTMLElement) => void | (() => void) | Promise<void | (() => void)>;

const registry = new Map<string, DemoFn>();

/** Register a demo under `name`. Later registrations overwrite earlier ones. */
export function registerDemo(name: string, fn: DemoFn): void {
  registry.set(name, fn);
}

/** Look up a registered demo, or `undefined` if none matches `name`. */
export function getDemo(name: string): DemoFn | undefined {
  return registry.get(name);
}

/** Whether a demo is registered under `name`. */
export function hasDemo(name: string): boolean {
  return registry.has(name);
}

/** All registered demo names (for a `?demo` index / listing). */
export function demoNames(): string[] {
  return [...registry.keys()];
}
