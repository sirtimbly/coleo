import { input, password, select, checkbox, confirm } from "@inquirer/prompts";

interface Choice<T extends string> {
  value: T;
  name: string;
  description?: string;
  checked?: boolean;
  disabled?: boolean | string;
}
async function promptResult<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof Error && ["ExitPromptError", "AbortPromptError", "CancelPromptError"].includes(error.name)) {
      throw new DOMException("Cancelled", "AbortError");
    }
    throw error;
  }
}
function context(signal?: AbortSignal) {
  return { input: process.stdin, output: process.stderr, signal };
}
export async function ask(label: string, fallback = "", hidden = false, signal?: AbortSignal): Promise<string> {
  const answer = await promptResult(() => hidden
    ? password({ message: label, mask: true }, context(signal))
    : input({ message: label, default: fallback || undefined }, context(signal)));
  return answer.trim() || fallback;
}
export async function choose<T extends string>(message: string, choices: Choice<T>[], fallback: T, signal?: AbortSignal): Promise<T> {
  return promptResult(() => select({ message, choices, default: fallback }, context(signal)));
}
export async function chooseMany<T extends string>(message: string, choices: Choice<T>[], signal?: AbortSignal): Promise<T[]> {
  return promptResult(() => checkbox({ message, choices, required: false, pageSize: choices.length,
    theme: { icon: { checked: "[x]", unchecked: "[ ]", disabledChecked: "[x]", disabledUnchecked: "[ ]" } },
  }, context(signal)));
}
export async function confirmAction(message: string, defaultValue = false, signal?: AbortSignal): Promise<boolean> {
  return promptResult(() => confirm({ message, default: defaultValue }, context(signal)));
}
