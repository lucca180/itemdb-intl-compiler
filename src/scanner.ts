import fs from "fs";
import path from "path";
import parser from "@babel/parser";
import traverse, { NodePath } from "@babel/traverse";
import {
  ArgumentPlaceholder,
  CallExpression,
  Expression,
  File,
  isBinaryExpression,
  isConditionalExpression,
  isStringLiteral,
  isTemplateLiteral,
  SpreadElement,
} from "@babel/types";

import ts from "typescript";

// @ts-expect-error ts error
const transverseDefault = traverse.default! as typeof traverse;

const aliasMap: Record<string, string> = {};

function loadAliasFromTSConfig(projectRoot: string) {
  const configPath =
    ts.findConfigFile(projectRoot, ts.sys.fileExists, "tsconfig.json") ||
    ts.findConfigFile(projectRoot, ts.sys.fileExists, "jsconfig.json");

  if (!configPath) return;

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const config = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath)
  );

  if (config.options.paths) {
    for (const [aliasPattern, paths] of Object.entries(config.options.paths)) {
      const cleanPattern = aliasPattern.replace(/\*$/, "");
      const target = paths[0].replace(/\*$/, "");

      if (cleanPattern === "@prisma/generated/") continue;

      aliasMap[cleanPattern] = path.resolve(
        config.options.baseUrl || projectRoot,
        target
      );
    }
  }
}

function resolveWithAlias(importPath: string, baseDir: string): string | null {
  if (importPath.startsWith(".")) {
    return resolveImportPath(importPath, baseDir);
  }

  for (const alias in aliasMap) {
    if (importPath.startsWith(alias)) {
      const relativePath = importPath.replace(alias, aliasMap[alias] + "/");
      return resolveImportPath(relativePath, baseDir);
    }
  }

  return null;
}

type ScanResult = {
  keys: string[];
  namespaces: string[];
};

function resolveImportPath(importPath: string, baseDir: string): string | null {
  const fullPath = path.resolve(baseDir, importPath);
  const extensions = [".ts", ".tsx", ".js", ".jsx"];

  for (const ext of extensions) {
    const tryPath = fullPath + ext;
    if (fs.existsSync(tryPath)) return tryPath;
  }

  for (const ext of extensions) {
    const tryPath = path.join(fullPath, "index" + ext);
    if (fs.existsSync(tryPath)) return tryPath;
  }

  return null;
}

function extractTCalls(
  code: string,
  filename: string,
  foundKeys: Set<string>,
  namespaces: Set<string>,
  importedFiles: string[]
) {
  const ast: File = parser.parse(code, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });

  const dirname = path.dirname(filename);

  transverseDefault(ast, {
    ImportDeclaration(path) {
      const importPath = path.node.source.value;
      if (!importPath.startsWith(".") && !importPath.startsWith("@")) return;
      const resolved = resolveWithAlias(importPath, dirname);
      if (resolved) importedFiles.push(resolved);
    },
    CallExpression(path) {
      const callee = path.get("callee");

      // next/dynamic call
      if (
        callee.isIdentifier() &&
        callee.node.name === "dynamic" &&
        path.node.arguments.length
      ) {
        const arg = path.node.arguments[0];

        if (
          arg.type === "ArrowFunctionExpression" &&
          arg.body.type === "CallExpression" &&
          arg.body.callee.type === "Import"
        ) {
          const importArg = arg.body.arguments[0];

          if (importArg.type === "StringLiteral") {
            const importPath = importArg.value;
            const resolved = resolveWithAlias(importPath, dirname);
            if (resolved) importedFiles.push(resolved);
          }
        }
      }

      // chamada t(...)
      const args = path.node.arguments;
      if (isTranslationCall(path)) {
        const firstArg = args[0];

        if (firstArg?.type === "StringLiteral") {
          foundKeys.add(firstArg.value);
          // const [ns] = firstArg.value.split(".");
          // namespaces.add(ns);
        } else {
          const location = path.node.loc;
          const fileInfo = location
            ? ` (${filename}:${location.start.line})`
            : ` (${filename})`;

          let namespaceGuess: string[] = tryExtractNamespaceFromDynamic(
            firstArg as Expression | SpreadElement | ArgumentPlaceholder
          );

          if (!namespaceGuess.length) {
            const codeSnippet = code.slice(firstArg.start!, firstArg.end!);
            console.log(
              `⚠️  Chave dinâmica Impossível encontrada em${fileInfo}`
            );
            console.log(`   → Expressão: ${codeSnippet}`);
            foundKeys.add("[IMPOSSIBLE_DYNAMIC_KEY]");
          } else {
            for (const ns of namespaceGuess) {
              namespaces.add(ns);
            }
            // console.log(
            //   `🔍 Chave dinâmica encontrada em ${fileInfo} - Namespace(s): ${namespaceGuess}`
            // );
            foundKeys.add("[DYNAMIC_KEY]");
          }
        }
      }
    },
  });
}

