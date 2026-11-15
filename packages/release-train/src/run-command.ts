// The run of a command from its bin file. The exit code comes from the result of the command. A process that ends
// before the command ends exits with code 1.
import { errorMessage } from "@mark1russell7/text";

/** This text goes to standard error when the process ends before the command ends. */
export const UNSETTLED =
  "The process ended before the command ended. Nothing kept Node alive during a wait of the command, so its work is not done. This is a fault, not a pass.";

/** This type is the part of a stream that the run writes to. */
export interface TextSink {
  write(text: string): unknown;
}

/**
 * This function runs a command and sets the exit code of the process from the result.
 *
 * - A result of the command is the exit code.
 * - A thrown value writes its text to standard error, and the exit code is 1.
 * - Node ends a process when no handle keeps it alive. A wait on a timer with `unref` is such a wait.
 *   Then the promise of the command does not settle, and Node exits with code 0. A caller reads that as a pass.
 *   In that case, this function writes {@link UNSETTLED} to standard error and sets the exit code 1.
 *
 * @param command - The command. Its promise gives the exit code.
 * @param stderr - The stream for the error text. The default is `process.stderr`.
 */
export function runCommand(command: () => Promise<number>, stderr: TextSink = process.stderr): void {
  let settled = false;
  process.once("beforeExit", () => {
    if (settled) return;
    stderr.write(`${UNSETTLED}\n`);
    process.exitCode = 1;
  });
  void Promise.resolve()
    .then(command)
    .then(
      (code) => {
        settled = true;
        process.exitCode = code;
      },
      (error: unknown) => {
        settled = true;
        stderr.write(`${errorMessage(error)}\n`);
        process.exitCode = 1;
      },
    );
}
