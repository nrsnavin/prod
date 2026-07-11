// migrate-mongo configuration.
//
// Usage:
//   npx migrate-mongo status          # what has / hasn't run
//   npx migrate-mongo up              # apply pending migrations
//   npx migrate-mongo create <name>   # scaffold a new migration
//
// Reads the same MONGO_URL the app uses (config/.env), so migrations
// always run against the environment they're started from. Applied
// migrations are recorded in the `changelog` collection — never edit a
// migration after it has run anywhere; write a new one.

require("dotenv").config({ path: "config/.env" });

const url = process.env.MONGO_URL;
if (!url) {
  throw new Error("MONGO_URL is not set — configure config/.env before running migrations.");
}

module.exports = {
  mongodb: {
    url,
    options: {},
  },
  migrationsDir: "migrations",
  changelogCollectionName: "changelog",
  migrationFileExtension: ".js",
  useFileHash: false,
  moduleSystem: "commonjs",
};
