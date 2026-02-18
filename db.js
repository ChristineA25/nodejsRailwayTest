
// db.js (ESM)
import mysql from 'mysql2/promise';

// Support both Railway naming styles
const host = process.env.MYSQLHOST || process.env.MYSQL_HOST;
const port = Number(process.env.MYSQLPORT || process.env.MYSQL_PORT || 3306);
const user = process.env.MYSQLUSER || process.env.MYSQL_USER;
const password = process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD;
const database = process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE;

// Helpful startup log (no secrets)
console.log('DB config -> host=%s port=%s user=%s db=%s', host, port, user, database);

// ✅ Create a pool with the *database* selected — avoids ER_NO_DB_ERROR (1046)
export const pool = mysql.createPool({
  host,
  port,
  user,
  password,
  database,
  // If your instance requires SSL, set MYSQL_SSL=1 in Variables.
  ssl: process.env.MYSQL_SSL === '1' ? { rejectUnauthorized: false } : undefined,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

export async function pingDB() {
  const [rows] = await pool.query('SELECT 1 AS ok');
  return rows?.[0]?.ok === 1;
}
