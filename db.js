
// db.js (CJS)
const mysql = require('mysql2/promise');

// Support both Railway naming styles
const host = process.env.MYSQLHOST || process.env.MYSQL_HOST;
const port = Number(process.env.MYSQLPORT || process.env.MYSQL_PORT || 3306);
const user = process.env.MYSQLUSER || process.env.MYSQL_USER;
const password = process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD;
const database = process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE;

console.log('DB config -> host=%s port=%s user=%s db=%s', host, port, user, database);

const pool = mysql.createPool({
  host,
  port,
  user,
  password,
  database,
  ssl: process.env.MYSQL_SSL === '1' ? { rejectUnauthorized: false } : undefined,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

async function pingDB() {
  const [rows] = await pool.query('SELECT 1 AS ok');
  return rows?.[0]?.ok === 1;
}

module.exports = { pool, pingDB };
