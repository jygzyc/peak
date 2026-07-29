import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface InitializedTaskPaths {
  taskDir: string;
  configPath: string;
}

export function initializeTaskDirectory(directory = "."): InitializedTaskPaths {
  const taskDir = resolve(directory);
  const configPath = join(taskDir, "task.json");
  if (existsSync(configPath)) throw new Error(`task already exists: ${configPath}`);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({
    board: {
      name: "peak-board",
      workspace: ".",
      projects: [
        {
          id: "",
          name: "Main",
          goal: "Describe what this Project must prove",
        },
      ],
    },
    workers: [
      {
        type: "pi",
        taskTypes: ["plan", "supervise", "execute"],
        maxRunning: 2,
        priority: 1,
        args: [],
      },
    ],
  }, null, 2)}\n`);
  return Object.freeze({ taskDir, configPath });
}
