import Database from "better-sqlite3";

/** The items database, opened from DB_PATH (a file next to the server by default). */
export function openDb(): Database.Database {
  const db = new Database(process.env.DB_PATH ?? "items.db");
  db.exec("create table if not exists items (id text primary key, title text not null)");
  return db;
}
