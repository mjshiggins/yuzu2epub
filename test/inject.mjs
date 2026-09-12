/**
 * Mimics chrome.scripting.executeScript's serialisation boundary.
 *
 * executeScript sends ONLY the source of the function you name. Anything else
 * in the file, including helpers at module scope, does not exist in the page.
 * Tests that load the whole file into one context cannot see that, which is
 * how a "tocPanelContains is not defined" failure reached a real run.
 *
 * loadInjected() therefore reads the function out of the file, takes its
 * toString(), and evaluates that alone in a context holding only page globals.
 */
import fs from 'node:fs';
import vm from 'node:vm';

export function loadInjected(filePath, fnName, pageGlobals) {
  // Step 1: read the function object out of the file.
  const holder = { console };
  vm.createContext(holder);
  vm.runInContext(fs.readFileSync(filePath, 'utf8') + `\n;globalThis.__fn = ${fnName};`, holder, {
    filename: filePath,
  });
  const source = holder.__fn.toString();

  // Step 2: evaluate just that source in a context with page globals only.
  const ctx = { ...pageGlobals };
  vm.createContext(ctx);
  vm.runInContext(`globalThis.__injected = (${source});`, ctx, { filename: `${fnName} (injected)` });
  return { call: (...args) => ctx.__injected(...args), ctx, source };
}
