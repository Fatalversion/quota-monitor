/**
 * A single-purpose bundler for the single-executable (SEA) build.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * Node's SEA loader gives the injected main script a `require()` that can only
 * load built-in modules:
 *
 *   > It can only be used to load built-in modules. Attempting to load a module
 *   > that can only be found in the file system will throw an error.
 *   -- nodejs.org/api/single-executable-applications.html
 *
 * So the whole program has to arrive as one CommonJS file. Every off-the-shelf
 * way to do that (esbuild, rollup, bun, pkg, ncc) is a new dependency, and this
 * project's whole pitch is that it reads local files with one runtime dep. So
 * we bundle the ~13 modules we actually have, ourselves, in about 300 lines.
 *
 * WHAT MAKES THAT SAFE
 * --------------------
 * This is NOT a general JavaScript bundler and must never pretend to be one.
 * It handles exactly the syntax `tsc` emits for this codebase plus plain CJS,
 * and it THROWS on anything it does not recognise. A bundler that guesses is
 * how you ship a binary that silently behaves differently from `npm run dev`.
 *
 * Three checks keep it honest:
 *   1. every import/export form is matched against an explicit whitelist; an
 *      unrecognised line is a hard build error naming the file and line
 *   2. after transforming an ES module, the export names we produced are
 *      compared against the real module's namespace, obtained by actually
 *      importing it. A mismatch is a hard build error.
 *   3. the caller (build-sidecar.mjs) runs the finished binary and diffs its
 *      output against the TypeScript source of truth.
 *
 * The output format is a flat module registry keyed by repo-relative POSIX
 * path. Specifiers are resolved at BUILD time, so the runtime `require` is a
 * map lookup with a built-in-module fallback - no path resolution, no `fs`.
 */

import { createRequire } from 'node:module';
import { builtinModules } from 'node:module';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Bare specifiers that resolve to Node itself and must stay untouched. */
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  'node:sea',
  'node:test',
]);

/** Module ids are POSIX-ish so the generated bundle looks the same on any OS. */
function idOf(root, absPath) {
  return relative(root, absPath).split(sep).join('/');
}

/** Is `child` at or below `parent`? Separator- and case-safe, unlike startsWith. */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * ESM or CJS? Decided the way Node decides it: nearest package.json "type".
 *
 * Getting this wrong is not cosmetic - a module treated as the wrong format
 * gets the wrong transform - so the walk stops at the project root rather than
 * wandering up into whatever is above the checkout.
 */
async function moduleFormat(absPath, root, cache) {
  if (absPath.endsWith('.mjs')) return 'module';
  if (absPath.endsWith('.cjs')) return 'commonjs';

  const seen = [];
  let dir = resolve(dirname(absPath));
  for (;;) {
    const cached = cache.get(dir);
    if (cached !== undefined) {
      for (const d of seen) cache.set(d, cached);
      return cached;
    }
    seen.push(dir);

    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      let type = 'commonjs';
      try {
        const parsed = JSON.parse(await readFile(pkgPath, 'utf8'));
        if (parsed?.type === 'module') type = 'module';
      } catch {
        // A package.json we cannot parse means we cannot claim to know the
        // format. Guessing here would be exactly the silent failure we forbid.
        throw new Error(`bundle: cannot parse ${pkgPath}, so the module format of ${absPath} is unknown`);
      }
      for (const d of seen) cache.set(d, type);
      return type;
    }

    const parent = dirname(dir);
    if (parent === dir || !isInside(root, parent)) {
      for (const d of seen) cache.set(d, 'commonjs');
      return 'commonjs';
    }
    dir = parent;
  }
}

/* -------------------------------------------------------------------------- */
/* ES module -> CommonJS                                                      */
/* -------------------------------------------------------------------------- */

const RE_NAMED_IMPORT = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)';\s*$/;
const RE_BARE_IMPORT = /^import\s*'([^']+)';\s*$/;
const RE_EXPORT_FN = /^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const RE_EXPORT_CLASS = /^export\s+class\s+([A-Za-z_$][\w$]*)/;
const RE_EXPORT_VAR = /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/;

/**
 * Rewrite one `tsc`-emitted ES module as a CommonJS function body.
 *
 * Only the forms this codebase actually emits are handled. `export {}`,
 * `export default`, `export * from`, default imports, namespace imports and
 * dynamic `import()` all throw, because translating them wrongly would be
 * worse than not shipping.
 *
 * Live bindings are not emulated: exports are assigned once at the end of the
 * module. That is correct only for an acyclic graph, which `collectGraph`
 * verifies before this ever runs.
 */
