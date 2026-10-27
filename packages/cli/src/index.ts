#!/usr/bin/env node
import { Command } from "commander";
import { registerCommands } from "./commands.js";

const program = new Command();
program
  .name("demo-engine")
  .description("Demos as code. Record a product walkthrough once; re-run, diff, heal and re-render it on every release.")
  .version("0.1.0")
  .option("-c, --config <file>", "config file (default: demo-engine.config.yaml if present)")
  .option("-o, --out <dir>", "output directory (default: .demo-engine)")
  .option("-b, --base-url <url>", "base URL substituted into flow urls")
  .option("-v, --verbose", "verbose logging");

registerCommands(program);
program.parseAsync(process.argv).catch((e: Error) => {
  console.error(`error: ${e.message}`);
  process.exit(2);
});
