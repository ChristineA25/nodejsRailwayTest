
import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';

const app = express();
app.use(cors());
app.use(express.json());

// A simple page so your browser shows something at the root URL
app.get('/', (req, res) => {
  res.send('API is running');
});

// Connect to Railway MySQL using environment variables
const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: Number(process.env.MYSQLPORT || 3306),
  ssl: { rejectUnauthorized: false } // often needed on Railway
});

// Optional: quick health check that touches the database
app.get('/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 AS ok');
    res.json({ ok: rows[0].ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Insert data into "testing" table
app.post('/add', async (req, res) => {
  const { testing } = req.body;
  if (!testing) {
    return res.status(400).json({ error: 'Field "testing" is required.' });
  }

  try {
    const [result] = await pool.query(
      'INSERT INTO testing (testing) VALUES (?)',
      [testing]
    );
    res.status(201).json({ id: result.insertId, testing });
  } catch (err) {
    console.error('Insert error:', err);
    res.status(500).json({ error: 'Database insert failed.' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
