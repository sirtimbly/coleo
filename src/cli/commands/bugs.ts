import { Command } from "commander";
import { join } from "node:path";
import { getColeoDir, expandPath } from "../context";
import {
  type CsvListFilter,
  editListCsvInEditor,
  exportListCsvToPath,
  importListCsvFromPath,
  printImportResult,
} from "../list-csv";

function parseCsvFilter(value: string | undefined): CsvListFilter {
  if (!value) {
    return "all";
  }
  if (value === "all" || value === "pending" || value === "not-completed") {
    return value;
  }
  throw new Error(`Invalid filter '${value}'. Use: all, pending, not-completed`);
}

export function registerBugsCommands(program: Command): void {
  const bugsCmd = program.command("bugs").description("Manage bugs");

  bugsCmd
    .command("csv-export")
    .description("Export the current bug list to CSV")
    .option("-f, --filter <filter>", "Filter rows: all, pending, not-completed", "all")
    .argument("<path>", "Output CSV path")
    .action(async (pathArg, options) => {
      const dbPath = join(getColeoDir(), "coleo.db");
      const outputPath = expandPath(pathArg);

      try {
        const filter = parseCsvFilter(options.filter);
        await exportListCsvToPath(dbPath, "bugs", outputPath, filter);
        console.log(`Exported bugs CSV to ${outputPath}`);
      } catch (err) {
        console.error(`Failed to export bugs CSV: ${err}`);
        process.exit(1);
      }
    });

  bugsCmd
    .command("csv-import")
    .description("Import bug name, order, and status updates from CSV")
    .argument("<path>", "Input CSV path")
    .action(async (pathArg) => {
      const dbPath = join(getColeoDir(), "coleo.db");
      const inputPath = expandPath(pathArg);

      try {
        const result = await importListCsvFromPath(dbPath, "bugs", inputPath);
        printImportResult("bugs", result);
        if (result.invalid.length > 0) {
          process.exit(1);
        }
      } catch (err) {
        console.error(`Failed to import bugs CSV: ${err}`);
        process.exit(1);
      }
    });

  bugsCmd
    .command("csv-edit")
    .description("Open the current bug list in $EDITOR as CSV and import on save")
    .option("-f, --filter <filter>", "Filter rows: all, pending, not-completed", "all")
    .action(async (options) => {
      const dbPath = join(getColeoDir(), "coleo.db");

      try {
        const filter = parseCsvFilter(options.filter);
        const result = await editListCsvInEditor(dbPath, "bugs", filter);
        printImportResult("bugs", result);
        if (result.invalid.length > 0) {
          process.exit(1);
        }
      } catch (err) {
        console.error(`Failed to edit bugs CSV: ${err}`);
        process.exit(1);
      }
    });
}
