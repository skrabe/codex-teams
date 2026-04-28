import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Task, TaskStatus } from "./types.js";

const LOCK_WAIT_BUFFER = new SharedArrayBuffer(4);
const LOCK_WAIT_ARRAY = new Int32Array(LOCK_WAIT_BUFFER);

export const DEFAULT_TASK_STORE_ROOT = path.join(os.homedir(), ".codex-teams", "tasks");

export function getTaskStoreRoot(): string {
  return process.env.CODEX_TEAMS_TASK_DIR ?? DEFAULT_TASK_STORE_ROOT;
}

interface StoredTask {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  owner: string | null;
  result?: string;
  dependencies: string[];
  blockedBy: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CreateTaskInput {
  subject?: string;
  description: string;
  activeForm?: string;
  owner?: string | null;
  dependencies?: string[];
}

export interface UpdateTaskInput {
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: TaskStatus;
  owner?: string | null;
  result?: string | undefined;
}

export interface ClaimTaskOptions {
  checkAgentBusy?: boolean;
}

function sleepMs(ms: number): void {
  Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, ms);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function toTask(stored: StoredTask): Task {
  return {
    id: stored.id,
    subject: stored.subject,
    description: stored.description,
    activeForm: stored.activeForm,
    status: stored.status,
    owner: stored.owner,
    result: stored.result,
    dependencies: [...stored.dependencies],
    blockedBy: [...stored.blockedBy],
    createdAt: new Date(stored.createdAt),
    updatedAt: new Date(stored.updatedAt),
    completedAt: stored.completedAt ? new Date(stored.completedAt) : undefined,
  };
}

function toStoredTask(task: Task): StoredTask {
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    activeForm: task.activeForm,
    status: task.status,
    owner: task.owner,
    result: task.result,
    dependencies: [...task.dependencies],
    blockedBy: [...task.blockedBy],
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    completedAt: task.completedAt?.toISOString(),
  };
}

export class TaskStore {
  readonly rootDir: string;
  readonly taskListId: string;
  readonly taskListDir: string;
  readonly tasksDir: string;
  private readonly highWatermarkPath: string;
  private readonly lockDir: string;

  constructor(taskListId: string, rootDir = DEFAULT_TASK_STORE_ROOT) {
    this.rootDir = rootDir;
    this.taskListId = taskListId;
    this.taskListDir = path.join(rootDir, taskListId);
    this.tasksDir = path.join(this.taskListDir, "tasks");
    this.highWatermarkPath = path.join(this.taskListDir, ".highwatermark");
    this.lockDir = path.join(this.taskListDir, ".tasklist.lock");
  }

  getTaskListPath(): string {
    return this.taskListDir;
  }

  exists(): boolean {
    return fs.existsSync(this.taskListDir);
  }

  deleteTaskList(): void {
    fs.rmSync(this.taskListDir, { recursive: true, force: true });
    if (fs.existsSync(this.rootDir) && fs.readdirSync(this.rootDir).length === 0) {
      fs.rmSync(this.rootDir, { recursive: true, force: true });
    }
  }

  initTaskList(): string {
    fs.mkdirSync(this.tasksDir, { recursive: true });
    if (!fs.existsSync(this.highWatermarkPath)) {
      fs.writeFileSync(this.highWatermarkPath, "0\n");
    }
    return this.taskListDir;
  }

  createTask(input: CreateTaskInput): Task {
    return this.withListLock(() => {
      this.initTaskList();
      const tasks = this.readAllTasksUnlocked();
      const dependencies = [...(input.dependencies ?? [])];
      for (const dependencyId of dependencies) {
        if (!tasks.has(dependencyId)) {
          throw new Error(`Dependency task not found: ${dependencyId}`);
        }
      }

      const now = new Date();
      const task: Task = {
        id: String(this.nextTaskIdUnlocked()),
        subject: input.subject?.trim() || input.description,
        description: input.description,
        activeForm: input.activeForm,
        status: "pending",
        owner: input.owner ?? null,
        result: undefined,
        dependencies,
        blockedBy: [],
        createdAt: now,
        updatedAt: now,
        completedAt: undefined,
      };
      tasks.set(task.id, task);
      this.refreshBlockedBy(tasks);
      this.writeAllTasksUnlocked(tasks);
      return this.cloneTask(tasks.get(task.id)!);
    });
  }

  getTask(taskId: string): Task | undefined {
    if (!this.exists()) return undefined;
    const filePath = this.getTaskPath(taskId);
    if (!fs.existsSync(filePath)) return undefined;
    return toTask(JSON.parse(fs.readFileSync(filePath, "utf8")) as StoredTask);
  }

  listTasks(): Task[] {
    if (!this.exists()) return [];
    return this.readAllTasks();
  }