function esmToCjs(source, file, resolveSpec) {
  const lines = source.split('\n');
  const exported = [];
  const out = [];

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    const where = `${file}:${i + 1}`;

    if (/^import\b/.test(line) || /^\s*import\s*\(/.test(line)) {
      const named = RE_NAMED_IMPORT.exec(line);
      if (named) {
        const clause = named[1]
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part !== '')
          .map((part) => {
            const alias = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(part);
            if (alias) return `${alias[1]}: ${alias[2]}`;
            if (!/^[A-Za-z_$][\w$]*$/.test(part)) {
              throw new Error(`bundle: unsupported import binding "${part}" at ${where}`);
            }
            return part;
          })
          .join(', ');
        out.push(`const { ${clause} } = require(${JSON.stringify(resolveSpec(named[2], where))});`);
        continue;
      }

      const bare = RE_BARE_IMPORT.exec(line);
      if (bare) {
        out.push(`require(${JSON.stringify(resolveSpec(bare[1], where))});`);
        continue;
      }

      throw new Error(
        `bundle: unsupported import form at ${where}\n  ${line.trim()}\n` +
          '  Only single-line `import { a, b as c } from \'spec\';` is handled. ' +
          'Teach scripts/lib/bundle.mjs the new form rather than working around it.',
      );
    }

    if (/^export\b/.test(line)) {
      if (/^export\s+(default|\*|\{)/.test(line)) {
        throw new Error(
          `bundle: unsupported export form at ${where}\n  ${line.trim()}\n` +
            '  Only inline `export const|let|var|function|class NAME` is handled.',
        );
      }
      const match = RE_EXPORT_FN.exec(line) ?? RE_EXPORT_CLASS.exec(line) ?? RE_EXPORT_VAR.exec(line);
      if (!match) {
        throw new Error(`bundle: unrecognised export at ${where}\n  ${line.trim()}`);
      }
      exported.push(match[1]);
      line = line.replace(/^export\s+/, '');
    }

    // `import.meta.url` has no meaning in CommonJS. The two uses in the CLI
    // (reading package.json, and the "was I executed directly?" check) both
    // want a file URL for this module, and __filename gives that. Inside the
    // binary that path does not exist on disk, which is exactly right: the
    // entry-point check must be false there, because the generated entry calls
    // main() itself, and the version comes from the build stamp instead.
    if (line.includes('import.meta')) {
      if (!/import\.meta\.url/.test(line)) {
        throw new Error(`bundle: unsupported import.meta use at ${where}\n  ${line.trim()}`);
      }
      line = line.replaceAll('import.meta.url', 'require("node:url").pathToFileURL(__filename).href');
    }

    out.push(line);
  }

  // ES modules are always strict; a CommonJS function body is not. Without
  // this the same source would run under different semantics in the binary.
  out.unshift("'use strict';");
  for (const name of exported) out.push(`exports.${name} = ${name};`);

  return { code: out.join('\n'), exported };
}

/* -------------------------------------------------------------------------- */
/* CommonJS                                                                   */
/* -------------------------------------------------------------------------- */

const RE_REQUIRE = /require\('([^']+)'\)|require\("([^"]+)"\)/g;

