import { clearScreenDown, cursorTo } from "node:readline";

export interface ArmStatusRow {
  name: string;
  status: string;
  task: string;
  health: string;
}

export class TerminalDashboard {
  private enabled: boolean;
  private arms: ArmStatusRow[] = [];
  private logLines: string[] = [];
  private maxLogLines = 500;

  constructor(options?: { enabled?: boolean }) {
    this.enabled = options?.enabled ?? Boolean(process.stdout.isTTY);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setArms(rows: ArmStatusRow[]): void {
    this.arms = rows;
  }

  addLogLine(line: string): void {
    this.logLines.push(line);
    if (this.logLines.length > this.maxLogLines) {
      this.logLines.splice(0, this.logLines.length - this.maxLogLines);
    }
  }

  render(): void {
    if (!this.enabled || !process.stdout.isTTY) return;

    const output = this.buildOutput();
    cursorTo(process.stdout, 0, 0);
    clearScreenDown(process.stdout);
    process.stdout.write(output);
  }

  private buildOutput(): string {
    const columns = process.stdout.columns ?? 120;
    const rows = process.stdout.rows ?? 40;

    const header = this.buildHeader(columns);
    const armSection = this.buildArmSection(columns, rows);

    const usedLines = header.lines.length + armSection.lines.length;
    const remaining = Math.max(rows - usedLines - 1, 5);
    const logLines = this.logLines.slice(-remaining);

    return [...header.lines, ...armSection.lines, "", ...logLines].join("\n");
  }

  private buildHeader(columns: number): { lines: string[] } {
    const title = "Coleo Brain";
    const time = new Date().toLocaleTimeString();
    const line = this.padLine(`${title}  ${time}`, columns);
    return { lines: [line] };
  }

  private buildArmSection(columns: number, rows: number): { lines: string[] } {
    const nameWidth = Math.min(16, Math.max(10, Math.floor(columns * 0.18)));
    const statusWidth = Math.min(12, Math.max(8, Math.floor(columns * 0.12)));
    const healthWidth = Math.min(26, Math.max(16, Math.floor(columns * 0.22)));
    const taskWidth = Math.max(columns - nameWidth - statusWidth - healthWidth - 5, 20);

    const header = this.formatRow({
      name: "ARM",
      status: "STATUS",
      task: "TASK",
      health: "HEALTH",
    }, nameWidth, statusWidth, taskWidth, healthWidth, columns);

    const maxArmLines = Math.max(rows - 6, 1);
    const armLines: string[] = [];
    const visibleArms = this.arms.slice(0, maxArmLines);

    for (const arm of visibleArms) {
      armLines.push(this.formatRow(arm, nameWidth, statusWidth, taskWidth, healthWidth, columns));
    }

    if (this.arms.length > visibleArms.length) {
      armLines.push(this.padLine(`... (${this.arms.length - visibleArms.length} more arms)`, columns));
    }

    const divider = this.padLine("-".repeat(columns), columns);

    return { lines: [header, ...armLines, divider] };
  }

  private formatRow(
    row: ArmStatusRow,
    nameWidth: number,
    statusWidth: number,
    taskWidth: number,
    healthWidth: number,
    columns: number
  ): string {
    const name = this.truncate(row.name, nameWidth);
    const status = this.truncate(row.status, statusWidth);
    const task = this.truncate(row.task, taskWidth);
    const health = this.truncate(row.health, healthWidth);

    const line = `${name.padEnd(nameWidth)}  ${status.padEnd(statusWidth)}  ${task.padEnd(taskWidth)}  ${health.padEnd(healthWidth)}`;
    return this.padLine(line, columns);
  }

  private truncate(value: string, max: number): string {
    if (value.length <= max) return value;
    if (max <= 1) return value.slice(0, max);
    return value.slice(0, max - 1) + "…";
  }

  private padLine(value: string, columns: number): string {
    if (value.length >= columns) return value.slice(0, columns);
    return value + " ".repeat(columns - value.length);
  }
}
