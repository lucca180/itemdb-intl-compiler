import { parentPort, workerData } from 'worker_threads';
import { scan } from './scanner.js';

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

async function processFile(task: WorkerTask): Promise<WorkerResult> {
  try {
    const result = await scan(task.filePath);
    
    // Skip files with problematic patterns
    if (
      result.namespaces.length === 0 &&
      result.keys.includes("[DYNAMIC_KEY]")
    ) {
      return {
        taskId: task.taskId,
        filePath: task.filePath,
        result: null,
        error: 'Dynamic key without namespace detected'
      };
    }

    if (result.keys.includes("[IMPOSSIBLE_DYNAMIC_KEY]")) {
      return {
        taskId: task.taskId,
        filePath: task.filePath,
        result: null,
        error: 'Impossible dynamic key detected'
      };
    }

    if (result.keys.length === 0 && result.namespaces.length === 0) {
      return {
        taskId: task.taskId,
        filePath: task.filePath,
        result: null,
        error: 'No keys found'
      };
    }

    return {
      taskId: task.taskId,
      filePath: task.filePath,
      result
    };
  } catch (error) {
    return {
      taskId: task.taskId,
      filePath: task.filePath,
      result: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// Listen for messages from main thread
if (parentPort) {
  parentPort.on('message', async (task: WorkerTask) => {
    const result = await processFile(task);
    parentPort!.postMessage(result);
  });
}
