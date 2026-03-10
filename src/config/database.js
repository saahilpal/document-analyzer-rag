const { openDatabase, runMigrations } = require('../database/migrations');

runMigrations({ dryRun: false });

const db = openDatabase();

module.exports = db;
