import { Worker } from "worker_threads";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export class WorkerPool {
    constructor(maxWorkers = os.cpus().length) {
        this.maxWorkers = maxWorkers;
        this.workers = [];
        this.taskQueue = [];
        this.results = new Map();
        this.activeWorkers = 0;
    }
    createWorker() {
        const workerPath = path.join(__dirname, "scanner-worker.js");
        const worker = new Worker(workerPath);
        worker.on("message", (result) => {
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
    processNextTask() {
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
        const task = this.taskQueue.shift();
        let worker = this.workers.pop();
        if (!worker) {
            worker = this.createWorker();
        }
        this.activeWorkers++;
        worker.postMessage(task);
        // Keep worker for reuse
        this.workers.push(worker);
    }
    async processTasks(tasks) {
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
    async terminate() {
        await Promise.all(this.workers.map((worker) => worker.terminate()));
    }
}
