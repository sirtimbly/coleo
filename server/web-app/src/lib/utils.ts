import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function createRandomId(prefix: string): string {
  const values = crypto.getRandomValues(new Uint32Array(4));
  const randomPart = Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("");
  return `${prefix}-${randomPart}`;
}

export function truncateMiddle(value: string, maxLength = 32): string {
  if (value.length <= maxLength) return value
  const keep = maxLength - 1
  const head = Math.ceil(keep / 2)
  const tail = Math.floor(keep / 2)
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`
}

export function truncateStart(value: string, maxLength = 32): string {
  if (value.length <= maxLength) return value
  return `…${value.slice(value.length - (maxLength - 1))}`
}