function scanFileRecursive(
  entry: string,
  visited: Set<string>,
  foundKeys: Set<string>,
  namespaces: Set<string>
) {
  const resolved = path.resolve(entry);
  if (visited.has(resolved)) return;
  visited.add(resolved);

  const code = fs.readFileSync(resolved, "utf-8");
  const importedFiles: string[] = [];

  extractTCalls(code, resolved, foundKeys, namespaces, importedFiles);

  for (const imp of importedFiles) {
    scanFileRecursive(imp, visited, foundKeys, namespaces);
  }
}

export async function scan(entryFile: string): Promise<ScanResult> {
  const foundKeys = new Set<string>();
  const namespaces = new Set<string>();
  scanFileRecursive(entryFile, new Set<string>(), foundKeys, namespaces);

  return {
    keys: Array.from(foundKeys),
    namespaces: Array.from(namespaces),
  };
}

function findPages(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findPages(fullPath));
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

export async function scanAllPagesInDir(
  dir: string,
  tsConfig?: string
): Promise<{
  allKeys: string[];
  allNamespaces: string[];
  perPage: Record<string, ScanResult>;
}> {
  tsConfig && loadAliasFromTSConfig(tsConfig);
  const pageFiles = findPages(dir);
  const perPage: Record<string, ScanResult> = {};
  const allKeys = new Set<string>();
  const allNamespaces = new Set<string>();

  for (const file of pageFiles) {
    const result = await scan(file);

    if (
      result.namespaces.length === 0 &&
      result.keys.includes("[DYNAMIC_KEY]")
    ) {
      console.log(
        `⚠️ Chave dinâmica sem nenhum namespace detectado em ${file}. Pulando.`
      );
      continue;
    }

    if (result.keys.includes("[IMPOSSIBLE_DYNAMIC_KEY]")) {
      console.log(
        `⚠️ Chave dinâmica impossível detectada em ${file}. Pulando.`
      );
      continue;
    }

    if (result.keys.length === 0 && result.namespaces.length === 0) {
      // console.log(`⚠️ Nenhuma chave encontrada em ${file}. Pulando.`);
      continue;
    }

    perPage[file] = result;

    result.keys.forEach((k) => allKeys.add(k));
    result.namespaces.forEach((ns) => allNamespaces.add(ns));
  }

  return {
    allKeys: Array.from(allKeys),
    allNamespaces: Array.from(allNamespaces),
    perPage,
  };
}

export function isTranslationCall(path: NodePath<CallExpression>): boolean {
  const callee = path.get("callee");
  const args = path.node.arguments;

  if (!args.length) return false;

  if (callee.isIdentifier() && callee.node.name === "t") {
    return true;
  }

  if (callee.isMemberExpression()) {
    const object = callee.get("object");
    if (object.isIdentifier() && object.node.name === "t") {
      return true;
    }
  }

  return false;
}

function tryExtractNamespaceFromDynamic(node: any): string[] {
  if (!node) return [];

  // Case 1: Template literal - `namespace.${key}`
  if (isTemplateLiteral(node)) {
    const first = node.quasis[0]?.value.raw;
    if (first) {
      const namespace = first.split(".")[0];
      if (namespace) return [namespace];
    }
  }

  // Case 2: Binary expression - "namespace." + key
  if (isBinaryExpression(node) && isStringLiteral(node.left)) {
    const match = node.left.value.split(".");
    if (match) return [match[0]];
  }

  // Case 3: Ternary operator - condition ? "ns1.key" : "ns2.key"
  if (isConditionalExpression(node)) {
    const options = [node.consequent, node.alternate];
    return (
      options
        //@ts-ignore
        .filter(isStringLiteral)
        .map((lit) => lit.value.split(".")[0])
    );
  }

  return [];
}
