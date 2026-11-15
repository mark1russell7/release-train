import { main } from "./cli.ts";
import { runCommand } from "./run-command.ts";

runCommand(() => main(process.argv.slice(2)));
