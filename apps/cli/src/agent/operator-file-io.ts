/** Retry only transient nonblocking I/O, retaining the caller's descriptor and offset. */
export async function retryNonblockingFileIo<T>(
  operation: () => T,
  deadline = performance.now() + 450,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (
        !["EAGAIN", "EWOULDBLOCK"].includes((error as NodeJS.ErrnoException).code ?? "") ||
        attempt >= 6 ||
        performance.now() >= deadline
      )
        throw error;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(8 * 2 ** attempt, 64, Math.max(0, deadline - performance.now())),
        ),
      );
    }
  }
}
