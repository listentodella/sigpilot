#!/usr/bin/env node
import { lstatSync, readdirSync, realpathSync, copyFileSync, unlinkSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export function normalizePythonRuntime(directory) {
  const root = realpathSync(directory);
  function visit(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isSymbolicLink()) {
        let target;
        try { target = realpathSync(path); }
        catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ELOOP") throw error;
          unlinkSync(path);
          continue;
        }
        const rel = relative(root, target);
        if (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel)) continue;
        if (!lstatSync(target).isFile()) throw new Error(`External Python directory link cannot be bundled: ${path}`);
        // Unlink first: copyFile must replace the link, not overwrite its target.
        unlinkSync(path);
        copyFileSync(target, path);
      }
    }
  }
  visit(root);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  normalizePythonRuntime(process.argv[2]);
}
