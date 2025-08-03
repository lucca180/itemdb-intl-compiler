#!/usr/bin/env node
import { Command } from "commander";
import path from "path";
import fs from "fs";
import { scanAllPagesInDir } from "../src/scanner";
const program = new Command();
program
    .name("intl-scan")
    .description("Escaneia um diretório de páginas Next.js e extrai chaves next-intl")
    .argument("<dir>", "Diretório com principal")
    .option("-t, --tsconfig <tsconfig>", "Caminho para o root do tsconfig")
    .option("-o, --output <dir>", "Diretório de saída para JSONs", "intl-pages")
    .action(async (dir, options) => {
    const time = Date.now();
    const absoluteDir = path.resolve(dir);
    const outputDir = path.resolve(options.output);
    if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
    }
    fs.mkdirSync(outputDir, { recursive: true });
    const tsconfigPath = options.tsconfig
        ? path.resolve(options.tsconfig)
        : undefined;
    const result = await scanAllPagesInDir(absoluteDir, tsconfigPath);
    fs.writeFileSync(path.join(outputDir, "all-keys.json"), JSON.stringify({ keys: result.allKeys, namespaces: result.allNamespaces }, null, 2), "utf-8");
    for (const [pagePath, data] of Object.entries(result.perPage)) {
        const relativePath = path.relative(absoluteDir, pagePath);
        const outputPath = path.join(outputDir, relativePath.replace(/\.(tsx?|jsx?)$/, ".json"));
        const outputDirname = path.dirname(outputPath);
        fs.mkdirSync(outputDirname, { recursive: true });
        fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), "utf-8");
    }
    const duration = Date.now() - time;
    console.log(`✅ Escaneamento completo em ${duration}ms. Resultado salvo em: ${outputDir}`);
});
program.parse();
