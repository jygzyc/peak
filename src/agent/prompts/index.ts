import { EVALUATOR_SYSTEM_PROMPT } from "./evaluator.js";
import { EXPLORER_SYSTEM_PROMPT } from "./explorer.js";
import { METACOG_SYSTEM_PROMPT } from "./metacog.js";
import { PLANNER_SYSTEM_PROMPT } from "./planner.js";

export const BUILTIN_PROMPT_PREFIX = "builtin:";

export const BUILTIN_SYSTEM_PROMPTS = {
  planner: PLANNER_SYSTEM_PROMPT,
  explorer: EXPLORER_SYSTEM_PROMPT,
  evaluator: EVALUATOR_SYSTEM_PROMPT,
  metacog: METACOG_SYSTEM_PROMPT,
} as const;

export type BuiltinPromptId = keyof typeof BUILTIN_SYSTEM_PROMPTS;

export function builtinPromptSource(id: BuiltinPromptId): string {
  return `${BUILTIN_PROMPT_PREFIX}${id}`;
}

export function isBuiltinPromptSource(source: string): boolean {
  return source.startsWith(BUILTIN_PROMPT_PREFIX);
}

export function resolveBuiltinPrompt(source: string): string | undefined {
  if (!isBuiltinPromptSource(source)) return undefined;
  const id = source.slice(BUILTIN_PROMPT_PREFIX.length) as BuiltinPromptId;
  return BUILTIN_SYSTEM_PROMPTS[id];
}
