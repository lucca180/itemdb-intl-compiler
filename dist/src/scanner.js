import fs from "fs";
import path from "path";
import parser from "@babel/parser";
import traverse from "@babel/traverse";
import { isBinaryExpression, isConditionalExpression, isStringLiteral, isTemplateLiteral, } from "@babel/types";
import ts from "typescript";
// @ts-expect-error ts error
const transverseDefault = traverse.default;
const aliasMap = {};
function loadAliasFromTSConfig(projectRoot) {
    const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, "tsconfig.json") ||
        ts.findConfigFile(projectRoot, ts.sys.fileExists, "jsconfig.json");
    if (!configPath)
        return;
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
    if (config.options.paths) {
        for (const [aliasPattern, paths] of Object.entries(config.options.paths)) {
            const cleanPattern = aliasPattern.replace(/\*$/, "");
            const target = paths[0].replace(/\*$/, "");
            if (cleanPattern === "@prisma/generated/")
                continue;
            aliasMap[cleanPattern] = path.resolve(config.options.baseUrl || projectRoot, target);
        }
    }
}
function resolveWithAlias(importPath, baseDir) {
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
function resolveImportPath(importPath, baseDir) {
    const fullPath = path.resolve(baseDir, importPath);
    const extensions = [".ts", ".tsx", ".js", ".jsx"];
    for (const ext of extensions) {
        const tryPath = fullPath + ext;
        if (fs.existsSync(tryPath))
            return tryPath;
    }
    for (const ext of extensions) {
        const tryPath = path.join(fullPath, "index" + ext);
        if (fs.existsSync(tryPath))
            return tryPath;
    }
    return null;
}
function extractTCalls(code, filename, foundKeys, namespaces, importedFiles) {
    const ast = parser.parse(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
    });
    const dirname = path.dirname(filename);
    transverseDefault(ast, {
        ImportDeclaration(path) {
            const importPath = path.node.source.value;
            if (!importPath.startsWith(".") && !importPath.startsWith("@"))
                return;
            const resolved = resolveWithAlias(importPath, dirname);
            if (resolved)
                importedFiles.push(resolved);
        },
        CallExpression(path) {
            const callee = path.get("callee");
            // next/dynamic call
            if (callee.isIdentifier() &&
                callee.node.name === "dynamic" &&
                path.node.arguments.length) {
                const arg = path.node.arguments[0];
                if (arg.type === "ArrowFunctionExpression" &&
                    arg.body.type === "CallExpression" &&
                    arg.body.callee.type === "Import") {
                    const importArg = arg.body.arguments[0];
                    if (importArg.type === "StringLiteral") {
                        const importPath = importArg.value;
                        const resolved = resolveWithAlias(importPath, dirname);
                        if (resolved)
                            importedFiles.push(resolved);
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
                }
                else {
                    const location = path.node.loc;
                    const fileInfo = location
                        ? ` (${filename}:${location.start.line})`
                        : ` (${filename})`;
                    let namespaceGuess = tryExtractNamespaceFromDynamic(firstArg);
                    if (!namespaceGuess.length) {
                        const codeSnippet = code.slice(firstArg.start, firstArg.end);
                        console.log(`⚠️  Chave dinâmica Impossível encontrada em${fileInfo}`);
                        console.log(`   → Expressão: ${codeSnippet}`);
                        foundKeys.add("[IMPOSSIBLE_DYNAMIC_KEY]");
                    }
                    else {
                        for (const ns of namespaceGuess) {
                            namespaces.add(ns);
                        }
                        foundKeys.add("[DYNAMIC_KEY]");
                    }
                }
            }
        },
    });
}
function scanFileRecursive(entry, visited, foundKeys, namespaces) {
    const resolved = path.resolve(entry);
    if (visited.has(resolved))
        return;
    visited.add(resolved);
    const code = fs.readFileSync(resolved, "utf-8");
    const importedFiles = [];
    extractTCalls(code, resolved, foundKeys, namespaces, importedFiles);
    for (const imp of importedFiles) {
        scanFileRecursive(imp, visited, foundKeys, namespaces);
    }
}
export async function scan(entryFile) {
    const foundKeys = new Set();
    const namespaces = new Set();
    scanFileRecursive(entryFile, new Set(), foundKeys, namespaces);
    return {
        keys: Array.from(foundKeys),
        namespaces: Array.from(namespaces),
    };
}
function findPages(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...findPages(fullPath));
        }
        else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
            files.push(fullPath);
        }
    }
    return files;
}
export async function scanAllPagesInDir(dir, tsConfig) {
    tsConfig && loadAliasFromTSConfig(tsConfig);
    const pageFiles = findPages(dir);
    const perPage = {};
    const allKeys = new Set();
    const allNamespaces = new Set();
    for (const file of pageFiles) {
        const result = await scan(file);
        if (result.namespaces.length === 0 &&
            result.keys.includes("[DYNAMIC_KEY]")) {
            console.log(`⚠️ Chave dinâmica sem nenhum namespace detectado em ${file}. Pulando.`);
            continue;
        }
        if (result.keys.includes("[IMPOSSIBLE_DYNAMIC_KEY]")) {
            console.log(`⚠️ Chave dinâmica impossível detectada em ${file}. Pulando.`);
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
export function isTranslationCall(path) {
    const callee = path.get("callee");
    const args = path.node.arguments;
    if (!args.length)
        return false;
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
function tryExtractNamespaceFromDynamic(node) {
    if (!node)
        return [];
    // Case 1: Template literal - `namespace.${key}`
    if (isTemplateLiteral(node)) {
        const first = node.quasis[0]?.value.raw;
        if (first) {
            const namespace = first.split(".")[0];
            if (namespace)
                return [namespace];
        }
    }
    // Case 2: Binary expression - "namespace." + key
    if (isBinaryExpression(node) && isStringLiteral(node.left)) {
        const match = node.left.value.split(".");
        if (match)
            return [match[0]];
    }
    // Case 3: Ternary operator - condition ? "ns1.key" : "ns2.key"
    if (isConditionalExpression(node)) {
        const options = [node.consequent, node.alternate];
        return (options
            //@ts-ignore
            .filter(isStringLiteral)
            .map((lit) => lit.value.split(".")[0]));
    }
    return [];
}