  updateTask(taskId: string, input: UpdateTaskInput): Task {
    return this.withListLock(() => {
      const tasks = this.readAllTasksUnlocked();
      const task = tasks.get(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      if (input.subject !== undefined) task.subject = input.subject;
      if (input.description !== undefined) task.description = input.description;
      if (input.activeForm !== undefined) task.activeForm = input.activeForm;
      if (input.owner !== undefined) task.owner = input.owner;
      if ("result" in input) task.result = input.result;

      if (input.status !== undefined) {
        task.status = input.status;
        if (input.status === "completed") {
          task.completedAt = new Date();
        } else {
          task.completedAt = undefined;
          if (input.status === "pending" && input.owner === undefined) {
            task.owner = null;
          }
        }
      }

      task.updatedAt = new Date();
      this.refreshBlockedBy(tasks);
      this.writeAllTasksUnlocked(tasks);
      return this.cloneTask(tasks.get(taskId)!);
    });
  }

  claimTask(taskId: string, owner: string, options: ClaimTaskOptions = {}): Task | null {
    return this.withListLock(() => {
      const tasks = this.readAllTasksUnlocked();
      const task = tasks.get(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      this.refreshBlockedBy(tasks);
      if (task.status !== "pending" || task.blockedBy.length > 0) {
        return null;
      }
      if (options.checkAgentBusy) {
        const isBusy = Array.from(tasks.values()).some(
          (candidate) => candidate.owner === owner && candidate.status === "in-progress",
        );
        if (isBusy) return null;
      }

      task.owner = owner;
      task.status = "in-progress";
      task.updatedAt = new Date();

      this.refreshBlockedBy(tasks);
      this.writeAllTasksUnlocked(tasks);
      return this.cloneTask(tasks.get(taskId)!);
    });
  }

  resetTask(taskId: string): Task {
    return this.withListLock(() => {
      const tasks = this.readAllTasksUnlocked();
      const task = tasks.get(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      task.status = "pending";
      task.owner = null;
      task.result = undefined;
      task.completedAt = undefined;
      task.updatedAt = new Date();

      this.refreshBlockedBy(tasks);
      this.writeAllTasksUnlocked(tasks);
      return this.cloneTask(tasks.get(taskId)!);
    });
  }

  unassignTasksForAgent(agentId: string): Task[] {
    return this.withListLock(() => {
      const tasks = this.readAllTasksUnlocked();
      const changed: Task[] = [];

      for (const task of tasks.values()) {
        if (task.owner !== agentId || task.status === "completed") continue;
        task.owner = null;
        task.status = "pending";
        task.result = undefined;
        task.completedAt = undefined;
        task.updatedAt = new Date();
        changed.push(this.cloneTask(task));
      }

      this.refreshBlockedBy(tasks);
      this.writeAllTasksUnlocked(tasks);
      return changed.map((task) => this.cloneTask(tasks.get(task.id)!));
    });
  }

  deleteTask(taskId: string): void {
    this.withListLock(() => {
      const tasks = this.readAllTasksUnlocked();
      if (!tasks.has(taskId)) throw new Error(`Task not found: ${taskId}`);

      for (const task of tasks.values()) {
        if (task.dependencies.includes(taskId)) {
          task.dependencies = task.dependencies.filter((id) => id !== taskId);
          task.updatedAt = new Date();
        }
      }

      tasks.delete(taskId);
      fs.rmSync(this.getTaskPath(taskId), { force: true });
      this.refreshBlockedBy(tasks);
      this.writeAllTasksUnlocked(tasks);
    });
  }

  private withListLock<T>(callback: () => T): T {
    this.initTaskList();
    const start = Date.now();

    for (;;) {
      try {
        fs.mkdirSync(this.lockDir);
        break;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        if (Date.now() - start > 5_000) {
          throw new Error(`Timed out acquiring task-list lock for ${this.taskListId}`);
        }
        sleepMs(10);
      }
    }

    try {
      return callback();
    } finally {
      fs.rmSync(this.lockDir, { recursive: true, force: true });
    }
  }

  private nextTaskIdUnlocked(): number {
    const current = Number(fs.readFileSync(this.highWatermarkPath, "utf8").trim() || "0");
    const next = current + 1;
    fs.writeFileSync(this.highWatermarkPath, `${next}\n`);
    return next;
  }

  private readAllTasks(): Task[] {
    this.initTaskList();
    return Array.from(this.readAllTasksUnlocked().values()).map((task) => this.cloneTask(task));
  }

  private readAllTasksUnlocked(): Map<string, Task> {
    this.initTaskList();
    const tasks = new Map<string, Task>();
    for (const fileName of this.listTaskFiles()) {
      const stored = JSON.parse(fs.readFileSync(path.join(this.tasksDir, fileName), "utf8")) as StoredTask;
      const task = toTask(stored);
      tasks.set(task.id, task);
    }
    this.refreshBlockedBy(tasks);
    return tasks;
  }

  private writeAllTasksUnlocked(tasks: Map<string, Task>): void {
    this.initTaskList();
    const existingFiles = new Set(this.listTaskFiles());
    for (const task of tasks.values()) {
      const fileName = `${task.id}.json`;
      existingFiles.delete(fileName);
      fs.writeFileSync(this.getTaskPath(task.id), JSON.stringify(toStoredTask(task), null, 2));
    }
    for (const fileName of existingFiles) {
      fs.rmSync(path.join(this.tasksDir, fileName), { force: true });
    }
  }

  private listTaskFiles(): string[] {
    if (!fs.existsSync(this.tasksDir)) return [];
    return fs
      .readdirSync(this.tasksDir)
      .filter((fileName) => fileName.endsWith(".json"))
      .sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));
  }

  private refreshBlockedBy(tasks: Map<string, Task>): void {
    for (const task of tasks.values()) {
      task.blockedBy = task.dependencies.filter((dependencyId) => {
        const dependency = tasks.get(dependencyId);
        return dependency?.status !== "completed";
      });
    }
  }

  private getTaskPath(taskId: string): string {
    return path.join(this.tasksDir, `${taskId}.json`);
  }

  private cloneTask(task: Task): Task {
    return {
      ...task,
      dependencies: [...task.dependencies],
      blockedBy: [...task.blockedBy],
      createdAt: new Date(task.createdAt),
      updatedAt: new Date(task.updatedAt),
      completedAt: task.completedAt ? new Date(task.completedAt) : undefined,
    };
  }
}