/** Point every static `require('./x.js')` at its build-time module id. */
function rewriteCjs(source, file, resolveSpec) {
  const specs = [];
  const code = source.replace(RE_REQUIRE, (whole, single, double) => {
    const spec = single ?? double;
    const id = resolveSpec(spec, file);
    specs.push(id);
    return `require(${JSON.stringify(id)})`;
  });

  // A computed require cannot be resolved at build time, so it would blow up
  // at runtime inside the binary and nowhere else. Refuse to build instead.
  const dynamic = /require\(\s*(?!['"])/.exec(code);
  if (dynamic) {
    throw new Error(
      `bundle: computed require() in ${file} at offset ${dynamic.index}; ` +
        'this bundler only resolves string-literal requires',
    );
  }

  return { code: "'use strict';\n" + code, specs };
}

/* -------------------------------------------------------------------------- */
/* graph                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Walk the dependency graph from `entry`, transforming as we go.
 *
 * Returns modules in reverse-postorder (dependencies first) and throws on a
 * cycle, because the export-at-the-end strategy in `esmToCjs` is only correct
 * for an acyclic graph.
 */
async function collectGraph(entryPath, rootPath) {
  // Normalise once. Mixing "L:/a/b" and "L:\a\b" makes every path comparison
  // below lie, and the lies do not surface until much later.
  const entry = resolve(entryPath);
  const root = resolve(rootPath);
  const modules = new Map();
  const formats = new Map();
  const order = [];
  const stack = [];
  const nodeRequire = createRequire(join(root, 'package.json'));

  async function visit(absPath) {
    const id = idOf(root, absPath);

    // Cycle check first: a module already in `modules` may still be an
    // ancestor on the stack, and returning early there would hide the cycle.
    const cycleAt = stack.indexOf(id);
    if (cycleAt !== -1) {
      throw new Error(
        `bundle: import cycle ${[...stack.slice(cycleAt), id].join(' -> ')}\n` +
          '  The generated bundle assigns exports at the end of each module, ' +
          'which is only correct without cycles.',
      );
    }
    if (modules.has(id)) return id;
    stack.push(id);

    // A shebang is legal at the top of a file and illegal inside the function
    // body each module becomes. dist/cli/index.js has one.
    const source = (await readFile(absPath, 'utf8')).replace(/^#![^\n]*\n/, '// (shebang removed by the SEA bundler)\n');
    const format = await moduleFormat(absPath, root, formats);
    const deps = [];

    /** Specifier -> module id, resolving and queueing the dependency. */
    const resolveSpec = (spec, where) => {
      if (BUILTINS.has(spec)) return spec;
      if (spec.startsWith('node:')) {
        throw new Error(`bundle: unknown node: builtin "${spec}" at ${where}`);
      }

      let target;
      if (spec.startsWith('./') || spec.startsWith('../')) {
        target = resolve(dirname(absPath), spec);
        if (!existsSync(target)) {
          throw new Error(`bundle: ${where} imports "${spec}", which does not exist at ${target}`);
        }
      } else {
        try {
          target = nodeRequire.resolve(spec, { paths: [dirname(absPath)] });
        } catch (error) {
          throw new Error(`bundle: cannot resolve "${spec}" from ${where}: ${error.message}`);
        }
      }
      deps.push(target);
      return idOf(root, target);
    };

    const transformed =
      format === 'module'
        ? esmToCjs(source, id, resolveSpec)
        : rewriteCjs(source, id, resolveSpec);

    if (format === 'module') {
      // The one check that catches a transform that "looked right". Import the
      // real module and compare namespaces; anything we dropped or invented
      // shows up here instead of as a TypeError inside the shipped binary.
      const namespace = await import(pathToFileURL(absPath).href);
      const actual = Object.keys(namespace).filter((key) => key !== 'default').sort();
      const produced = [...transformed.exported].sort();
      if (actual.join(',') !== produced.join(',')) {
        throw new Error(
          `bundle: export mismatch in ${id}\n` +
            `  module really exports: ${actual.join(', ') || '(nothing)'}\n` +
            `  transform produced:    ${produced.join(', ') || '(nothing)'}`,
        );
      }
    }

    modules.set(id, { id, format, code: transformed.code });
    for (const dep of deps) await visit(dep);

    stack.pop();
    order.push(id);
    return id;
  }

  const entryId = await visit(entry);
  return { modules, order, entryId };
}

/* -------------------------------------------------------------------------- */
/* emit                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Build the single CommonJS file that gets injected into the binary.
 *
 * `versionStamp` is the one piece of build-time knowledge the program needs:
 * inside a single file there is no package.json to read, so the CLI reads the
 * stamp instead of reporting an honest but useless "unknown".
 */
export async function bundle({ entry, root, versionStamp }) {
  const { modules, order, entryId } = await collectGraph(entry, root);

  const parts = [
    '// GENERATED by scripts/lib/bundle.mjs - do not edit.',
    '// One CommonJS file, because Node\'s single-executable loader can only',
    '// require() built-in modules. See scripts/lib/bundle.mjs for the why.',
    "'use strict';",
    'const __nodeRequire = require;',
    'const __path = require("node:path");',
    '// Synthetic root for __filename/__dirname. Nothing is read from it; it',
    '// only has to be stable and absolute so path maths inside modules works.',
    'const __root = __path.join(__path.dirname(process.execPath), "quota-monitor");',
    'const __modules = Object.create(null);',
    'const __cache = Object.create(null);',
    'function __require(id) {',
    '  const cached = __cache[id];',
    '  if (cached !== undefined) return cached.exports;',
    '  const factory = __modules[id];',
    '  if (factory === undefined) return __nodeRequire(id);',
    '  const file = __path.join(__root, id);',
    '  const mod = { id, exports: {}, loaded: false };',
    '  __cache[id] = mod;',
    '  factory.call(mod.exports, mod.exports, __require, mod, file, __path.dirname(file));',
    '  mod.loaded = true;',
    '  return mod.exports;',
    '}',
    '',
  ];

  for (const id of order) {
    const mod = modules.get(id);
    parts.push(`__modules[${JSON.stringify(id)}] = function (exports, require, module, __filename, __dirname) {`);
    parts.push(mod.code);
    parts.push('};');
    parts.push('');
  }

  parts.push('// Build-time version stamp: see readVersion() in src/cli/index.ts.');
  parts.push(`globalThis.__QUOTA_MONITOR_VERSION__ = ${JSON.stringify(versionStamp)};`);
  parts.push('// The CLI\'s own isEntryPoint() check is false in here (its __filename');
  parts.push('// is synthetic), so main() is called explicitly and exactly once.');
  parts.push(`void __require(${JSON.stringify(entryId)}).main();`);
  parts.push('');

  return {
    code: parts.join('\n'),
    moduleCount: modules.size,
    ids: order,
  };
}
