export function toolError(msg: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: msg }],
  };
}

export function toolSuccess(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

export function toolJson(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export const WORKER_TIMEOUT_MS = 15 * 60 * 1000;

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
