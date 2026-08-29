import { Database } from "bun:sqlite";

const databasePath = process.argv[2];
if (!databasePath) throw new Error("database path is required");

const database = new Database(databasePath);
database.run("PRAGMA busy_timeout = 1000");
database.exec("BEGIN IMMEDIATE");
process.stdout.write("LOCKED\n");
process.stdin.once("data", () => {
  database.exec("ROLLBACK");
  database.close();
  process.exitCode = 0;
});
