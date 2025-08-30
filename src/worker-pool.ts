import { Worker } from "worker_threads";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface WorkerTask {
  filePath: string;
  taskId: string;
}

export interface WorkerResult {
  taskId: string;
  filePath: string;
  result: {
    keys: string[];
    namespaces: string[];
  } | null;
  error?: string;
}

export class WorkerPool {
  private workers: Worker[] = [];
  private taskQueue: WorkerTask[] = [];
  private results: Map<string, WorkerResult> = new Map();
  private activeWorkers = 0;
  private resolvePromise?: (value: Map<string, WorkerResult>) => void;
  private rejectPromise?: (error: Error) => void;

  constructor(private maxWorkers = os.availableParallelism()) {}

  private createWorker(): Worker {
    const workerPath = path.join(__dirname, "scanner-worker.js");
    const worker = new Worker(workerPath);

    worker.on("message", (result: WorkerResult) => {
      this.results.set(result.taskId, result);
      this.activeWorkers--;
      this.processNextTask();
    });

    worker.on("error", (error) => {
      console.error("Worker error:", error);
      this.activeWorkers--;
      this.processNextTask();
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        console.error(`Worker stopped with exit code ${code}`);
      }
      this.activeWorkers--;
      this.processNextTask();
    });

    return worker;
  }

  private processNextTask(): void {
    if (this.taskQueue.length === 0) {
      // Check if all tasks are complete
      if (this.activeWorkers === 0 && this.resolvePromise) {
        this.resolvePromise(this.results);
      }
      return;
    }

    if (this.activeWorkers >= this.maxWorkers) {
      return;
    }

    const task = this.taskQueue.shift()!;
    let worker = this.workers.pop();

    if (!worker) {
      worker = this.createWorker();
    }

    this.activeWorkers++;
    worker.postMessage(task);

    // Keep worker for reuse
    this.workers.push(worker);
  }

  async processTasks(tasks: WorkerTask[]): Promise<Map<string, WorkerResult>> {
    return new Promise((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
      this.taskQueue = [...tasks];
      this.results.clear();

      // Start processing
      for (let i = 0; i < Math.min(this.maxWorkers, tasks.length); i++) {
        this.processNextTask();
      }

      // Handle empty task list
      if (tasks.length === 0) {
        resolve(this.results);
      }
    });
  }

  async terminate(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }
}
